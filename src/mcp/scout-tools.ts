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
import { currencyExponent } from "./currency.js";
import { marketplaceCompareInputShape, marketplaceOutputShape, toMarketplaceStructured } from "./schemas.js";
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

/**
 * Wall-clock budget for one search call before handing back partial results.
 *
 * The default suits a host with a generous tool budget. A host with a short
 * one (Cole: 30 s per tool, and a timeout comes back with no job_id to re-poll)
 * passes `wait_ms` and gets what exists plus the job_id inside its budget.
 */
const MAX_SCOUT_WAIT_MS = 55_000;
const DEFAULT_SCOUT_WAIT_MS = Number(process.env.FIRESTARTER_MCP_SCOUT_WAIT_MS || MAX_SCOUT_WAIT_MS);
function scoutWaitMs(input: { wait_ms?: number }): number {
  return input.wait_ms == null ? DEFAULT_SCOUT_WAIT_MS : Math.min(input.wait_ms, MAX_SCOUT_WAIT_MS);
}
const POLL_MAX_CONSECUTIVE_ERRORS = 3;

/**
 * The budget bounds the WHOLE call, not just the loop. The clock starts before
 * the POST, and every read of the job is given `min(12 s, what is left)` —
 * 12 s being apiRequest's own default — so a slow POST cannot be followed by
 * a read that runs the call past the host's limit.
 *
 * A read is never given less than a floor: with under 2 s left, a real API
 * round-trip cannot complete, so no read starts. The floor shrinks with a
 * tiny budget (a quarter of it) only so a test-sized budget of 60 ms still
 * polls; at any real budget it is 2 s.
 */
const MAX_READ_TIMEOUT_MS = 12_000;
const MIN_READ_TIMEOUT_MS = 2_000;
function readTimeoutFloor(budgetMs: number): number {
  return Math.min(MIN_READ_TIMEOUT_MS, Math.max(1, Math.floor(budgetMs / 4)));
}

const MARKETPLACE_LABEL: Record<string, string> = { shopee: "Shopee", lazada: "Lazada", shopify: "Shopify stores", firestarter: "Firestarter" };
/** Storefront currency per scout country — what a captured card's price text is parsed in. */
const STOREFRONT_CURRENCY: Record<string, string> = { TH: "THB", MY: "MYR", SG: "SGD" };

/** What the compare route's `z.url()` will take: an absolute http(s) URL. */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
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

/**
 * How to buy, and what NOT to record. A checkout Firestarter itself ran is
 * recorded by its own /paid step; telling the agent to record it again
 * produced duplicate history rows. Only a purchase made outside Firestarter
 * (the buyer paying in the marketplace app) is recorded by hand, in MAJOR units.
 */
const RECORD_RULE = "Do NOT call firestarter_record_purchase for a checkout that Firestarter itself ran (its /paid step records it). Record only purchases made outside Firestarter, in MAJOR units (the row's `price:` line, e.g. 12.90 — never 1290).";
const BUY_PROSE = `**To buy:** open the Buy link in the person's own browser session and complete the purchase there. Each row says exactly what is left ("Then: …"): Shopify stores land on checkout with the item already added (pay only); Shopee and Lazada open the item in the app, where the buyer taps Buy Now and Place Order with what the app already has, plus a variant choice only when the row says so. Firestarter never touches their marketplace account. ${RECORD_RULE} **On Firestarter** items: buy with \`firestarter_execute\` using the listing id in the result.`;
/** Compare rows are only ever Lazada/Shopee cards from the person's own browser. */
const COMPARE_BUY_PROSE = `**To buy:** open the Buy link in the person's own browser session and complete the purchase there. ${RECORD_RULE}`;

/** Minor units → the prose price. Exponent-aware: /100 rendered ¥1290 as "JPY 12.90". */
function money(minor: unknown, currency: unknown): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  const code = typeof currency === "string" ? currency : "";
  const exp = currencyExponent(code);
  return `${code} ${(n / 10 ** exp).toFixed(exp)}`.trim();
}

function compact(n: unknown): string | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(Math.round(v));
}

/**
 * One row of the text block. Everything a text-only host needs is on its own
 * line — `id:`, `image:`, `price:` — because such a host (Cole) discards
 * structuredContent and image blocks and its model acts on the text alone.
 * The price line uses the same exponent-aware `money()` as the row header, so
 * the two never disagree.
 */
export function renderScoutRows(results: any[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const name = sanitizeUntrusted(String(r?.title ?? ""));
    const url = typeof r?.product_url === "string" ? r.product_url : null;
    const nameCell = url ? `[${name}](${url})` : name;
    const buy = typeof r?.buy_url === "string" ? r.buy_url : null;
    const steps: string[] = Array.isArray(r?.buy_steps) ? r.buy_steps.filter((s: unknown) => typeof s === "string") : [];
    const payOnly = steps.length === 1 && /^pay$/i.test(steps[0]);
    const tag = r?.checkoutable ? "✅ checkoutable" : r?.on_network ? "🏠 on Firestarter" : payOnly ? "💳 pay only" : buy ? `🛒 buy in app · ${steps.length || "?"} tap${steps.length === 1 ? "" : "s"}` : "👁 browse-only";
    const bits = [
      r?.rating != null ? `⭐ ${Number(r.rating).toFixed(1)}` : null,
      compact(r?.sold_count) ? `${compact(r.sold_count)} sold` : null,
      r?.location ? sanitizeUntrusted(String(r.location), 60) : null,
      r?.in_stock === false ? "out of stock" : null,
    ].filter(Boolean).join(" · ");
    const image = typeof r?.image_url === "string" && r.image_url ? r.image_url : null;
    lines.push(
      `- **${nameCell}** — ${money(r?.price_minor, r?.currency)} [${label(String(r?.source ?? ""))}] ${tag}` +
      `${bits ? `\n  ${bits}` : ""}${buy && buy !== url ? `\n  Buy: ${buy}` : ""}${steps.length ? `\n  Then: ${steps.join(" → ")}` : ""}\n  id: \`${String(r?.id ?? "")}\`` +
      `${image ? `\n  image: ${image}` : ""}\n  price: ${money(r?.price_minor, r?.currency)}`,
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

/**
 * Poll one job until it settles or the budget runs out.
 *
 * `startedAt` is when the CALL began — before any POST — so the budget is the
 * host's, not the loop's. `seed` is the job as the POST that created it
 * answered (null on a job_id re-poll): when the budget is spent before a
 * single read, a just-created job is handed back as the POST described it
 * rather than read again past the deadline, while a re-poll — whose entire
 * purpose is one read — always gets that read, at the floor timeout.
 */
async function pollScoutJob(
  apiRequest: ApiRequest,
  jobId: string,
  pollIntervalMs: number,
  budget: { startedAt: number; budgetMs: number },
  seed: any | null,
): Promise<any> {
  const path = `/v1/scout/jobs/${encodeURIComponent(jobId)}`;
  const deadline = budget.startedAt + budget.budgetMs;
  const floor = readTimeoutFloor(budget.budgetMs);
  const remaining = () => deadline - Date.now();
  const read = async (minMs: number) => {
    const res = await apiRequest("GET", path, undefined, Math.max(minMs, Math.min(MAX_READ_TIMEOUT_MS, remaining())));
    return res?.job ?? res;
  };
  let consecutiveErrors = 0;
  let last: any = null;
  while (remaining() > 0 && remaining() >= floor) {
    try {
      last = await read(floor);
      consecutiveErrors = 0;
      if (TERMINAL.has(last?.status) || PAUSED.has(last?.status)) return last;
    } catch (err: any) {
      if (err?.status === 404 || scoutGateText(err)) throw err;
      if (++consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) break;
    }
    // Never sleep past the deadline either.
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, remaining()))));
  }
  if (last) return last;
  if (seed && remaining() < floor) return seed;
  return read(MIN_READ_TIMEOUT_MS);
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
      description: "Search EXTERNAL marketplaces and the Firestarter catalog at once — Shopee (Thailand first; no login or connection needed — results come from localized Google Shopping filtered to shopee.co.th, or Shopee's affiliate API when the server has credentials), Lazada, seeded Shopify stores — and return one ranked comparison with photos, prices, ratings and sold counts, rendered like firestarter_catalog_search. Ranked by price, rating and popularity; on-network items get a small bonus. Each external row carries a Buy link that opens the item in that marketplace's app, where the buyer picks the variant and pays with what the app already holds; Firestarter never touches their account. The text block carries, per row, `id:`, `image:` (the photo URL) and `price:` (MAJOR units, e.g. `MYR 12.90`) lines, so a host that keeps only text has everything. Usually answers in seconds; if a source is still running you get what's back so far plus a `job_id:` line — call again with that job_id to collect the rest (never treat a partial answer as 'no results'). Hosts with a short tool budget pass wait_ms (Cole: ~20000) so the call returns inside it. Admin-only while the feature is proven. PRICES: each row's `price.amount_minor` is an INTEGER in the currency's ISO-4217 minor units (1290 with currency MYR is RM 12.90; the exponent is 0 for JPY/KRW/VND, so 1290 JPY is ¥1290), `current_price` is that same amount in MAJOR units and is what you quote the buyer. RECORDING: a purchase the buyer completes outside Firestarter (in the marketplace app, via the Buy link) is recorded with firestarter_record_purchase in MAJOR units — never for a checkout Firestarter itself ran, which its /paid step records; never pass `amount_minor` there.",
      inputSchema: {
        query: z.string().min(2).max(200).describe("What the buyer wants, in their words, e.g. 'cotton buds 200pcs' or 'สำลีก้าน'. Put price limits in max_price, not the query."),
        marketplaces: z.array(z.enum(["shopee", "lazada", "shopify", "firestarter"])).optional().describe("Restrict sources. Default: every connected marketplace plus Shopify stores and the Firestarter catalog."),
        country: z.string().length(2).optional().describe("Storefront country (MY, SG, TH). Default: the buyer's connected marketplace's country."),
        max_price: z.number().positive().optional().describe("Maximum price in the storefront currency (e.g. 15 for RM15 / ฿15)."),
        currency: z.string().length(3).optional().describe("Currency of max_price (MYR, SGD, THB). Default: the storefront's."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results per source (default 20)."),
        job_id: z.string().optional().describe("Re-poll an earlier search instead of starting a new one — pass the job_id from a partial result."),
        wait_ms: z.number().int().min(0).max(MAX_SCOUT_WAIT_MS).optional()
          .describe("How long to wait for results before returning what exists plus a job_id to re-poll. Hosts with a short tool budget (Cole: 30 s) should pass ~20000. The budget bounds the whole call — the search request and every read of the job — and when set, no image blocks are inlined (each row's `image:` line carries the photo URL instead)."),
      },
      outputSchema: marketplaceOutputShape,
      annotations: { title: "Search Marketplaces", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
    },
    async ({ query, marketplaces, country, max_price, currency, limit, job_id, wait_ms }: {
      query: string; marketplaces?: string[]; country?: string; max_price?: number; currency?: string; limit?: number; job_id?: string; wait_ms?: number;
    }) => {
      try {
        // The clock starts here, before the POST: wait_ms is the host's budget
        // for the whole call, and a slow POST comes out of it.
        const startedAt = Date.now();
        const budgetMs = scoutWaitMs({ wait_ms });
        let jobId = job_id;
        let seed: any | null = null;
        if (!jobId) {
          const body: Record<string, unknown> = { query };
          if (marketplaces?.length) body.marketplaces = marketplaces;
          if (country) body.country = country.toUpperCase();
          if (typeof max_price === "number") body.max_price_minor = Math.round(max_price * 100);
          if (currency) body.currency = currency.toUpperCase();
          if (typeof limit === "number") body.limit = limit;
          const created = await apiRequest("POST", "/v1/scout/search", body);
          seed = created?.job ?? created ?? null;
          jobId = String(seed?.id ?? "");
        }
        const job = await pollScoutJob(apiRequest, jobId, pollIntervalMs, { startedAt, budgetMs }, seed);
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
          lines.push("", `When they're done, call \`firestarter_marketplace_search\` again with job_id \`${jobId}\`.`, `job_id: ${jobId}`);
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
          lines.push(total
            ? `**Still searching — ${done.length}/${total} sources back.** ${pending.map(label).join(", ") || "A source"} ${pending.length === 1 ? "is" : "are"} still running; nothing has failed. Call \`firestarter_marketplace_search\` again with job_id \`${jobId}\` in a few seconds to collect the rest.`
            : `**Still searching — the search is queued and the wait budget ran out before a result could be read.** Call \`firestarter_marketplace_search\` again with job_id \`${jobId}\` in a few seconds.`);
        } else {
          const checkoutable = results.filter((r) => r?.checkoutable).length;
          lines.push(`**Marketplace search** — ${results.length} result${results.length === 1 ? "" : "s"} for "${sanitizeUntrusted(String(job?.query ?? query), 120)}" across ${done.map(label).join(", ") || "no sources"} (${checkoutable} checkoutable)`);
        }
        if (skipped.length) lines.push(`Skipped: ${skipped.join("; ")}.`);
        // The job_id on its own line, so a text-only host can re-poll without
        // parsing prose. Only while there is something to come back for.
        if (stillRunning) lines.push(`job_id: ${jobId}`);
        if (results.length === 0 && !stillRunning) {
          lines.push("", "No matches. Try a broader term, a different spelling, or raise max_price.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
        }
        if (results.length) lines.push("", ...renderScoutRows(results));
        lines.push("", BUY_PROSE);
        // wait_ms bounds the poll loop only; inlining is up to 3 image fetches
        // at 8 s each (plus redirect hops) AFTER it, which on a slow CDN turns
        // a 20 s budget into a 30 s host timeout — and the timeout loses the
        // job_id line with it. A host that passes wait_ms discards image
        // blocks anyway; the `image:` line per row is what it reads.
        const images = wait_ms == null
          ? await inlineImageBlocks(results.slice(0, 8).map((r) => (typeof r?.image_url === "string" ? r.image_url : null)))
          : [];
        return { content: [{ type: "text" as const, text: lines.join("\n") }, ...images], structuredContent };
      } catch (err: any) {
        if (err?.status === 404 && !scoutGateText(err)) {
          return { content: [{ type: "text" as const, text: `That search job wasn't found. Start a new search without job_id.` }], isError: true };
        }
        return gateOrError(err, "Marketplace search failed");
      }
    },
  );

  // Tool: firestarter_marketplace_compare
  //
  // The rows come from the person's OWN browser (Cole's browser_products, on
  // their signed-in session and residential exit — where Firestarter's own
  // Layer-1 search gets price-less Google hits). Firestarter's part is the
  // parsing and the ranking: one stateless POST, no job row, no polling, no
  // widget. Everything the model acts on is in the text block, rendered by the
  // same renderScoutRows as search so the two read identically.
  //
  // Every failure is a plain sentence with isError: false. The host this
  // exists for throws on isError, and a thrown refusal reaches its model as a
  // bare "Error:" with none of the guidance below.
  server.tool(
    "firestarter_marketplace_compare",
    "Rank product cards the person's OWN browser captured (browser_products) across Lazada and Shopee. Send the price text exactly as shown on the page; Firestarter parses it. Rows with no readable price are dropped, never priced 0. One stateless call — no job, no polling — answering `compared: <n> of <sent>` and then the same rows firestarter_marketplace_search renders: per row `id:`, `image:` (photo URL) and `price:` (MAJOR units, e.g. `THB 39.00`) lines, plus the Buy link. Use it whenever the person has a store open in their own browser; fall back to firestarter_marketplace_search only when they have no store to search in. Admin-only while the feature is proven; other callers get a plain refusal.",
    marketplaceCompareInputShape,
    { title: "Compare Captured Cards", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ country, items, max_price }) => {
      const plain = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });
      const cc = country ? country.toUpperCase() : undefined;
      const hasMax = typeof max_price === "number";

      // Drop here what the API would refuse outright, so one bad card never
      // costs the comparison. The route 400s the WHOLE batch on: a blank price
      // (browser_products emits "" for a card with no price shown), a store it
      // does not know, a blank title, a url or image_url that is not a URL.
      // Every drop is counted and named in the header; an unusable image_url
      // is simply omitted (never sent as ""), since the card itself is fine.
      const sendable: any[] = [];
      let unpriced = 0;
      let unsupported = 0;
      let unaddressed = 0;
      for (const it of items ?? []) {
        const marketplace = String(it?.marketplace ?? "").trim().toLowerCase();
        if (marketplace !== "lazada" && marketplace !== "shopee") { unsupported++; continue; }
        const title = String(it?.title ?? "").trim();
        const url = String(it?.url ?? "").trim();
        if (!title || !isHttpUrl(url)) { unaddressed++; continue; }
        if (!String(it?.price_text ?? "").trim()) { unpriced++; continue; }
        const { image_url, ...rest } = it;
        const image = typeof image_url === "string" && isHttpUrl(image_url.trim()) ? image_url.trim() : null;
        sendable.push({ ...rest, marketplace, title, url, ...(image ? { image_url: image } : {}) });
      }
      const sent = items?.length ?? 0;
      const header = (apiDropped: number) => {
        const noPrice = unpriced + apiDropped;
        const parts = [
          noPrice ? `${noPrice} with no readable price${hasMax ? " or above max_price" : ""}` : null,
          unaddressed ? `${unaddressed} with no title/url` : null,
          unsupported ? `${unsupported} from an unsupported marketplace` : null,
        ].filter(Boolean);
        return `compared: ${sent - noPrice - unaddressed - unsupported} of ${sent}${parts.length ? ` (dropped ${parts.join("; ")})` : ""}`;
      };
      const nothingToRank = (apiDropped: number) => {
        const why = unpriced + apiDropped
          ? `None of the cards had a readable price${hasMax ? " at or under max_price" : ""}${unsupported || unaddressed ? " (the rest lacked a title, a URL, or a supported marketplace)" : ""}`
          : unaddressed
            ? "None of the cards had both a title and a product URL"
            : "None of the cards came from a supported marketplace (lazada, shopee)";
        return `${why}, so there is nothing to rank. Send each price EXACTLY as the page shows it (e.g. ฿29, RM12.90, 1,290), or search with \`firestarter_marketplace_search\`.`;
      };

      if (sent === 0) return plain("compared: 0 of 0\n\nNothing to compare — send at least one card from browser_products (marketplace, title, price text as shown, url).");
      if (sendable.length === 0) return plain(`${header(0)}\n\n${nothingToRank(0)}`);

      const body: Record<string, unknown> = { items: sendable };
      if (cc) body.country = cc;
      if (hasMax) {
        // MY/SG/TH are all exponent-2 today; the exponent table keeps this
        // honest if a zero-decimal storefront is ever added.
        body.max_price_minor = Math.round(max_price * 10 ** currencyExponent(STOREFRONT_CURRENCY[cc ?? ""]));
      }
      try {
        const res = await apiRequest("POST", "/v1/scout/compare", body);
        // A 200 without a result list (a proxy's JSON page, a wrong route) is
        // a failure. Rendering it as "dropped N with no readable price" would
        // be a false statement about the cards.
        if (!Array.isArray(res?.options)) {
          return plain("Couldn't compare the cards: the API answered without a result list. Nothing was ranked; try again in a moment.");
        }
        const options: any[] = res.options;
        const count = Number.isInteger(res?.count) ? res.count : options.length;
        const apiDropped = Math.max(0, sendable.length - count);
        const lines: string[] = [header(apiDropped)];
        if (options.length === 0) {
          lines.push("", nothingToRank(apiDropped));
          return plain(lines.join("\n"));
        }
        lines.push("", ...renderScoutRows(options), "", COMPARE_BUY_PROSE);
        return plain(lines.join("\n"));
      } catch (err: any) {
        const gate = scoutGateText(err);
        if (gate) return plain(gate);
        if (err?.status === 404) {
          return plain("This Firestarter API doesn't have marketplace compare yet (it needs POST /v1/scout/compare). Rank the cards by price yourself for now, or use `firestarter_marketplace_search`.");
        }
        return plain(`Couldn't compare the cards: ${toErrorMessage(err)}. Nothing was ranked; fix the input or try again in a moment.`);
      }
    },
  );
}
