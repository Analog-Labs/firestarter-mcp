/**
 * Marketplace scout tools (#1056, commerce PRs #1067/#1068).
 *
 * The buyer's OWN Shopee/Lazada accounts, driven server-side in a cloud
 * browser: connect once (live-view login), then one search fans out across
 * every connected marketplace plus seeded Shopify stores and the Firestarter
 * catalog. Results render in the shopping-results MCP App grid.
 *
 * Kept in its own module so tools.ts stays navigable; registered from
 * registerTools() with the same apiRequest closure every other tool uses.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { marketplaceOutputShape, toMarketplaceStructured } from "./schemas.js";
import { SHOPPING_RESULTS_URI } from "./shopping-app.js";
import { sanitizeUntrusted } from "./untrusted.js";

type ApiRequest = (method: string, path: string, body?: unknown, timeoutMs?: number, extraHeaders?: Record<string, string>) => Promise<any>;
type RegisterCompat = (server: McpServer, name: string, config: any, handler: any) => void;
type InlineImages = (urls: Array<string | null | undefined>) => Promise<any[]>;

export interface ScoutToolDeps {
  apiRequest: ApiRequest;
  registerToolCompat: RegisterCompat;
  inlineImageBlocks: InlineImages;
  toErrorMessage: (err: unknown) => string;
  pollIntervalMs: number;
}

/** Wall-clock budget for one search call before handing back partial results. */
const SCOUT_WAIT_MS = Number(process.env.FIRESTARTER_MCP_SCOUT_WAIT_MS || 55_000);
const POLL_MAX_CONSECUTIVE_ERRORS = 3;

const MARKETPLACE_LABEL: Record<string, string> = { shopee: "Shopee", lazada: "Lazada", shopify: "Shopify stores", firestarter: "Firestarter" };
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const PAUSED = new Set(["needs_input", "awaiting_confirm"]);

/** Prose for the gate refusals every scout route can return; null for anything else. */
export function scoutGateText(err: any): string | null {
  const code = err?.code ?? err?.body?.code;
  if (code === "SCOUT_DISABLED" || (err?.status === 404 && /marketplace buying/i.test(String(err?.message ?? "")))) {
    return "Marketplace buying isn't enabled on this API yet. Firestarter's own catalog still works with firestarter_catalog_search.";
  }
  if (code === "STAFF_ONLY") {
    return "Marketplace buying is limited to Firestarter admins right now. Firestarter's own catalog still works with firestarter_catalog_search.";
  }
  return null;
}

function label(m: string): string {
  return MARKETPLACE_LABEL[m] ?? m;
}

function money(minor: unknown, currency: unknown): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  return `${typeof currency === "string" ? currency : ""} ${(n / 100).toFixed(2)}`.trim();
}

function compact(n: unknown): string | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(Math.round(v));
}

export function renderScoutRows(results: any[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const name = sanitizeUntrusted(String(r?.title ?? ""));
    const url = typeof r?.product_url === "string" ? r.product_url : null;
    const nameCell = url ? `[${name}](${url})` : name;
    const buy = typeof r?.buy_url === "string" ? r.buy_url : null;
    const tag = r?.checkoutable ? "✅ checkoutable" : r?.on_network ? "🏠 on Firestarter" : buy ? "🛒 buy in app" : "👁 browse-only";
    const bits = [
      r?.rating != null ? `⭐ ${Number(r.rating).toFixed(1)}` : null,
      compact(r?.sold_count) ? `${compact(r.sold_count)} sold` : null,
      r?.location ? sanitizeUntrusted(String(r.location), 60) : null,
      r?.in_stock === false ? "out of stock" : null,
    ].filter(Boolean).join(" · ");
    lines.push(
      `- **${nameCell}** — ${money(r?.price_minor, r?.currency)} [${label(String(r?.source ?? ""))}] ${tag}` +
      `${bits ? `\n  ${bits}` : ""}${buy && buy !== url ? `\n  Buy: ${buy}` : ""}\n  id: \`${String(r?.id ?? "")}\``,
    );
  }
  return lines;
}

function progressSummary(progress: Record<string, string> | undefined): { done: string[]; pending: string[]; skipped: string[] } {
  const done: string[] = []; const pending: string[] = []; const skipped: string[] = [];
  for (const [source, state] of Object.entries(progress ?? {})) {
    if (state === "done" || state === "cached") done.push(source);
    else if (state === "queued" || state === "running") pending.push(source);
    else if (state === "not_configured") skipped.push(`${label(source)} (not set up on this API yet)`);
    else skipped.push(`${label(source)} (${state.replace(/^failed:/, "")})`);
  }
  return { done, pending, skipped };
}

async function pollScoutJob(apiRequest: ApiRequest, jobId: string, pollIntervalMs: number, budgetMs: number): Promise<any> {
  const start = Date.now();
  let consecutiveErrors = 0;
  let last: any = null;
  while (Date.now() - start < budgetMs) {
    try {
      const res = await apiRequest("GET", `/v1/scout/jobs/${encodeURIComponent(jobId)}`);
      consecutiveErrors = 0;
      last = res?.job ?? res;
      if (TERMINAL.has(last?.status) || PAUSED.has(last?.status)) return last;
    } catch (err: any) {
      if (err?.status === 404 || scoutGateText(err)) throw err;
      if (++consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  if (last) return last;
  const res = await apiRequest("GET", `/v1/scout/jobs/${encodeURIComponent(jobId)}`);
  return res?.job ?? res;
}

export function registerScoutTools(server: McpServer, deps: ScoutToolDeps): void {
  const { apiRequest, registerToolCompat, inlineImageBlocks, toErrorMessage, pollIntervalMs } = deps;

  const gateOrError = (err: any, fallback: string) => ({
    content: [{ type: "text" as const, text: scoutGateText(err) ?? `${fallback}: ${toErrorMessage(err)}` }],
    isError: true,
  });

  // Tool: firestarter_marketplaces
  server.tool(
    "firestarter_marketplaces",
    "Which of the buyer's OWN marketplace accounts (Shopee, Lazada) are connected for marketplace search and checkout, with the countries supported (MY, SG, TH). A connected marketplace is searched by firestarter_marketplace_search and can be bought from with the payment method already saved on that marketplace. `needs_login` means the saved sign-in expired — reconnect with firestarter_connect_marketplace. Read-only. Admin-only while the feature is proven; other callers get a plain refusal.",
    {},
    { title: "My Marketplaces", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        const res = await apiRequest("GET", "/v1/marketplaces");
        const rows: any[] = Array.isArray(res?.marketplaces) ? res.marketplaces : [];
        const supported: any[] = Array.isArray(res?.supported) ? res.supported : [];
        const lines = ["**Your marketplaces**", ""];
        for (const m of rows) {
          const status = m.connected ? `✅ connected (${m.country}${m.currency ? `, ${m.currency}` : ""})`
            : m.status === "needs_login" ? `⚠️ needs sign-in again (${m.country})`
            : m.status === "pending" ? `⏳ sign-in started, not verified (${m.country})`
            : "— not connected";
          lines.push(`- **${label(m.marketplace)}**: ${status}${m.last_verified_at ? ` · verified ${String(m.last_verified_at).slice(0, 10)}` : ""}`);
        }
        const countries = supported[0]?.countries?.map((c: any) => c.country).join(", ");
        if (countries) lines.push("", `Supported countries: ${countries}.`);
        lines.push("", "Connect one with `firestarter_connect_marketplace`; search all connected ones with `firestarter_marketplace_search`.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return gateOrError(err, "Couldn't read your marketplaces");
      }
    },
  );

  // Tool: firestarter_connect_marketplace
  server.tool(
    "firestarter_connect_marketplace",
    "Connect the buyer's OWN Shopee or Lazada account for marketplace search and checkout. Step 1 (default): opens a private cloud browser on the marketplace's sign-in page and returns a link — the buyer opens it (phone is fine), signs in as they normally would including any code the marketplace sends, then says they're done. Nothing they type reaches Firestarter or the agent; the sign-in is kept as a browser profile at the provider, never as cookies here. Step 2: call again with verify: true to confirm the sign-in stuck; if the marketplace still shows its login page you get a fresh link. `country` picks the storefront (MY, SG, TH) and is required the first time.",
    {
      marketplace: z.enum(["shopee", "lazada"]).describe("Which marketplace to connect"),
      country: z.string().length(2).optional().describe("Storefront country, ISO 3166-1 alpha-2: MY, SG or TH. Required on first connect; remembered afterwards."),
      verify: z.boolean().optional().describe("true = the buyer says they've signed in; confirm it and mark the marketplace connected."),
      mobile: z.boolean().optional().describe("true when the buyer will open the sign-in link on a phone (mobile-sized browser)."),
    },
    { title: "Connect Marketplace", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ marketplace, country, verify, mobile }) => {
      const name = label(marketplace);
      try {
        if (verify) {
          const res = await apiRequest("POST", `/v1/marketplaces/${marketplace}/verify`, {});
          const c = res?.connection ?? {};
          return { content: [{ type: "text" as const, text: `**${name} connected** (${c.country ?? country ?? ""}). Searches now include it, and checkout there uses the payment method saved on ${name}. Disconnect any time from the dashboard's Purchases tab.` }] };
        }
        const res = await apiRequest("POST", `/v1/marketplaces/${marketplace}/connect`, { ...(country ? { country: country.toUpperCase() } : {}), ...(mobile != null ? { mobile } : {}) });
        return {
          content: [{
            type: "text" as const,
            text: `**Sign in to ${name} here:** ${res.live_view_url}\n\nOpen it, sign in as usual (a code from ${name} is fine — type it there), then tell me you're done and I'll verify. The link expires at ${String(res.expires_at ?? "").replace("T", " ").slice(0, 16)}. Nothing you type there reaches Firestarter.`,
          }],
        };
      } catch (err: any) {
        const code = err?.code ?? err?.body?.code;
        if (code === "NOT_LOGGED_IN" && err?.body?.live_view_url) {
          return { content: [{ type: "text" as const, text: `${name} still shows its sign-in page. Finish signing in here, then tell me again: ${err.body.live_view_url}` }] };
        }
        if (code === "NOT_CONNECTED") {
          return { content: [{ type: "text" as const, text: `Nothing to verify yet — start with connecting ${name} (call without verify).` }], isError: true };
        }
        if (code === "INVALID_REQUEST") {
          return { content: [{ type: "text" as const, text: `Which country's ${name}? Pass country: MY, SG or TH.` }], isError: true };
        }
        if (code === "PROVIDER_ERROR") {
          return { content: [{ type: "text" as const, text: `The cloud browser provider couldn't open a session right now: ${err.message}. Try again in a minute.` }], isError: true };
        }
        return gateOrError(err, `Couldn't connect ${name}`);
      }
    },
  );

  // Tool: firestarter_marketplace_search
  registerToolCompat(
    server,
    "firestarter_marketplace_search",
    {
      description: "Search EXTERNAL marketplaces and the Firestarter catalog at once — Shopee (Thailand first; no login or connection needed — results come from localized Google Shopping filtered to shopee.co.th, or Shopee's affiliate API when the server has credentials), Lazada, seeded Shopify stores — and return one ranked comparison with photos, prices, ratings and sold counts, rendered like firestarter_catalog_search. Ranked by price, rating and popularity; on-network items get a small bonus. Each external row carries a Buy link that opens the item in that marketplace's app, where the buyer picks the variant and pays with what the app already holds; Firestarter never touches their account. After they pay, record the order with firestarter_record_purchase. Usually answers in seconds; if a source is still running you get what's back so far plus a job_id — call again with that job_id to collect the rest (never treat a partial answer as 'no results'). Admin-only while the feature is proven.",
      inputSchema: {
        query: z.string().min(2).max(200).describe("What the buyer wants, in their words, e.g. 'cotton buds 200pcs' or 'สำลีก้าน'. Put price limits in max_price, not the query."),
        marketplaces: z.array(z.enum(["shopee", "lazada", "shopify", "firestarter"])).optional().describe("Restrict sources. Default: every connected marketplace plus Shopify stores and the Firestarter catalog."),
        country: z.string().length(2).optional().describe("Storefront country (MY, SG, TH). Default: the buyer's connected marketplace's country."),
        max_price: z.number().positive().optional().describe("Maximum price in the storefront currency (e.g. 15 for RM15 / ฿15)."),
        currency: z.string().length(3).optional().describe("Currency of max_price (MYR, SGD, THB). Default: the storefront's."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results per source (default 20)."),
        job_id: z.string().optional().describe("Re-poll an earlier search instead of starting a new one — pass the job_id from a partial result."),
      },
      outputSchema: marketplaceOutputShape,
      annotations: { title: "Search Marketplaces", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
    },
    async ({ query, marketplaces, country, max_price, currency, limit, job_id }: {
      query: string; marketplaces?: string[]; country?: string; max_price?: number; currency?: string; limit?: number; job_id?: string;
    }) => {
      try {
        let jobId = job_id;
        if (!jobId) {
          const body: Record<string, unknown> = { query };
          if (marketplaces?.length) body.marketplaces = marketplaces;
          if (country) body.country = country.toUpperCase();
          if (typeof max_price === "number") body.max_price_minor = Math.round(max_price * 100);
          if (currency) body.currency = currency.toUpperCase();
          if (typeof limit === "number") body.limit = limit;
          const created = await apiRequest("POST", "/v1/scout/search", body);
          jobId = String(created?.job?.id ?? created?.id ?? "");
        }
        const job = await pollScoutJob(apiRequest, jobId, pollIntervalMs, SCOUT_WAIT_MS);
        const results: any[] = Array.isArray(job?.results) ? job.results : [];
        const { done, pending, skipped } = progressSummary(job?.progress);
        const total = done.length + pending.length + skipped.length;
        const structuredContent = toMarketplaceStructured(job);
        const lines: string[] = [];

        if (job?.status === "needs_input" && job?.needs_input) {
          const ni = job.needs_input;
          const what = ni.kind === "otp" ? "a one-time code" : ni.kind === "captcha" ? "a quick human check" : "a sign-in";
          lines.push(`**${label(ni.marketplace)} needs you for a second.** It asked for ${what}. Open this link, finish it, and the search continues on its own (expires ${String(ni.expires_at ?? "").replace("T", " ").slice(0, 16)}): ${ni.live_view_url}`);
          if (results.length > 0) lines.push("", `Meanwhile, ${results.length} result${results.length === 1 ? "" : "s"} from ${done.map(label).join(", ")}:`, "", ...renderScoutRows(results));
          lines.push("", `When they're done, call \`firestarter_marketplace_search\` again with job_id \`${jobId}\`.`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
        }

        if (job?.status === "failed" && results.length === 0) {
          const why = job?.error_code === "SCOUT_ALL_SOURCES_FAILED"
            ? `no source returned results (${skipped.join("; ") || "all sources failed"})`
            : `${job?.error_message ?? job?.error_code ?? "unknown error"}`;
          lines.push(`**Marketplace search couldn't complete** — ${why}.`, "");
          if (skipped.some((s) => /not_connected|needs_login/.test(s))) lines.push("Connect or reconnect the marketplace with `firestarter_connect_marketplace`, then search again.");
          else lines.push("Try again in a moment, or a broader query.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
        }

        if (job?.status === "cancelled" || job?.status === "expired") {
          lines.push(`**Marketplace search ${job.status}.**${results.length ? ` ${results.length} results were collected before that:` : ""}`, "");
          if (results.length) lines.push(...renderScoutRows(results));
          return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
        }

        const stillRunning = !TERMINAL.has(job?.status);
        if (stillRunning) {
          lines.push(`**Still searching — ${done.length}/${total || done.length} sources back.** ${pending.map(label).join(", ") || "A source"} ${pending.length === 1 ? "is" : "are"} still running; nothing has failed. Call \`firestarter_marketplace_search\` again with job_id \`${jobId}\` in a few seconds to collect the rest.`);
        } else {
          const checkoutable = results.filter((r) => r?.checkoutable).length;
          lines.push(`**Marketplace search** — ${results.length} result${results.length === 1 ? "" : "s"} for "${sanitizeUntrusted(String(job?.query ?? query), 120)}" across ${done.map(label).join(", ") || "no sources"} (${checkoutable} checkoutable)`);
        }
        if (skipped.length) lines.push(`Skipped: ${skipped.join("; ")}.`);
        if (results.length === 0 && !stillRunning) {
          lines.push("", "No matches. Try a broader term, a different spelling, or raise max_price.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
        }
        lines.push("", ...renderScoutRows(results));
        lines.push("", "**To buy a Shopee or Lazada item:** open its Buy link — it lands in the marketplace app, where the buyer picks the variant and pays with what that app already has (ShopeePay, card, cash on delivery). Firestarter never touches their marketplace account. When they've paid, ask for the order number and record it with `firestarter_record_purchase` (source \"shopee\" or \"lazada\") so it shows in `firestarter_purchases`. **On Firestarter** items: buy with `firestarter_execute` using the listing id in the result.");
        const images = await inlineImageBlocks(results.slice(0, 8).map((r) => (typeof r?.image_url === "string" ? r.image_url : null)));
        return { content: [{ type: "text" as const, text: lines.join("\n") }, ...images], structuredContent };
      } catch (err: any) {
        if (err?.status === 404 && !scoutGateText(err)) {
          return { content: [{ type: "text" as const, text: `That search job wasn't found. Start a new search without job_id.` }], isError: true };
        }
        return gateOrError(err, "Marketplace search failed");
      }
    },
  );
}
