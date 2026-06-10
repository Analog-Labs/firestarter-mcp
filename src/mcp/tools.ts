/**
 * Shared MCP tool definitions.
 * Used by both the stdio server (server.ts) and the HTTP route (route.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeApiRequest(apiKey: string, apiBase: string) {
  return async function apiRequest(method: string, path: string, body?: unknown) {
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `API request failed: ${res.status}`);
    }
    return data;
  };
}

async function pollExecution(apiRequest: ReturnType<typeof makeApiRequest>, executionId: string, timeoutMs: number = 60_000): Promise<any> {
  const start = Date.now();
  const pollInterval = 2_000;

  while (Date.now() - start < timeoutMs) {
    const exec = await apiRequest("GET", `/v1/executions/${executionId}`);
    if (["awaiting_approval", "completed", "failed", "cancelled", "paid", "shipping", "delivered"].includes(exec.status)) {
      return exec;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return apiRequest("GET", `/v1/executions/${executionId}`);
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    const buf = await res.arrayBuffer();
    return { data: Buffer.from(buf).toString("base64"), mimeType: ct.split(";")[0] };
  } catch {
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

  if (exec.options && exec.options.length > 0) {
    lines.push("");
    lines.push("**Options found:**");
    blocks.push({ type: "text", text: lines.join("\n") });
    lines.length = 0;

    // Fetch all images in parallel
    const imageUrls = exec.options.map((opt: any) => opt.metadata?.image || opt.image || null);
    const images = await Promise.all(imageUrls.map((url: string | null) => url ? fetchImageAsBase64(url) : Promise.resolve(null)));

    for (let i = 0; i < exec.options.length; i++) {
      const opt = exec.options[i];
      const imageUrl = imageUrls[i];
      const optLines: string[] = [];
      optLines.push(`\n**${i + 1}. ${opt.product_title}** — $${opt.total} from ${opt.supplier || opt.store || "Unknown"}`);
      if (opt.product_url) optLines.push(`  URL: ${opt.product_url}`);
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

  return blocks;
}

// ─── Register all tools ─────────────────────────────────────────────────────

export function registerTools(server: McpServer, apiKey: string, apiBase: string) {
  const apiRequest = makeApiRequest(apiKey, apiBase);

  // Tool: firestarter_execute
  server.tool(
    "firestarter_execute",
    "Execute a commerce transaction. Find products matching a natural language request, verify suppliers, get pricing, and optionally handle payment and delivery. Returns product options for approval.",
    {
      request: z.string().describe("Natural language description of what to buy (e.g. 'specialty coffee beans under $30')"),
      budget_max: z.number().optional().describe("Maximum budget in USD"),
      delivery_address: z.string().optional().describe("Delivery address as a string"),
      priority: z.enum(["cost", "speed", "quality"]).optional().describe("Optimization priority: cost (cheapest), speed (fastest delivery), quality (best rated)"),
      auto_pay: z.boolean().optional().describe("If true, automatically pay for the best option within budget. If false (default), present options for approval."),
    },
    async ({ request, budget_max, delivery_address, priority, auto_pay }) => {
      try {
        const body: any = {
          request,
          preferences: { priority: priority || "quality", require_approval: !auto_pay },
        };
        if (budget_max) body.budget = { max_total: budget_max, currency: "USD" };
        if (delivery_address) body.delivery_address = { address: delivery_address };

        const created = await apiRequest("POST", "/v1/executions", body);
        const exec = await pollExecution(apiRequest, created.id);
        const blocks = await formatExecution(exec);

        if (exec.status === "awaiting_approval") {
          blocks.push({ type: "text", text: "\n\n**Action needed:** Use `firestarter_approve` to approve an option, or `firestarter_cancel` to cancel." });
        }
        return { content: blocks };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
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
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_approve
  server.tool(
    "firestarter_approve",
    "Approve an execution that is awaiting approval. This selects the best option and proceeds with payment.",
    {
      execution_id: z.string().describe("The execution ID to approve (e.g. 'exec_abc123')"),
      selected_option: z.number().optional().describe("Index of the option to select (0-based). Defaults to 0 (best option)."),
    },
    async ({ execution_id, selected_option }) => {
      try {
        const body: any = {};
        if (selected_option !== undefined) body.selected_option = selected_option;
        await apiRequest("POST", `/v1/executions/${execution_id}/approve`, body);
        const exec = await pollExecution(apiRequest, execution_id, 30_000);
        const blocks = await formatExecution(exec);
        blocks.unshift({ type: "text", text: "Execution approved.\n" });
        return { content: blocks };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error approving: ${err.message}` }], isError: true };
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
        return { content: [{ type: "text" as const, text: `Error cancelling: ${err.message}` }], isError: true };
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
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
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
        return { content: [{ type: "text" as const, text: `Error creating monitor: ${err.message}` }], isError: true };
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
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
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
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
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
        await new Promise(r => setTimeout(r, 5000));
        const checks = await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=1`);
        const latest = checks.checks?.[0];
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
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_list
  server.tool(
    "firestarter_list",
    "List a product for sale on Firestarter. Creates a new listing with pricing and inventory.",
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
        let text = `**Listing created: ${listing.product_name}**\nID: ${listing.id}\nBase price: $${listing.base_price}\n`;
        if (listing.floor_price) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing) text += `Dynamic pricing: enabled\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const hint = err.message.includes("NO_SELLER_PROFILE") ? "\n\nYou need to register as a seller first (POST /v1/sellers) before creating listings." : "";
        return { content: [{ type: "text" as const, text: `Error creating listing: ${err.message}${hint}` }], isError: true };
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
    async ({ listing_id }) => {
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
        return { content: [{ type: "text" as const, text: `Error checking demand: ${err.message}` }], isError: true };
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
    async ({ listing_id, base_price, floor_price, ceiling_price, dynamic_pricing }) => {
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
        return { content: [{ type: "text" as const, text: `Error repricing: ${err.message}` }], isError: true };
      }
    }
  );
}
