/**
 * Shared MCP tool definitions.
 * Used by both the stdio server (server.ts) and the HTTP route (route.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { marginCentsFor } from "../lib/margin.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const API_REQUEST_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_API_TIMEOUT_MS || 12_000);
// Listing import fetches the source page server-side (10s cap) and may run an
// LLM extraction on top - it needs more than the default API budget.
const IMPORT_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_IMPORT_TIMEOUT_MS || 25_000);
// Evidence submission runs a vision soft-check server-side - same headroom.
const VERIFY_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_VERIFY_TIMEOUT_MS || 25_000);
const POLL_INTERVAL_MS = Number(process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS || 1_000);
const EMBED_IMAGES = process.env.FIRESTARTER_MCP_EMBED_IMAGES === "true";
const MAX_EMBED_IMAGES = Number(process.env.FIRESTARTER_MCP_MAX_EMBED_IMAGES || 2);
const IMAGE_FETCH_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_IMAGE_TIMEOUT_MS || 1_500);
const MAX_IMAGE_BYTES = Number(process.env.FIRESTARTER_MCP_MAX_IMAGE_BYTES || 2_000_000);
// Public share pages (GET /l/:id) — humans get a product card, agents get
// machine-readable purchase instructions, chat apps unfurl a preview card.
const SHARE_LINK_BASE = process.env.SHARE_LINK_BASE || "https://firestarter.network/l";

function toErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("timed out") || msg.includes("aborted")) {
    return "Firestarter API timed out. Please retry in a few seconds.";
  }
  return msg;
}

/** Strip backslashes LLMs sometimes inject when markdown-escaping underscores/hyphens in IDs. */
function cleanListingId(id: string): string {
  return id.replace(/\\/g, "");
}

/**
 * Non-2xx API responses carry structured bodies (code + extra data, e.g. the
 * possession-verification payload on 409s). Keep them on the thrown error so
 * tool catch blocks can render specifics instead of a flattened string.
 */
class ApiError extends Error {
  status: number;
  code: string | null;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.code = typeof body?.code === "string" ? body.code : null;
    this.body = body;
  }
}

function makeApiRequest(apiKey: string, apiBase: string) {
  return async function apiRequest(method: string, path: string, body?: unknown, timeoutMs: number = API_REQUEST_TIMEOUT_MS) {
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Firestarter-Source": "mcp",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || `API request failed: ${res.status}`, res.status, data);
    }
    return data;
  };
}

/**
 * Render the possession-verification ask (409 VERIFICATION_REQUIRED) as chat
 * instructions the agent can relay verbatim. Returns null for other errors.
 */
function verificationAskText(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "VERIFICATION_REQUIRED") return null;
  const v = err.body?.verification;
  if (!v?.code) return null;
  const why =
    v.reason === "source_conflict"
      ? "its source URL was already imported by another seller"
      : v.reason === "luxury_category"
        ? "it is a luxury-category item"
        : v.reason === "buyer_invite"
          ? "a buyer requested an escrow-protected purchase of this exact item, so possession must be proven before it goes live"
          : "it is a high-value item";
  return (
    `**Possession verification needed before this listing can go live** (${why}).\n\n` +
    `Verification code: **${v.code}**\n\n` +
    `Ask the seller to:\n` +
    `1. Write ${v.code} by hand on a piece of paper\n` +
    `2. Photograph the paper next to the item - both clearly visible in one shot\n` +
    `3. Send that photo here in chat\n\n` +
    `Then submit it with firestarter_verify (listing_id + the photo URL). A match auto-approves in seconds - no human review on the happy path.`
  );
}

async function pollExecution(apiRequest: ReturnType<typeof makeApiRequest>, executionId: string, timeoutMs: number = 60_000): Promise<any> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const exec = await apiRequest("GET", `/v1/executions/${executionId}`);
    const hasOptions = Array.isArray(exec.options) && exec.options.length > 0;
    if (hasOptions || ["awaiting_approval", "awaiting_payment_method", "quoted", "completed", "failed", "cancelled", "paid", "shipping", "delivered"].includes(exec.status)) {
      return exec;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return apiRequest("GET", `/v1/executions/${executionId}`);
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`[firestarter-mcp] image fetch failed: ${res.status} for ${url.slice(0, 60)}`);
      return null;
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 0 && len > MAX_IMAGE_BYTES) {
      console.error(`[firestarter-mcp] image too large (${len} bytes), skipping: ${url.slice(0, 60)}`);
      return null;
    }
    const ct = res.headers.get("content-type") || "image/jpeg";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      console.error(`[firestarter-mcp] image buffer too large (${buf.byteLength} bytes), skipping`);
      return null;
    }
    const mimeType = ct.split(";")[0];
    console.error(`[firestarter-mcp] image fetched: ${buf.byteLength} bytes, ${mimeType}`);
    return { data: Buffer.from(buf).toString("base64"), mimeType };
  } catch (err: any) {
    console.error(`[firestarter-mcp] image fetch error: ${err.message}`);
    return null;
  }
}

async function formatExecution(exec: any): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  const lines: string[] = [];

  lines.push(`**Execution ${exec.id}** — Status: ${exec.status}`);
  lines.push(`Request: ${exec.request_text}`);

  if (exec.current_step) {
    lines.push(`Current step: ${exec.current_step}`);
  }

  // Order approved but no payment method on file — relay the no-login setup
  // link so the buyer can finish (the order resumes automatically once a card
  // is added). Without this the link never reached chat buyers and orders
  // parked on awaiting_payment_method forever.
  if (exec.status === "awaiting_payment_method") {
    lines.push("");
    lines.push(
      exec.setup_url
        ? `**Action needed — add a payment method to finish this order:** ${exec.setup_url}\n(No login needed. The order completes automatically once a card is added.)`
        : "**Action needed:** this order is approved and waiting on a payment method. Ask the buyer to add a card from their dashboard billing settings; the order resumes automatically once added."
    );
  }

  if (exec.options && exec.options.length > 0) {
    lines.push("");
    lines.push("**Options found:**");
    // D3.5: if this org charges a developer margin, disclose it WITH the
    // prices the human is choosing among - so their approval is on the true
    // total, not a number that grows at payment.
    const dm = exec.developer_margin;
    if (dm && typeof dm.margin_bps === "number" && dm.margin_bps > 0) {
      const cap = typeof dm.per_transaction_cap_cents === "number" ? ` (capped at $${(dm.per_transaction_cap_cents / 100).toFixed(0)})` : "";
      lines.push(
        `> Heads-up: this app adds a ${(dm.margin_bps / 100).toFixed(2)}% integration margin${cap} on top of the prices below. It is applied at payment and included in the total you approve - state it to the buyer before they confirm.`
      );
    }
    blocks.push({ type: "text", text: lines.join("\n") });
    lines.length = 0;

    // Fetch all images in parallel
    const imageUrls = exec.options.map((opt: any) => opt.metadata?.image || opt.image || null);
    const imageSlots = EMBED_IMAGES ? Math.max(0, Math.min(MAX_EMBED_IMAGES, exec.options.length)) : 0;
    const images = await Promise.all(
      imageUrls.map((url: string | null, idx: number) => {
        if (!url || idx >= imageSlots) return Promise.resolve(null);
        return fetchImageAsBase64(url);
      })
    );

    for (let i = 0; i < exec.options.length; i++) {
      const opt = exec.options[i];
      const imageUrl = imageUrls[i];
      // #107: external marketplace results are browse-only — label them so no
      // agent walks a buyer into approving one (the API rejects it anyway).
      const browseOnly = opt.purchasable === false;
      const optLines: string[] = [];
      // Line-item breakdown: "$55.80" with no context reads as a price
      // discrepancy when the listing says $45.81 (debug 2026-06-12: agent
      // flagged item+shipping total as "the listed price" to a buyer).
      const bdParts: string[] = [];
      if (opt.subtotal != null) bdParts.push(`$${opt.subtotal} item${Number(opt.quantity) > 1 ? `s x${opt.quantity}` : ""}`);
      if (opt.shipping != null && Number(opt.shipping) > 0) bdParts.push(`$${opt.shipping} shipping`);
      if (opt.tax != null && Number(opt.tax) > 0) bdParts.push(`$${opt.tax} tax`);
      const breakdown = bdParts.length > 1 ? ` (${bdParts.join(" + ")})` : "";
      optLines.push(`\n**${i + 1}. ${opt.product_title}** — $${opt.total}${breakdown} from ${opt.supplier || opt.store || "Unknown"}${browseOnly ? " — ⚠ browse-only (external)" : ""}`);
      // D3.5: a purchasable option's TRUE total includes the app margin (added
      // at payment, double-capped). Show it so "approve option 1" is approval
      // of the real number.
      if (!browseOnly && dm && dm.margin_bps > 0 && opt.total != null) {
        const itemCents = Math.round(Number(opt.total) * 100);
        // Same pure function the charge path uses - shown == charged, always.
        const capCents = typeof dm.per_transaction_cap_cents === "number" ? dm.per_transaction_cap_cents : undefined;
        const marginCents = marginCentsFor(itemCents, dm.margin_bps, capCents);
        if (marginCents > 0) {
          optLines.push(`  Total with app margin: $${((itemCents + marginCents) / 100).toFixed(2)} (+$${(marginCents / 100).toFixed(2)})`);
        }
      }
      if (opt.product_url) optLines.push(`  URL: ${opt.product_url}`);
      if (browseOnly) optLines.push(`  External marketplace result — Firestarter cannot purchase it. Do not approve this option; share the URL so the buyer can purchase directly.`);
      if (imageUrl) optLines.push(`  ![${opt.product_title}](${imageUrl})`);
      if (opt.agent_reasoning) optLines.push(`  ${opt.agent_reasoning}`);
      blocks.push({ type: "text", text: optLines.join("\n") });

      if (images[i]) {
        blocks.push({ type: "image", data: images[i]!.data, mimeType: images[i]!.mimeType });
      }
    }
  } else {
    blocks.push({ type: "text", text: lines.join("\n") });
    lines.length = 0;
  }

  if (exec.steps && exec.steps.length > 0) {
    lines.push("");
    lines.push("**Steps:**");
    for (const step of exec.steps) {
      const icon = step.status === "completed" ? "✓" : step.status === "failed" ? "✗" : "⧖";
      lines.push(`${icon} ${step.step}: ${step.agent_reasoning || step.status}`);
      if (step.error?.message) {
        lines.push(`  Error: ${step.error.message}`);
      }
    }
  }

  if (lines.length > 0) {
    blocks.push({ type: "text", text: lines.join("\n") });
  }

  const imageCount = blocks.filter(b => b.type === "image").length;
  const textCount = blocks.filter(b => b.type === "text").length;
  console.error(`[firestarter-mcp] formatExecution returning ${blocks.length} blocks (${textCount} text, ${imageCount} images)`);

  return blocks;
}

// ─── Register all tools ─────────────────────────────────────────────────────

export function registerTools(server: McpServer, apiKey: string, apiBase: string) {
  const apiRequest = makeApiRequest(apiKey, apiBase);

  // Tool: firestarter_execute
  server.tool(
    "firestarter_execute",
    "Execute a commerce transaction. Find products matching a natural language request, verify suppliers, get pricing, and optionally handle payment and delivery. Returns product options for approval. When you have an exact Firestarter listing id (lst_..., e.g. from a firestarter.network/l/<id> share link), pass listing_id — the purchase pins to that exact listing instead of searching.",
    {
      request: z.string().describe("Natural language description of what to buy (e.g. 'specialty coffee beans under $30')"),
      listing_id: z.string().optional().describe("Exact Firestarter listing id (lst_...) to buy — from a listing or a share link (firestarter.network/l/<id>). Pins the purchase to that listing, skipping product search. Always pass it when you have one."),
      budget_max: z.number().optional().describe("Maximum budget in USD"),
      delivery_address: z.string().optional().describe("Delivery address as a string"),
      priority: z.enum(["cost", "speed", "quality"]).optional().describe("Optimization priority: cost (cheapest), speed (fastest delivery), quality (best rated)"),
      auto_pay: z.boolean().optional().describe("If true, automatically pay for the best option within budget. If false (default), present options for approval."),
      requested_by: z
        .object({
          name: z.string().optional().describe("Requester's display name, e.g. 'Durga'"),
          id: z.string().optional().describe("Requester's platform user id, e.g. a Slack U... id"),
          channel: z.string().optional().describe("Platform the request came from, e.g. 'slack', 'whatsapp'"),
        })
        .optional()
        .describe("Who asked for this purchase, when relaying someone else's request (e.g. a teammate in chat). Stored as execution metadata so the buyer's dashboard can attribute the order. Integrations set this programmatically; pass it whenever you know the requester."),
    },
    async ({ request, listing_id: rawListingId, budget_max, delivery_address, priority, auto_pay, requested_by }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        const body: any = {
          request,
          preferences: { priority: priority || "quality", require_approval: !auto_pay },
        };
        if (listing_id) body.listing_id = listing_id;
        // Attribution rides the existing free-form metadata column — the REST
        // API stores body.metadata verbatim and the list endpoint echoes it.
        if (requested_by && (requested_by.name || requested_by.id)) {
          body.metadata = { requested_by };
        }
        if (budget_max) body.budget = { max_total: budget_max, currency: "USD" };
        if (delivery_address) body.delivery_address = { address: delivery_address };

        const created = await apiRequest("POST", "/v1/executions", body);
        const exec = await pollExecution(apiRequest, created.id);
        const blocks = await formatExecution(exec);

        if (exec.status === "awaiting_approval") {
          const opts = Array.isArray(exec.options) ? exec.options : [];
          const purchasableCount = opts.filter((o: any) => o.purchasable !== false).length;
          blocks.push({
            type: "text",
            text: purchasableCount === 0 && opts.length > 0
              ? "\n\n**Note:** every result is an external marketplace listing — browse-only. Firestarter cannot purchase them: share the URLs so the buyer can purchase directly, use `firestarter_message` to refine the search toward Firestarter marketplace listings, or `firestarter_cancel`."
              : `\n\n**Action needed:** the user can reply "approve" to buy the best option, or use \`firestarter_approve\` (execution \`${exec.id}\`) for a specific option; \`firestarter_cancel\` to cancel.${purchasableCount < opts.length ? " Browse-only (external) options cannot be approved — share their URLs instead." : ""}`,
          });
        }
        return { content: blocks };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_status
  server.tool(
    "firestarter_status",
    "Check the status of a Firestarter execution or list recent executions. Use this to check on orders, see what options were found, or get tracking updates.",
    {
      execution_id: z.string().optional().describe("Specific execution ID to check (e.g. 'exec_abc123'). Omit to list recent executions."),
      status_filter: z.string().optional().describe("Filter executions by status: finding, awaiting_approval, approved, paid, shipping, completed, failed, cancelled"),
    },
    async ({ execution_id, status_filter }) => {
      try {
        if (execution_id) {
          const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
          return { content: await formatExecution(exec) };
        }
        let path = "/v1/executions";
        if (status_filter) path += `?status=${encodeURIComponent(status_filter)}`;
        const data = await apiRequest("GET", path);
        const executions = data.executions || data;
        if (!Array.isArray(executions) || executions.length === 0) {
          return { content: [{ type: "text" as const, text: "No executions found." }] };
        }
        const lines = [`**Recent Executions** (${data.total || executions.length} total)\n`];
        for (const e of executions.slice(0, 10)) {
          lines.push(`- **${e.id}** [${e.status}] ${e.request_text?.slice(0, 60) || ""}${e.request_text?.length > 60 ? "..." : ""}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_approve
  server.tool(
    "firestarter_approve",
    "Approve an execution that is awaiting approval. By default this approves the pre-selected (best purchasable) option and proceeds with payment; pass selected_option or option_id to approve a different option. Only Firestarter-purchasable options can be approved — external browse-only results are rejected with their direct purchase link instead. When the user just says \"approve\" without naming an order, omit execution_id: the tool resolves the pending purchase automatically (and asks which one only if several are pending).",
    {
      execution_id: z.string().optional().describe("The execution ID to approve (e.g. 'exec_abc123'). Omit when the user simply replied \"approve\": the tool then approves the one execution awaiting approval, surfaces payment-setup guidance if the order is parked awaiting a payment method, or lists the candidates if several are pending."),
      selected_option: z.number().int().min(0).optional().describe("0-based index into the options list as displayed (the option shown as '1.' is index 0). Omit to approve the pre-selected best option."),
      option_id: z.string().optional().describe("Exact option id (e.g. 'opt_abc123') to approve, as returned in API errors or the execution resource. Takes precedence over selected_option."),
    },
    async ({ execution_id, selected_option, option_id }) => {
      try {
        // Bare "approve" (no execution_id): resolve the pending purchase so a
        // user replying just "approve" in chat doesn't dead-end with "nothing
        // pending approval" (issue #172). The /approve route needs an id, and
        // the agent often no longer holds it a few turns after the prompt.
        // Prefer an execution awaiting_approval; if none, fall through to one
        // parked at awaiting_payment_method so the approve call returns the
        // actionable PAYMENT_METHOD_REQUIRED guidance instead of a dead end.
        if (!execution_id) {
          const list = await apiRequest("GET", "/v1/executions?limit=20");
          const all: any[] = Array.isArray(list?.executions)
            ? list.executions
            : Array.isArray(list)
            ? list
            : [];
          const approvable = all.filter((e) => e.status === "awaiting_approval");
          if (approvable.length === 1) {
            execution_id = approvable[0].id;
          } else if (approvable.length > 1) {
            const lines = approvable
              .slice(0, 10)
              .map((e) => `- \`${e.id}\` — ${e.request_text?.slice(0, 60) || "(no description)"}`);
            return {
              content: [{
                type: "text" as const,
                text: `You have ${approvable.length} purchases awaiting approval. Call firestarter_approve again with the execution_id of the one to approve:\n${lines.join("\n")}`,
              }],
              isError: true,
            };
          } else {
            const parked = all.filter((e) => e.status === "awaiting_payment_method");
            if (parked.length >= 1) {
              // Hand the most recent parked order to the approve route; it
              // returns PAYMENT_METHOD_REQUIRED with a setup URL (actionable).
              execution_id = parked[0].id;
            } else {
              return {
                content: [{
                  type: "text" as const,
                  text: "There's nothing awaiting your approval right now. If you just started a search it may still be finding options — check firestarter_status, or start a new request.",
                }],
                isError: true,
              };
            }
          }
        }
        if (!execution_id) {
          return {
            content: [{ type: "text" as const, text: "No execution to approve." }],
            isError: true,
          };
        }

        const body: any = {};
        if (option_id) {
          body.option_id = option_id;
        } else if (selected_option !== undefined) {
          // The approve route takes an option *id*; resolve the displayed index
          // against the execution's options (same match_score DESC order the
          // agent saw). Previously this was sent as `selected_option`, which
          // the API ignored — silently approving the pre-selected row instead.
          const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
          const opts: any[] = Array.isArray(exec.options) ? exec.options : [];
          const chosen = opts[selected_option];
          if (!chosen?.id) {
            return {
              content: [{
                type: "text" as const,
                text: `Error approving: option index ${selected_option} is out of range — this execution has ${opts.length} option(s) (valid indexes 0-${Math.max(0, opts.length - 1)}).`,
              }],
              isError: true,
            };
          }
          body.option_id = chosen.id;
        }
        await apiRequest("POST", `/v1/executions/${execution_id}/approve`, body);
        const exec = await pollExecution(apiRequest, execution_id, 30_000);
        const blocks = await formatExecution(exec);
        blocks.unshift({ type: "text", text: "Execution approved.\n" });
        return { content: blocks };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error approving: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_cancel
  server.tool(
    "firestarter_cancel",
    "Cancel an active execution. If payment was authorized, the hold will be released.",
    {
      execution_id: z.string().describe("The execution ID to cancel"),
      reason: z.string().optional().describe("Reason for cancellation"),
    },
    async ({ execution_id, reason }) => {
      try {
        await apiRequest("POST", `/v1/executions/${execution_id}/cancel`, { reason });
        return { content: [{ type: "text" as const, text: `Execution ${execution_id} cancelled.${reason ? ` Reason: ${reason}` : ""}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error cancelling: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_message
  server.tool(
    "firestarter_message",
    "Send a follow-up message to an active execution. Use this to refine the search, change requirements, or ask questions about the options.",
    {
      execution_id: z.string().describe("The execution ID to message"),
      message: z.string().describe("Follow-up message (e.g. 'I prefer organic options' or 'Can you find something cheaper?')"),
    },
    async ({ execution_id, message }) => {
      try {
        await apiRequest("POST", `/v1/executions/${execution_id}/message`, { message });
        const exec = await pollExecution(apiRequest, execution_id, 30_000);
        return { content: await formatExecution(exec) };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_watch
  server.tool(
    "firestarter_watch",
    "Create a price/stock monitor that watches products on a schedule. Get notified via webhook when prices drop, items restock, or new listings appear.",
    {
      name: z.string().describe("Name for this monitor (e.g. 'AirPods price watch')"),
      query: z.string().describe("What to watch — natural language (e.g. 'AirPods Pro 2 under $200')"),
      schedule: z.string().optional().describe("How often to check: 'hourly', 'daily', 'daily at 9am', 'every 6 hours', or a cron expression. Default: 'daily'"),
      price_drop_pct: z.number().optional().describe("Minimum price drop percentage to notify (e.g. 10 = notify on 10%+ drops)"),
      goal: z.string().optional().describe("Natural language goal for AI-powered meaningful change detection (e.g. 'price drops below $180')"),
      webhook_url: z.string().optional().describe("Webhook URL to receive change notifications"),
    },
    async ({ name, query, schedule, price_drop_pct, goal, webhook_url }) => {
      try {
        const body: any = { name, type: "product", targets: [{ query }], schedule: schedule || "daily", conditions: {} };
        if (price_drop_pct) body.conditions.price_drop_pct = price_drop_pct;
        if (goal) body.goal = goal;
        if (webhook_url) body.notifications = { webhook: { url: webhook_url } };
        const monitor = await apiRequest("POST", "/v1/monitors", body);
        return {
          content: [{
            type: "text" as const,
            text: `**Monitor created: ${monitor.name}**\nID: ${monitor.id}\nSchedule: ${monitor.schedule} (${monitor.schedule_cron})\nNext check: ${monitor.next_check_at}\n${goal ? `Goal: ${goal}\n` : ""}\nUse \`firestarter_watches\` to see all active monitors.`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error creating monitor: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_watches
  server.tool(
    "firestarter_watches",
    "List active monitors and their recent check results. Shows what you're watching, last check status, and any recent price changes or alerts.",
    {
      monitor_id: z.string().optional().describe("Get details for a specific monitor ID. Omit to list all monitors."),
      include_checks: z.boolean().optional().describe("Include recent check history (default: true for single monitor, false for list)"),
    },
    async ({ monitor_id, include_checks }) => {
      try {
        if (monitor_id) {
          const monitor = await apiRequest("GET", `/v1/monitors/${monitor_id}`);
          const checks = include_checks !== false
            ? await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=5`)
            : null;
          let text = `**${monitor.name}** [${monitor.status}]\nType: ${monitor.type} | Schedule: ${monitor.schedule}\nTargets: ${monitor.targets.map((t: any) => t.query).join(", ")}\n`;
          if (monitor.goal) text += `Goal: ${monitor.goal}\n`;
          if (monitor.last_check_at) text += `Last check: ${monitor.last_check_at}\n`;
          if (monitor.next_check_at) text += `Next check: ${monitor.next_check_at}\n`;
          if (checks?.checks?.length > 0) {
            text += "\n**Recent checks:**\n";
            for (const chk of checks.checks) {
              const s = chk.summary || {};
              text += `- ${chk.completed_at || chk.created_at}: ${chk.status}`;
              if (s.price_drops) text += ` | ${s.price_drops} price drop(s)`;
              if (s.new_listings) text += ` | ${s.new_listings} new listing(s)`;
              text += ` | ${s.products_checked || 0} products checked\n`;
              if (chk.changes?.length > 0) {
                for (const c of chk.changes.slice(0, 3)) {
                  text += `  ${c.status}: ${c.product}`;
                  if (c.previous_price && c.current_price) text += ` $${c.previous_price} → $${c.current_price}`;
                  if (c.drop_pct) text += ` (-${c.drop_pct}%)`;
                  if (c.judgment?.meaningful) text += ` ✓ ${c.judgment.reason}`;
                  text += "\n";
                }
              }
            }
          }
          return { content: [{ type: "text" as const, text }] };
        }
        const data = await apiRequest("GET", "/v1/monitors");
        const monitors = data.monitors || [];
        if (monitors.length === 0) {
          return { content: [{ type: "text" as const, text: "No monitors set up yet. Use `firestarter_watch` to create one." }] };
        }
        const lines = [`**Active Monitors** (${monitors.length})\n`];
        for (const m of monitors) {
          lines.push(`- **${m.name}** [${m.status}] — ${m.schedule}`);
          lines.push(`  ID: ${m.id} | Targets: ${m.targets.map((t: any) => t.query).join(", ")}`);
          if (m.last_check_at) lines.push(`  Last check: ${m.last_check_at}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_unwatch
  server.tool(
    "firestarter_unwatch",
    "Pause or delete a monitor. Paused monitors can be resumed later; deleted monitors are permanent.",
    {
      monitor_id: z.string().describe("The monitor ID to pause or delete"),
      action: z.enum(["pause", "resume", "delete"]).describe("Action to take: pause (stop checks, keep history), resume (restart checks), delete (permanent)"),
    },
    async ({ monitor_id, action }) => {
      try {
        if (action === "delete") {
          await apiRequest("DELETE", `/v1/monitors/${monitor_id}`);
          return { content: [{ type: "text" as const, text: `Monitor ${monitor_id} deleted.` }] };
        }
        const result = await apiRequest("POST", `/v1/monitors/${monitor_id}/${action}`);
        return { content: [{ type: "text" as const, text: `Monitor ${monitor_id} ${action}d. Status: ${result.status}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_check
  server.tool(
    "firestarter_check",
    "Trigger an immediate check on a monitor. Runs the product search and diff right now instead of waiting for the next scheduled check.",
    {
      monitor_id: z.string().describe("The monitor ID to check now"),
    },
    async ({ monitor_id }) => {
      try {
        await apiRequest("POST", `/v1/monitors/${monitor_id}/run`);
        const pollStart = Date.now();
        let latest: any = null;
        while (Date.now() - pollStart < 8_000) {
          const checks = await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=1`);
          latest = checks.checks?.[0];
          if (latest && latest.status !== "queued" && latest.status !== "running") break;
          await new Promise((r) => setTimeout(r, 800));
        }
        if (!latest || latest.status === "queued" || latest.status === "running") {
          return { content: [{ type: "text" as const, text: `Check queued for monitor ${monitor_id}. It may take a minute to complete. Use \`firestarter_watches\` to see results.` }] };
        }
        const s = latest.summary || {};
        let text = `**Check completed** for monitor ${monitor_id}\nProducts checked: ${s.products_checked || 0}\nPrice drops: ${s.price_drops || 0} | New listings: ${s.new_listings || 0}\n`;
        if (latest.changes?.length > 0) {
          text += "\n**Changes detected:**\n";
          for (const c of latest.changes) {
            text += `- ${c.status}: ${c.product}`;
            if (c.previous_price && c.current_price) text += ` $${c.previous_price} → $${c.current_price}`;
            if (c.drop_pct) text += ` (-${c.drop_pct}%)`;
            if (c.judgment) text += c.judgment.meaningful ? ` ✓ ${c.judgment.reason}` : ` ○ ${c.judgment.reason}`;
            text += "\n";
          }
        } else {
          text += "\nNo changes detected since last check.";
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_list
  server.tool(
    "firestarter_list",
    "List a product for sale on Firestarter. Creates a new listing with pricing and inventory. To VIEW listings you already have, use firestarter_listings instead.",
    {
      product_name: z.string().describe("Product name"),
      base_price: z.number().describe("Base price in USD"),
      category: z.string().optional().describe("Product category (e.g. 'electronics/audio/earbuds')"),
      floor_price: z.number().optional().describe("Never sell below this price"),
      ceiling_price: z.number().optional().describe("Never surge above this price"),
      dynamic_pricing: z.boolean().optional().describe("Enable demand-based pricing"),
      inventory_qty: z.number().optional().describe("Available quantity"),
    },
    async ({ product_name, base_price, category, floor_price, ceiling_price, dynamic_pricing, inventory_qty }) => {
      try {
        const body: any = { product_name, base_price };
        if (category) body.category = category;
        if (floor_price !== undefined) body.floor_price = floor_price;
        if (ceiling_price !== undefined) body.ceiling_price = ceiling_price;
        if (dynamic_pricing !== undefined) body.dynamic_pricing = dynamic_pricing;
        if (inventory_qty !== undefined) body.inventory_qty = inventory_qty;
        const listing = await apiRequest("POST", "/v1/listings", body);
        let text = `**Listing created: ${listing.product_name}**\nID: \`${listing.id}\`\nStatus: ${listing.status || "active"}\nBase price: $${listing.base_price}\n`;
        if (listing.floor_price) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing) text += `Dynamic pricing: enabled\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        text += `Share link: ${SHARE_LINK_BASE}/${listing.id}\n`;
        text += `\nPaste the share link bare in chat — it unfurls into a product card, humans see "ask your AI agent to buy this", and any agent that opens it gets purchase instructions. Buyers' agents also discover this via network search. Use \`firestarter_listings\` to view it anytime.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = msg.includes("NO_SELLER_PROFILE") ? "\n\nYou need to register as a seller first (POST /v1/sellers) before creating listings." : "";
        return { content: [{ type: "text" as const, text: `Error creating listing: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_import
  // A2: the Cole-chat seller claim funnel. Wraps POST /v1/listings/import -
  // the draft is reviewed in chat, then activated via firestarter_update_listing.
  server.tool(
    "firestarter_import",
    "Import a seller's EXISTING listing from another marketplace (Craigslist, Gumtree, their own site) into Firestarter. Give it the listing URL, or pasted listing text plus photo URLs, and it creates a DRAFT listing for the seller to review - not live, not buyable, no share link yet. eBay, Etsy, Facebook Marketplace, OfferUp and Mercari block server fetches: for those, do NOT send the URL - ask the seller to copy-paste the listing text and photo URLs instead. Activation (firestarter_update_listing, status 'active') requires a positive price (firestarter_reprice if the import found none) and the seller's Stripe payouts connected (firestarter_payouts).",
    {
      source_url: z.string().optional().describe("URL of the seller's existing listing (e.g. a Craigslist post). Omit for blocked platforms - paste text instead."),
      raw_text: z.string().optional().describe("Pasted listing text (title, price, description - at least 10 characters). Required when source_url is omitted or blocked; also fills gaps URL extraction missed."),
      photo_urls: z.array(z.string()).optional().describe("Photo URLs for the listing, e.g. image links the seller pasted in chat. Seller photos lead the images array."),
    },
    async ({ source_url, raw_text, photo_urls }) => {
      try {
        const body: any = {};
        if (source_url) body.source_url = source_url;
        if (raw_text) body.raw_text = raw_text;
        if (photo_urls && photo_urls.length > 0) body.photo_urls = photo_urls;
        // Import does a server-side page fetch (10s cap) + LLM extraction -
        // give it more headroom than the default API budget.
        const draft = await apiRequest("POST", "/v1/listings/import", body, IMPORT_TIMEOUT_MS);

        let text = `**Draft imported: ${draft.product_name}**\nID: \`${draft.id}\`\nStatus: draft (NOT live - buyers cannot see or buy it yet)\n`;
        text += Number(draft.base_price) > 0
          ? `Price: $${draft.base_price} ${draft.currency}\n`
          : `Price: none found - set one with firestarter_reprice before activating\n`;
        if (draft.category) text += `Category: ${draft.category}\n`;
        if (draft.condition) text += `Condition: ${draft.condition}\n`;
        if (draft.description) {
          const d = String(draft.description);
          text += `Description: ${d.slice(0, 200)}${d.length > 200 ? "..." : ""}\n`;
        }
        text += `Photos: ${Array.isArray(draft.images) ? draft.images.length : 0}\n`;
        if (Array.isArray(draft.needs_review) && draft.needs_review.length > 0) {
          text += `Needs review (extraction was uncertain or found nothing): ${draft.needs_review.join(", ")}\n`;
        }
        if (draft.verification?.status === "required") {
          const why = draft.verification.reason === "source_conflict"
            ? "this source URL was already imported by another seller"
            : String(draft.verification.reason || "verification required");
          text += `Heads-up: possession verification will be required at activation (${why}). The seller will get an FS-XXXX code to write by hand and photograph next to the item.\n`;
        }
        text += `\nNext steps:\n`;
        text += `1. Walk the seller through the draft - fix details with firestarter_update_listing, set or adjust the price with firestarter_reprice.\n`;
        text += `2. Check payouts with firestarter_payouts - activation is blocked until the seller's Stripe payouts are connected.\n`;
        text += `3. Only after the seller confirms it looks right: firestarter_update_listing with status "active". High-value (>= $500) and luxury-category items will ask for a possession photo first - relay the code instructions, then submit the seller's photo with firestarter_verify. Once active, it becomes buyable and gets its share link.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        let hint = "";
        if (/blocks server-side fetches/i.test(msg)) {
          hint = "\n\nThat platform cannot be fetched. Ask the seller to copy-paste the listing text (title, price, description) and photo URLs into chat, then call firestarter_import again with raw_text + photo_urls.";
        } else if (/no active seller profile/i.test(msg) || msg.includes("NO_SELLER_PROFILE")) {
          hint = "\n\nThe seller is not registered yet - they need a seller profile before importing. Point them to firestarter.network/sell to register, then retry.";
        } else if (/could not fetch/i.test(msg)) {
          hint = "\n\nAsk the seller to paste the listing text directly into chat and retry with raw_text.";
        }
        return { content: [{ type: "text" as const, text: `Error importing listing: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_request_escrow
  // B1: the buyer-side counterpart of firestarter_import. The user found a
  // listing on an EXTERNAL site and wants Firestarter escrow protection - we
  // mint a claim link, but THE BUYER delivers it to the seller themselves.
  server.tool(
    "firestarter_request_escrow",
    "BUYER-side tool: the user found a listing on another site (Craigslist, Facebook Marketplace, Gumtree, ...) and wants to pay through Firestarter escrow instead of cash/wire. Creates an escrow invite with a claim link for the SELLER, plus a ready-to-send message. The buyer must send that message to the seller themselves through the platform where they found the listing - Firestarter never contacts external sellers, and neither should you (never automate messages to Craigslist or marketplace posters). Needs the listing URL and the buyer's email (ask for it - that is where the goes-live notification lands). For Facebook Marketplace / eBay / Etsy / OfferUp / Mercari the page cannot be fetched, so also ask for the item title and price and pass them along.",
    {
      source_url: z.string().describe("URL of the external listing the buyer wants to purchase"),
      buyer_email: z.string().describe("Buyer's email address - notified when the seller claims and the listing goes live"),
      buyer_name: z.string().optional().describe("Buyer's first name (shown to the seller on the claim page)"),
      title: z.string().optional().describe("Item title, buyer-supplied. Required in practice for platforms that block fetches (Facebook Marketplace etc.)."),
      price: z.number().optional().describe("Asking price in the listing's currency, buyer-supplied (for blocked platforms)"),
    },
    async ({ source_url, buyer_email, buyer_name, title, price }) => {
      try {
        const body: any = { source_url, buyer_email };
        if (buyer_name) body.buyer_name = buyer_name;
        if (title) body.title = title;
        if (price !== undefined) body.price = price;
        // May fetch + extract the external page - same headroom as import.
        const r = await apiRequest("POST", "/v1/escrow-invites", body, IMPORT_TIMEOUT_MS);

        if (r.already_listed) {
          let text = `**Good news - this item is already live on Firestarter.**\n`;
          if (r.title) text += `Item: ${r.title}\n`;
          text += `Share link: ${r.share_url}\n\nNo invite needed - the buyer can pay through escrow right now from that link.`;
          return { content: [{ type: "text" as const, text }] };
        }

        let text = `**Escrow request created${r.item?.title ? `: ${r.item.title}` : ""}**\n`;
        if (r.item?.price) text += `Price: $${r.item.price}${r.item.currency ? ` ${r.item.currency}` : ""}\n`;
        text += `Claim link (for the seller): ${r.claim_url}\nExpires: ${r.expires_at}\n\n`;
        text += `**The buyer must send the seller this message themselves** - through the same place they found the listing (Craigslist reply email, Facebook Messenger, ...). Do not contact the seller for them. Suggested message:\n\n`;
        text += `${r.suggested_message}\n\n`;
        text += `What happens next: the seller claims the link, proves possession (photo of the item next to a handwritten code), the listing goes live, and the buyer gets an email at ${buyer_email} with the payment link. Funds are held in escrow until handoff.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // Error CODES ride on ApiError.code, never inside the message string.
        const code: string = err?.code ?? "";
        let hint = "";
        if (code === "INVALID_BUYER_EMAIL") {
          hint = "\n\nAsk the buyer for a valid email address - it is where the goes-live notification lands.";
        } else if (code === "INVALID_URL") {
          hint = "\n\nThe listing URL was rejected. Ask the buyer to copy the full address bar URL of the listing.";
        } else if (msg.includes("Too many requests")) {
          hint = "\n\nRate limit hit - wait a bit before creating another escrow request.";
        }
        return { content: [{ type: "text" as const, text: `Error creating escrow request: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_assist_quote
  // B4 Phase 3: price a courier crew (load + haul + unload) for a bulky item.
  // PURE QUOTE - nothing booked, no money. Booking is a separate tool so a
  // human always confirms the price first.
  server.tool(
    "firestarter_assist_quote",
    "Get pickup+delivery quotes for a PHYSICAL item, including loading/unloading help (a courier crew) for bulky or heavy things - weight racks, sofas, appliances. Use when a buyer or seller asks how to move an item, or proactively when an item is clearly bulky. Pure price check: books nothing, charges nothing. Include lat/lng for both stops when the user shared a location pin - some couriers (Lalamove in Thailand) cannot quote without coordinates. Returns quotes cheapest-first with a quote_ref; to actually book one, confirm the price with the human FIRST, then call firestarter_assist_book.",
    {
      pickup_address: z.string().describe("Pickup street address"),
      dropoff_address: z.string().describe("Dropoff street address"),
      pickup_lat: z.number().optional(),
      pickup_lng: z.number().optional(),
      dropoff_lat: z.number().optional(),
      dropoff_lng: z.number().optional(),
      weight_kg: z.number().optional().describe("Approximate item weight in kg"),
      bulky: z.boolean().optional().describe("Large/awkward item (furniture, gym equipment)"),
      two_person: z.boolean().optional().describe("Needs two people to carry - adds a crew helper"),
      needs_disassembly: z.boolean().optional(),
      declared_value_cents: z.number().optional().describe("Item value in cents, for courier insurance on high-value items"),
    },
    async (a) => {
      try {
        const r = await apiRequest("POST", "/v1/assist/quote", {
          pickup: { address: a.pickup_address, lat: a.pickup_lat, lng: a.pickup_lng },
          dropoff: { address: a.dropoff_address, lat: a.dropoff_lat, lng: a.dropoff_lng },
          handling: {
            weight_kg: a.weight_kg, bulky: a.bulky, two_person: a.two_person,
            needs_disassembly: a.needs_disassembly,
          },
          ...(a.declared_value_cents !== undefined ? { declared_value_cents: a.declared_value_cents } : {}),
        }, IMPORT_TIMEOUT_MS);
        if (r.enabled === false) {
          return { content: [{ type: "text" as const, text: "Fulfillment assist is not enabled on this workspace yet - the item would need to be moved by the buyer and seller themselves." }] };
        }
        if (!r.quotes?.length) {
          return { content: [{ type: "text" as const, text: "No courier could quote this route (outside coverage, or the item may be too large). Suggest the parties arrange the handoff themselves." }] };
        }
        let text = `**Courier options (cheapest first):**\n`;
        for (const q of r.quotes.slice(0, 4)) {
          const fee = (q.fee_cents / 100).toFixed(2);
          text += `- ${q.provider}: ${fee} ${q.currency}${q.vehicle_class ? ` (${q.vehicle_class}` : ""}${q.includes_helper ? " + loading crew)" : q.vehicle_class ? ")" : ""}${q.eta_minutes ? ` ~${q.eta_minutes} min` : ""}\n  quote_ref: ${q.quote_ref}\n`;
        }
        text += `\nRelay the price to the human and get an explicit YES before booking. Then call firestarter_assist_book with the chosen quote_ref. Quotes expire in minutes - re-quote if they hesitate.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error quoting assist: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_assist_book
  server.tool(
    "firestarter_assist_book",
    "Book a courier from a firestarter_assist_quote result. ONLY call after the human has explicitly confirmed the exact price - this dispatches a real crew and the fee is charged to the buyer's order. Link the purchase execution when there is one: the courier's proof-of-delivery photo then starts the escrow inspection window automatically.",
    {
      provider: z.string().describe("Provider name from the chosen quote (e.g. lalamove, nash)"),
      quote_ref: z.string().describe("quote_ref from firestarter_assist_quote"),
      pickup_address: z.string(),
      dropoff_address: z.string(),
      pickup_contact_name: z.string().optional(),
      pickup_contact_phone: z.string().optional(),
      dropoff_contact_name: z.string().optional(),
      dropoff_contact_phone: z.string().optional(),
      execution_id: z.string().optional().describe("The purchase execution this delivery fulfills (exec_...)"),
      listing_id: z.string().optional(),
      fee_cents: z.number().optional().describe("The confirmed quote fee, for the booking record"),
    },
    async (a) => {
      try {
        const r = await apiRequest("POST", "/v1/assist/book", {
          provider: a.provider,
          quote_ref: a.quote_ref,
          pickup: { address: a.pickup_address, contact_name: a.pickup_contact_name, contact_phone: a.pickup_contact_phone },
          dropoff: { address: a.dropoff_address, contact_name: a.dropoff_contact_name, contact_phone: a.dropoff_contact_phone },
          ...(a.execution_id ? { execution_id: a.execution_id } : {}),
          ...(a.listing_id ? { listing_id: a.listing_id } : {}),
          ...(a.fee_cents !== undefined ? { fee_cents: a.fee_cents } : {}),
        }, IMPORT_TIMEOUT_MS);
        let text = `**Courier booked.** Booking ${r.id} (${r.provider}, ref ${r.provider_ref})\n`;
        if (r.tracking_url) text += `Tracking: ${r.tracking_url}\n`;
        text += r.next_step;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // Error CODES ride on ApiError.code, never inside the message string.
        const hint = err?.code === "BOOKING_FAILED"
          ? "\n\nThe quote may have expired - run firestarter_assist_quote again and re-confirm with the human."
          : "";
        return { content: [{ type: "text" as const, text: `Error booking courier: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_payouts
  server.tool(
    "firestarter_payouts",
    "Check whether the seller's Stripe payouts are connected - required before an imported draft can be activated, and before the seller can be paid at all. If payouts are not connected, this also returns a Stripe onboarding link to send to the seller. Use it before activating imported drafts, or whenever a seller asks about getting paid.",
    {},
    async () => {
      try {
        const status = await apiRequest("GET", "/v1/sellers/stripe-connect/status");
        if (status.charges_enabled) {
          let text = "**Payouts connected.** The seller's Stripe account can receive funds - imported drafts can be activated.";
          if (!status.payouts_enabled) {
            text += "\nNote: bank payouts are still pending verification on Stripe's side; this does not block activating listings.";
          }
          return { content: [{ type: "text" as const, text }] };
        }
        // Not payable yet - fetch an onboarding link so the seller can finish.
        // Idempotent: an existing Connect account just gets a fresh link.
        const link = await apiRequest("POST", "/v1/sellers/stripe-connect");
        let text = status.connected
          ? "**Payouts not finished.** The seller started Stripe onboarding but charges are not enabled yet.\n"
          : "**Payouts not connected.** The seller has not set up Stripe payouts.\n";
        text += `\nSend the seller this onboarding link (a secure Stripe-hosted page - send it bare so it is clickable):\n${link.onboarding_url}\n`;
        text += `\nAfter they finish, run firestarter_payouts again to verify, then activate the listing.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /no active seller profile/i.test(msg)
          ? "\n\nThe seller is not registered yet - point them to firestarter.network/sell to register first."
          : "";
        return { content: [{ type: "text" as const, text: `Error checking payouts: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_listings
  server.tool(
    "firestarter_listings",
    "View your own product listings (seller side): name, current price, inventory, status, demand, and share link. Pass listing_id for full detail on one listing; omit it to list all active listings. Use this when a seller wants to see, verify, or share what they have listed — every listing has a public share link (https://firestarter.network/l/<id>) that unfurls into a product card and hands purchase instructions to any AI agent that opens it.",
    {
      listing_id: z.string().optional().describe("Specific listing ID (lst_...) for full detail. Omit to list all active listings."),
    },
    async ({ listing_id: rawListingId }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        if (listing_id) {
          const l = await apiRequest("GET", `/v1/listings/${listing_id}`);
          let text = `**${l.product_name}** [${l.status}]\nID: \`${l.id}\`\n`;
          text += `Price: $${Number(l.current_price).toFixed(2)}`;
          const priceBits: string[] = [];
          if (l.base_price != null && l.base_price !== l.current_price) priceBits.push(`base $${Number(l.base_price).toFixed(2)}`);
          if (l.floor_price) priceBits.push(`floor $${Number(l.floor_price).toFixed(2)}`);
          if (l.ceiling_price) priceBits.push(`ceiling $${Number(l.ceiling_price).toFixed(2)}`);
          if (l.dynamic_pricing) priceBits.push("dynamic pricing on");
          if (priceBits.length) text += ` (${priceBits.join(", ")})`;
          text += "\n";
          if (l.inventory_qty != null) text += `Inventory: ${l.inventory_qty}\n`;
          if (l.category) text += `Category: ${l.category}\n`;
          if (l.description) text += `Description: ${String(l.description).slice(0, 300)}\n`;
          if (Array.isArray(l.images) && l.images.length > 0) {
            text += `Image: ${l.images[0]}${l.images.length > 1 ? ` (+${l.images.length - 1} more)` : ""}\n`;
          }
          if (l.demand_score != null) text += `Demand score: ${l.demand_score}\n`;
          if (l.created_at) text += `Listed: ${l.created_at}\n`;
          text += `Share link: ${SHARE_LINK_BASE}/${l.id}\n`;
          text += `\nPaste the share link bare in chat — it unfurls into a product card; humans get an "ask your AI agent to buy this" prompt and agents get machine-readable purchase instructions. Buyers' agents also find this via network search.`;
          return { content: [{ type: "text" as const, text }] };
        }
        const data = await apiRequest("GET", "/v1/listings");
        const listings = data.listings || [];
        if (listings.length === 0) {
          return { content: [{ type: "text" as const, text: "You have no active listings. Use `firestarter_list` to create one." }] };
        }
        let text = `**Your listings (${listings.length})**\n`;
        for (const l of listings) {
          text += `- **${l.product_name}** [${l.status}] — $${Number(l.current_price).toFixed(2)}`;
          if (l.inventory_qty != null) text += `, qty ${l.inventory_qty}`;
          text += ` — ID \`${l.id}\`\n`;
        }
        text += `\nPass a listing ID for full detail. Each listing has a share link (${SHARE_LINK_BASE}/<id>) that unfurls into a product card and hands purchase instructions to any agent that opens it.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /not found/i.test(msg)
          ? "\n\nCall `firestarter_listings` with no arguments to see all your listings and their IDs."
          : "";
        return { content: [{ type: "text" as const, text: `Error fetching listings: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_demand
  server.tool(
    "firestarter_demand",
    "Check demand intelligence for a specific listing or category. See what buyers are searching for, demand trends, and pricing signals.",
    {
      listing_id: z.string().optional().describe("Specific listing ID to check demand for"),
      category: z.string().optional().describe("Check demand for a category (e.g. 'electronics/audio')"),
    },
    async ({ listing_id: rawListingId }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        let data: any;
        if (listing_id) {
          data = await apiRequest("GET", `/v1/listings/${listing_id}/demand`);
        } else {
          data = await apiRequest("GET", "/v1/demand/feed?hours=24");
        }
        const items = data.signals || data.demand || [data];
        if (!items || (Array.isArray(items) && items.length === 0)) {
          return { content: [{ type: "text" as const, text: "No demand signals found for the given criteria." }] };
        }
        let text = listing_id ? `**Demand for listing ${listing_id}**\n` : `**Demand feed** (last 24 hours)\n`;
        if (Array.isArray(items)) {
          for (const item of items.slice(0, 15)) {
            text += `- ${item.query || item.category || item.product || "Unknown"}`;
            if (item.count) text += ` (${item.count} searches)`;
            if (item.trend) text += ` | trend: ${item.trend}`;
            if (item.avg_budget) text += ` | avg budget: $${item.avg_budget}`;
            text += "\n";
          }
        } else {
          text += JSON.stringify(items, null, 2);
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error checking demand: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_reprice
  server.tool(
    "firestarter_reprice",
    "Adjust pricing or rules for an existing listing. Update base price, floor/ceiling limits, dynamic pricing settings, or pricing rules.",
    {
      listing_id: z.string().describe("The listing ID to reprice"),
      base_price: z.number().optional().describe("New base price in USD"),
      floor_price: z.number().optional().describe("New floor price"),
      ceiling_price: z.number().optional().describe("New ceiling price"),
      dynamic_pricing: z.boolean().optional().describe("Enable/disable dynamic pricing"),
    },
    async ({ listing_id: rawListingId, base_price, floor_price, ceiling_price, dynamic_pricing }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        const body: any = {};
        if (base_price !== undefined) body.base_price = base_price;
        if (floor_price !== undefined) body.floor_price = floor_price;
        if (ceiling_price !== undefined) body.ceiling_price = ceiling_price;
        if (dynamic_pricing !== undefined) body.dynamic_pricing = dynamic_pricing;
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "No pricing changes provided. Specify at least one field to update." }], isError: true };
        }
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, body);
        let text = `**Listing ${listing_id} updated**\n`;
        if (listing.base_price !== undefined) text += `Base price: $${listing.base_price}\n`;
        if (listing.floor_price !== undefined) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price !== undefined) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing !== undefined) text += `Dynamic pricing: ${listing.dynamic_pricing ? "enabled" : "disabled"}\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error repricing: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_update_listing
  server.tool(
    "firestarter_update_listing",
    "Update a listing's product details — name, description, category, inventory, or status. Use this to rename a product, change its description, update stock levels, or pause/reactivate a listing. Also activates imported drafts (status 'active') - drafts need a positive price and the seller's Stripe payouts connected first (see firestarter_import / firestarter_payouts). High-value (>= $500) and luxury-category drafts additionally require a possession-verification photo: activation returns the instructions and an FS-XXXX code to relay, and firestarter_verify submits the seller's photo. For pricing changes, use firestarter_reprice instead.",
    {
      listing_id: z.string().describe("The listing ID to update"),
      product_name: z.string().optional().describe("New product name/title"),
      description: z.string().optional().describe("New product description"),
      category: z.string().optional().describe("New category (e.g. 'sports/tennis')"),
      inventory_qty: z.number().optional().describe("Updated inventory quantity"),
      status: z.enum(["active", "paused", "out_of_stock"]).optional().describe("New listing status"),
    },
    async ({ listing_id: rawListingId, product_name, description, category, inventory_qty, status }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        const body: any = {};
        if (product_name !== undefined) body.product_name = product_name;
        if (description !== undefined) body.description = description;
        if (category !== undefined) body.category = category;
        if (inventory_qty !== undefined) body.inventory_qty = inventory_qty;
        if (status !== undefined) body.status = status;
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "No updates provided. Specify at least one field to change." }], isError: true };
        }
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, body);
        let text = `**Listing ${listing_id} updated**\n`;
        if (listing.product_name) text += `Name: ${listing.product_name}\n`;
        if (listing.description) text += `Description: ${listing.description.slice(0, 100)}${listing.description.length > 100 ? "..." : ""}\n`;
        if (listing.category) text += `Category: ${listing.category}\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        if (listing.status) text += `Status: ${listing.status}\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        // Activation can trip the possession-verification gate - surface the
        // code + photo instructions instead of a flattened error string.
        const ask = verificationAskText(err);
        if (ask) {
          return { content: [{ type: "text" as const, text: ask }], isError: true };
        }
        if (err instanceof ApiError && err.code === "VERIFICATION_PENDING") {
          return {
            content: [{ type: "text" as const, text: `Cannot activate yet: a verification photo was received but could not be auto-checked, so it is held for review. The seller can resubmit a clearer photo with firestarter_verify (item + handwritten code both visible).` }],
            isError: true,
          };
        }
        if (err instanceof ApiError && err.code === "VERIFICATION_FLAGGED") {
          return {
            content: [{ type: "text" as const, text: `Cannot activate yet: the last verification photo did not match this listing, so it is queued for review. Ask the seller for a clearer photo - the item and the handwritten code both visible in one shot - and resubmit with firestarter_verify.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Error updating listing: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_verify
  // A3: possession-verification evidence. Wraps POST /v1/listings/:id/verification.
  // The happy path is human-free: vision soft-check auto-approves, the agent
  // relays the outcome and activates. Mismatches flag (resubmit allowed);
  // vision errors hold as pending (fail-safe, never fail-open).
  server.tool(
    "firestarter_verify",
    "Submit a possession-verification photo for a listing whose activation asked for one (high-value >= $500, luxury category, or a source-URL conflict). The seller writes the FS-XXXX code by hand, photographs the paper next to the item, and sends the photo in chat - pass that photo's URL here with the listing ID. A match verifies instantly (then activate via firestarter_update_listing); a mismatch is flagged and the seller can resubmit a clearer photo; an unreadable photo is held for review.",
    {
      listing_id: z.string().describe("The listing ID (lst_...) that needs possession verification"),
      photo_url: z.string().describe("Public https URL of the seller's photo showing the item next to the handwritten verification code"),
    },
    async ({ listing_id, photo_url }) => {
      try {
        const r = await apiRequest("POST", `/v1/listings/${listing_id}/verification`, { photo_url }, VERIFY_TIMEOUT_MS);
        if (r.verification_status === "verified") {
          const already = !r.checked;
          const text = already
            ? `**Listing ${listing_id} is already verified.** Activate it with firestarter_update_listing (status "active") once the seller confirms the draft looks right.`
            : `**Verified.** The photo matches the listing and the handwritten code - no human review needed.\n\nNext: after the seller confirms the draft looks right, activate with firestarter_update_listing (status "active").`;
          return { content: [{ type: "text" as const, text }] };
        }
        if (r.verification_status === "flagged") {
          const text =
            `**Not verified - the photo did not clearly match.**\n` +
            `Item match: ${r.checked?.item_match === true ? "yes" : "no"} | Code match: ${r.checked?.code_match === true ? "yes" : "no"}\n\n` +
            `It is queued for review, but the seller can resubmit right away: one clear photo with the item AND the handwritten code both visible, then call firestarter_verify again.`;
          return { content: [{ type: "text" as const, text }] };
        }
        // pending: vision could not check - held, never auto-approved
        return {
          content: [{ type: "text" as const, text: `**Photo received but not auto-checked.** ${r.message || "It is held for review."} The seller can also resubmit a clearer photo with firestarter_verify later.` }],
        };
      } catch (err: any) {
        const ask = verificationAskText(err);
        if (ask) {
          // First evidence attempt on a collision-born draft: the code was
          // just issued - relay the instructions, then resubmit the photo.
          return { content: [{ type: "text" as const, text: ask }], isError: true };
        }
        if (err instanceof ApiError && err.code === "VERIFICATION_NOT_REQUIRED") {
          return {
            content: [{ type: "text" as const, text: `This listing does not need possession verification. Activate it directly with firestarter_update_listing (status "active").` }],
            isError: true,
          };
        }
        const msg = toErrorMessage(err);
        let hint = "";
        if (err instanceof ApiError && (err.code === "INVALID_PHOTO_URL" || err.code === "MISSING_PHOTO_URL")) {
          hint = "\n\nThe photo must be a public https image URL (e.g. the URL of the photo the seller sent in chat). Ask the seller to re-send the photo if needed.";
        } else if (/not found/i.test(msg)) {
          hint = "\n\nCall firestarter_listings to check the listing ID.";
        }
        return { content: [{ type: "text" as const, text: `Error submitting verification photo: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_delist
  server.tool(
    "firestarter_delist",
    "Remove one of your listings from the network (soft delete). Buyers' agents can no longer find or buy it, and its share link goes dark. Always confirm with the user before delisting — this takes the product off the market immediately.",
    {
      listing_id: z.string().describe("The listing ID (lst_...) to delist"),
    },
    async ({ listing_id: rawListingId }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        await apiRequest("DELETE", `/v1/listings/${listing_id}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `**Listing ${listing_id} delisted.** It is no longer discoverable by buyers' agents, and its share link (${SHARE_LINK_BASE}/${listing_id}) now shows not-found. Relist anytime with \`firestarter_list\`.`,
            },
          ],
        };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /not found/i.test(msg)
          ? "\n\nCall `firestarter_listings` to see your active listings and their IDs — it may already be delisted."
          : "";
        return { content: [{ type: "text" as const, text: `Error delisting: ${msg}${hint}` }], isError: true };
      }
    }
  );
}
