/**
 * Marketplace scout tools (#1056): firestarter_marketplaces,
 * firestarter_connect_marketplace, firestarter_marketplace_search.
 *
 * Contract: the gate refusals render as plain prose (never a raw error); a
 * connect returns the live-view link; a search POSTs once, polls, and NEVER
 * reads a partial answer as "no results"; needs_input hands the buyer the link;
 * structuredContent is schema-valid on every non-error path; the list tool
 * issues only GETs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.hoisted(() => {
  process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS = "1";
  process.env.FIRESTARTER_MCP_SCOUT_WAIT_MS = "60";
});

import { registerTools } from "../../src/mcp/tools.js";
import { marketplaceCompareInputShape, marketplaceOutputSchema, toMarketplaceStructured } from "../../src/mcp/schemas.js";
import { renderScoutRows } from "../../src/mcp/scout-tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools({ tool: (...args: any[]) => { tools[args[0] as string] = args[args.length - 1] as ToolHandler; } } as any, "fsk_test", "http://api.test");
  return tools;
}

/**
 * Call a tool THROUGH the SDK, the way a host does. captureTools() hands the
 * handler back directly and so bypasses the SDK's input validation — which is
 * exactly the layer that can reject a call before the handler's plain-sentence
 * refusals ever run (mcp.js: `McpError InvalidParams` on any Zod failure).
 */
async function callViaSdk(name: string, args: Record<string, unknown>): Promise<any> {
  const server = new McpServer({ name: "scout-probe", version: "0.0.0" });
  registerTools(server as any, "fsk_test", "http://api.test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** The description a client reads for one tool — the prose that steers the agent. */
function describeOf(name: string): string {
  let out = "";
  registerTools({ tool: (n: string, description: string) => { if (n === name) out = description; } } as any, "fsk_test", "http://api.test");
  return out;
}

type Route = (method: string, url: string, body: any, n: number) => { status?: number; data: any };

function mockFetch(route: Route) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const out = route(method, String(url), body, calls.length);
    return new Response(JSON.stringify(out.data), { status: out.status ?? 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const textOf = (res: any) => res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const CLAIMS_NO_RESULTS = /no (results|matches)|nothing found|couldn't find/i;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * A clock the test advances by hand, plus a record of every request timeout
 * apiRequest asked for (it builds `AbortSignal.timeout(ms)` per call). Lets a
 * test say "the POST took 15 s" without waiting 15 s, and see what budget the
 * next GET was given.
 */
function fakeClock(startAt = 1_000_000) {
  const clock = { now: startAt, timeouts: [] as number[] };
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { clock.timeouts.push(ms); return new AbortController().signal; });
  return clock;
}

const RESULT = {
  id: "shopee:55501:1234567890", source: "shopee", on_network: false, checkoutable: true,
  title: "Watsons Cotton Buds 200pcs", price_minor: 1290, currency: "MYR", price_usd: 3.87,
  image_url: "https://down-my.img.susercontent.com/file/abc", media: [], product_url: "https://shopee.com.my/product/55501/1234567890",
  seller_name: "Watsons Malaysia", seller_domain: "shopee.com.my", rating: 4.87, sold_count: 8421,
  shipping_estimate: null, location: "Selangor", in_stock: true, variant_hint: null, raw: {},
};
const NET = { ...RESULT, id: "firestarter:lst_1", source: "firestarter", on_network: true, checkoutable: false, title: "Network Cotton Buds", product_url: "https://firestarter.network/l/lst_1", image_url: null };

function job(over: Record<string, unknown> = {}) {
  return {
    id: "scj_1", kind: "search", status: "completed", environment: "live", query: "cotton buds",
    params: {}, progress: { shopee: "done", lazada: "not_connected", shopify: "done", firestarter: "cached" },
    results: [RESULT, NET], count: 2, needs_input: null, review: null, consent_nonce: null, error_code: null, error_message: null,
    sessions: {}, ...over,
  };
}

describe("firestarter_marketplaces", () => {
  it("lists connection state and only GETs", async () => {
    const calls = mockFetch(() => ({ data: {
      marketplaces: [
        { marketplace: "shopee", country: "TH", status: "connected", connected: true, currency: "THB", last_verified_at: "2026-09-02T01:00:00Z" },
        { marketplace: "lazada", country: null, status: "disconnected", connected: false, currency: "" },
      ],
      supported: [{ marketplace: "shopee", countries: [{ country: "MY" }, { country: "SG" }, { country: "TH" }] }],
    } }));
    const res = await captureTools().firestarter_marketplaces({});
    const text = textOf(res);
    expect(text).toContain("Shopee");
    expect(text).toContain("connected (TH, THB)");
    expect(text).toContain("Lazada");
    expect(text).toContain("not connected");
    expect(text).toContain("MY, SG, TH");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("renders the gate refusals as prose, not raw errors", async () => {
    mockFetch(() => ({ status: 403, data: { error: "Marketplace buying is limited to Firestarter admins right now.", code: "STAFF_ONLY", status: 403 } }));
    let res = await captureTools().firestarter_marketplaces({});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/limited to Firestarter admins/);
    expect(textOf(res)).toContain("firestarter_catalog_search");

    mockFetch(() => ({ status: 404, data: { error: "Marketplace buying isn't enabled on this API.", code: "SCOUT_DISABLED", status: 404 } }));
    res = await captureTools().firestarter_marketplaces({});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/isn't enabled on this API/);
  });
});

describe("firestarter_connect_marketplace", () => {
  it("starts a connect and hands back the sign-in link", async () => {
    const calls = mockFetch(() => ({ status: 202, data: { connection: { marketplace: "shopee", country: "TH", status: "pending" }, live_view_url: "https://live/abc", expires_at: "2026-09-02T10:10:00.000Z" } }));
    const res = await captureTools().firestarter_connect_marketplace({ marketplace: "shopee", country: "th", mobile: true });
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://api.test/v1/marketplaces/shopee/connect", body: { country: "TH", mobile: true } });
    const text = textOf(res);
    expect(text).toContain("https://live/abc");
    expect(text).toMatch(/Sign in to Shopee/);
    expect(text).toMatch(/Nothing you type there reaches Firestarter/);
  });

  it("verifies, and on NOT_LOGGED_IN relays the fresh link", async () => {
    let calls = mockFetch(() => ({ data: { connection: { marketplace: "lazada", country: "MY", status: "connected", connected: true } } }));
    let res = await captureTools().firestarter_connect_marketplace({ marketplace: "lazada", verify: true });
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://api.test/v1/marketplaces/lazada/verify" });
    expect(textOf(res)).toMatch(/Lazada connected/);

    calls = mockFetch(() => ({ status: 409, data: { error: "Lazada still shows the sign-in page.", code: "NOT_LOGGED_IN", status: 409, live_view_url: "https://live/again", expires_at: "x" } }));
    res = await captureTools().firestarter_connect_marketplace({ marketplace: "lazada", verify: true });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("https://live/again");
  });

  it("asks for a country when the API says the request was invalid", async () => {
    mockFetch(() => ({ status: 400, data: { error: "country is required", code: "INVALID_REQUEST", status: 400 } }));
    const res = await captureTools().firestarter_connect_marketplace({ marketplace: "shopee" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/MY, SG or TH/);
  });
});

describe("firestarter_marketplace_search", () => {
  it("POSTs once, polls to completion, and renders a ranked comparison with structuredContent", async () => {
    const calls = mockFetch((method, url, body, n) => {
      if (method === "POST") {
        expect(body).toMatchObject({ query: "cotton buds", max_price_minor: 1500, currency: "MYR", limit: 10 });
        return { status: 202, data: { job: job({ status: "queued", results: [], progress: { shopee: "queued" } }) } };
      }
      // first poll running, then completed
      return { data: { job: n < 3 ? job({ status: "running", results: [RESULT], progress: { shopee: "done", firestarter: "running" } }) : job() } };
    });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", max_price: 15, currency: "myr", limit: 10 });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2);
    const text = textOf(res);
    expect(text).toMatch(/Marketplace search/);
    expect(text).toContain("[Watsons Cotton Buds 200pcs](https://shopee.com.my/product/55501/1234567890)");
    expect(text).toContain("MYR 12.90");
    expect(text).toContain("✅ checkoutable");
    expect(text).toContain("🏠 on Firestarter");
    expect(text).toContain("8.4k sold");
    expect(text).toContain("Skipped: Lazada (not_connected)");
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
    expect(() => marketplaceOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.options).toHaveLength(2);
    expect(res.structuredContent.options[0]).toMatchObject({ rank: 1, purchasable: true, source: "shopee", price: { currency: "MYR", amount_minor: 1290 } });
    expect(res.structuredContent.options[1].blockers[0].code).toBe("ON_NETWORK");
    expect(res.structuredContent.cached_sources).toEqual(["firestarter"]);
  });

  it("hands back partial results with the job_id when the budget runs out, never claiming no results", async () => {
    mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ status: "queued", results: [] }) } }
      : { data: { job: job({ status: "running", results: [RESULT], progress: { shopee: "done", lazada: "running" } }) } });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds" });
    const text = textOf(res);
    expect(text).toMatch(/Still searching — 1\/2 sources back/);
    expect(text).toContain("scj_1");
    expect(text).toContain("Watsons Cotton Buds");
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
    expect(res.isError).toBeFalsy();
    expect(() => marketplaceOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.status).toBe("running");
  });

  it("re-polls an existing job_id without starting a new search", async () => {
    const calls = mockFetch(() => ({ data: { job: job() } }));
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", job_id: "scj_1" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0].url).toBe("http://api.test/v1/scout/jobs/scj_1");
    expect(textOf(res)).toContain("2 results");
  });

  it("relays a needs_input pause with the live-view link and keeps partial rows", async () => {
    mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ status: "queued", results: [] }) } }
      : { data: { job: job({ status: "needs_input", results: [NET], progress: { shopee: "running", firestarter: "done" }, needs_input: { kind: "otp", marketplace: "shopee", live_view_url: "https://live/otp", expires_at: "2026-09-02T10:05:00Z" } }) } });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds" });
    const text = textOf(res);
    expect(text).toMatch(/Shopee needs you for a second/);
    expect(text).toContain("one-time code");
    expect(text).toContain("https://live/otp");
    expect(text).toContain("Network Cotton Buds");
    expect(text).toContain("job_id `scj_1`");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.needs_input).toMatchObject({ kind: "otp", marketplace: "shopee" });
  });

  it("explains a failed search and points at connect when nothing was connected", async () => {
    mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ status: "queued", results: [] }) } }
      : { data: { job: job({ status: "failed", results: [], error_code: "SCOUT_ALL_SOURCES_FAILED", progress: { shopee: "not_connected", lazada: "needs_login" } }) } });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds" });
    const text = textOf(res);
    expect(text).toMatch(/couldn't complete/);
    expect(text).toContain("firestarter_connect_marketplace");
    expect(() => marketplaceOutputSchema.parse(res.structuredContent)).not.toThrow();
  });

  it("renders the admin gate as prose on the first POST", async () => {
    mockFetch(() => ({ status: 403, data: { error: "nope", code: "STAFF_ONLY", status: 403 } }));
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/limited to Firestarter admins/);
  });
});

/* ─── Text-only hosts (Cole) ─────────────────────────────────────────────────
 *
 * Cole keeps only the text blocks of a tool result — structuredContent, image
 * blocks and widget metadata are discarded — and its per-tool budget is 30 s,
 * after which the call is a timeout with no job_id to come back for. So the
 * search must (a) hand back inside a caller-chosen budget and (b) put every
 * fact the model acts on into the text: the job_id on its own line, and per
 * row the image URL and a major-unit price.
 */
describe("firestarter_marketplace_search for a text-only host", () => {
  const LAZADA = { ...RESULT, id: "lazada:1", source: "lazada", checkoutable: false, title: "Cotton buds 300", price_minor: 1290, currency: "MYR", image_url: "https://img.test/1.jpg", product_url: "https://lazada.test/1" };

  it("honours wait_ms and prints the job_id on its own line when the job is still running", async () => {
    // The file's default budget is 60 ms (env above); wait_ms must override it
    // in BOTH directions — lengthened here, shortened (Cole's direction) in the
    // wait_ms: 0 case below.
    mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ id: "job_1", status: "running", results: [], progress: { lazada: "running" } }) } }
      : { data: { job: job({ id: "job_1", status: "running", results: [], progress: { lazada: "running" } }) } });
    const started = Date.now();
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 300 });
    const elapsed = Date.now() - started;
    // The loop stops once less than a read's floor timeout remains (a quarter
    // of a budget this small), so it runs ~225 ms of the 300, never past it.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(3000);
    const text = textOf(res);
    expect(text).toMatch(/^job_id: job_1$/m);
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
    expect(res.isError).toBeFalsy();
  });

  it("wait_ms: 0 makes exactly one POST and no GET, and still prints the job_id line", async () => {
    // Cole's actual direction, and deterministic: the POST's own answer IS the
    // job as it stands, so with no budget left there is nothing a read would
    // add — hand back what the POST said plus the job_id to come back for.
    const calls = mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ id: "job_0", status: "queued", results: [], progress: { lazada: "queued" } }) } }
      : { data: { job: job({ id: "job_0", status: "running", results: [], progress: { lazada: "running" } }) } });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 0 });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(textOf(res)).toMatch(/Still searching/);
    expect(textOf(res)).toMatch(/^job_id: job_0$/m);
    expect(textOf(res)).not.toMatch(CLAIMS_NO_RESULTS);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ job_id: "job_0", status: "queued" });
  });

  it("a re-poll with wait_ms: 0 still reads the job exactly once — that read is the point of the call", async () => {
    const clock = fakeClock();
    const calls = mockFetch(() => ({ data: { job: job() } }));
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", job_id: "scj_1", wait_ms: 0 });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    // Nothing left of a zero budget, so the one read gets the floor timeout,
    // never 0 ms (which would abort before the API could answer).
    expect(clock.timeouts).toEqual([2000]);
    expect(textOf(res)).toContain("2 results");
  });

  it("the budget covers the POST: a 15 s POST leaves the first GET at most 5 s of a 20 s budget", async () => {
    const clock = fakeClock();
    const calls = mockFetch((method) => {
      if (method === "POST") {
        clock.now += 15_000;
        return { status: 202, data: { job: job({ id: "job_slow", status: "queued", results: [], progress: { lazada: "queued" } }) } };
      }
      clock.now += 4_000; // the read itself takes 4 s; 1 s left afterwards
      return { data: { job: job({ id: "job_slow", status: "running", results: [RESULT], progress: { lazada: "done", shopee: "running" } }) } };
    });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 20_000 });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    // [POST's own default, first GET bounded by what the POST left]
    expect(clock.timeouts).toHaveLength(2);
    expect(clock.timeouts[1]).toBeLessThanOrEqual(5_000);
    expect(clock.timeouts[1]).toBeGreaterThanOrEqual(2_000);
    // With 1 s left no further read starts — 1 s is under the floor — and
    // what was read is handed back with the job_id.
    expect(clock.now - 1_000_000).toBeLessThanOrEqual(20_000);
    const text = textOf(res);
    expect(text).toMatch(/Still searching — 1\/2 sources back/);
    expect(text).toContain("Watsons Cotton Buds");
    expect(text).toMatch(/^job_id: job_slow$/m);
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
  });

  it("a POST that eats 19 s of a 20 s budget makes no GET at all and still prints job_id", async () => {
    const clock = fakeClock();
    const calls = mockFetch((method) => {
      if (method === "POST") {
        clock.now += 19_000;
        return { status: 202, data: { job: job({ id: "job_slower", status: "queued", results: [], progress: { lazada: "queued" } }) } };
      }
      throw new Error("no GET may start with under 2 s left");
    });
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 20_000 });
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(clock.now - 1_000_000).toBeLessThanOrEqual(20_000);
    const text = textOf(res);
    expect(text).toMatch(/Still searching/);
    expect(text).toMatch(/^job_id: job_slower$/m);
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
    expect(res.isError).toBeFalsy();
    expect(() => marketplaceOutputSchema.parse(res.structuredContent)).not.toThrow();
  });

  it("never lets a poll read run past the 12 s API ceiling even with a long budget", async () => {
    const clock = fakeClock();
    mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ id: "j", status: "queued", results: [] }) } }
      : { data: { job: job({ id: "j" }) } });
    await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 55_000 });
    // [POST default, one GET that completed the job]
    expect(clock.timeouts).toEqual([12_000, 12_000]);
  });

  it("skips image inlining when wait_ms is set — the budget must bound the whole call", async () => {
    // Image inlining is up to 3 fetches at 8 s each behind the poll budget; a
    // slow CDN redirect chain on top of wait_ms: 20000 blows Cole's 30 s and
    // loses the job_id with it. The host that passes wait_ms discards image
    // blocks anyway; the `image:` line per row is what it reads.
    const completed = () => ({ status: 202, data: { job: job({ results: [LAZADA], progress: { lazada: "done" } }) } });
    let calls = mockFetch(completed);
    let res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 1000 });
    expect(calls.every((c) => c.url.startsWith("http://api.test/"))).toBe(true);
    expect(res.content.every((b: any) => b.type === "text")).toBe(true);
    expect(textOf(res)).toMatch(/^  image: https:\/\/img\.test\/1\.jpg$/m);

    // Control: without wait_ms the photo is still fetched for hosts that render it.
    calls = mockFetch(completed);
    res = await captureTools().firestarter_marketplace_search({ query: "cotton buds" });
    expect(calls.some((c) => c.url === "https://img.test/1.jpg")).toBe(true);
  });

  it("prints image and major-unit price lines per row, after the id line", async () => {
    mockFetch(() => ({ status: 202, data: { job: job({ results: [LAZADA, NET], progress: { lazada: "done", firestarter: "done" } }) } }));
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds" });
    const text = textOf(res);
    expect(text).toMatch(/image: https:\/\/img\.test\/1\.jpg/);
    // One formatter for every price in the text block: the row header and the
    // price line agree, code first (money()).
    expect(text).toMatch(/^  price: MYR 12\.90$/m);
    expect(text.indexOf("id: `lazada:1`")).toBeLessThan(text.indexOf("image: https://img.test/1.jpg"));
    expect(text.indexOf("image: https://img.test/1.jpg")).toBeLessThan(text.indexOf("price: MYR 12.90"));
    // A row with no image gets no image line — never "image: null".
    expect(text).not.toMatch(/image: null/);
    expect(text).not.toMatch(/image: undefined/);
  });

  it("no longer tells the agent to record_purchase after a Firestarter-run checkout", async () => {
    mockFetch(() => ({ status: 202, data: { job: job() } }));
    const res = await captureTools().firestarter_marketplace_search({ query: "x" });
    const text = textOf(res);
    // The old instruction: "When they've paid ... record it with firestarter_record_purchase".
    expect(text).not.toMatch(/record it with `firestarter_record_purchase`/);
    expect(text).not.toMatch(/ask for the order number/);
    expect(text).toMatch(/Do NOT call firestarter_record_purchase for a checkout that Firestarter itself ran/);
    expect(text).toMatch(/MAJOR units/);
  });

  it("states the record_purchase rule in both tool descriptions", () => {
    const search = describeOf("firestarter_marketplace_search");
    expect(search).not.toMatch(/After they pay, record the order with firestarter_record_purchase/);
    expect(search).toMatch(/never for a checkout Firestarter itself ran/i);
    const record = describeOf("firestarter_record_purchase");
    expect(record).toMatch(/MAJOR units/);
    expect(record).toMatch(/never for a checkout Firestarter itself ran/i);
  });
});

/* ─── firestarter_marketplace_compare ────────────────────────────────────────
 *
 * The rows come from the person's OWN browser (Cole's browser_products); the
 * tool sends them to POST /v1/scout/compare, which parses the price text,
 * drops what it cannot price, ranks, and answers `{ count, options }` in one
 * stateless call. No job, no polling, no widget. Every refusal is a plain
 * sentence with isError false — Cole's client throws on isError.
 */
describe("firestarter_marketplace_compare", () => {
  const CARDS = [
    { marketplace: "lazada", title: "Cotton buds 100", price_text: "฿29", url: "https://www.lazada.co.th/products/x-i1.html", image_url: "https://img.test/l1.jpg", sold_text: "ขายแล้ว 1.2พัน" },
    { marketplace: "shopee", title: "Cotton buds 300", price_text: "39 บาท", url: "https://shopee.co.th/a-i.1.2", image_url: "https://img.test/s1.jpg", sold_text: "2.5k sold", rating: 4.8 },
    { marketplace: "shopee", title: "Bundle", price_text: "1,290", url: "https://shopee.co.th/b-i.3.4" },
  ];
  /** What the API answers for CARDS: same row shape as a search result, in ITS order. */
  const OPTIONS = [
    { id: "shopee:1:2", source: "shopee", title: "Cotton buds 300", price_minor: 3900, currency: "THB", image_url: "https://img.test/s1.jpg", product_url: "https://shopee.co.th/a-i.1.2", buy_url: "https://shopee.co.th/a-i.1.2", sold_count: 2500, rating: 4.8, checkoutable: false, on_network: false },
    { id: "lazada:1", source: "lazada", title: "Cotton buds 100", price_minor: 2900, currency: "THB", image_url: "https://img.test/l1.jpg", product_url: "https://www.lazada.co.th/products/x-i1.html", buy_url: "https://www.lazada.co.th/products/x-i1.html", sold_count: 1200, rating: null, checkoutable: false, on_network: false },
    { id: "shopee:3:4", source: "shopee", title: "Bundle", price_minor: 129000, currency: "THB", image_url: null, product_url: "https://shopee.co.th/b-i.3.4", buy_url: "https://shopee.co.th/b-i.3.4", sold_count: null, rating: null, checkoutable: false, on_network: false },
  ];

  it("POSTs the cards once and renders the rows in the API's order under a compared: header", async () => {
    const calls = mockFetch((method, url, body) => {
      expect(method).toBe("POST");
      expect(url).toBe("http://api.test/v1/scout/compare");
      expect(body).toMatchObject({ country: "TH", items: CARDS });
      expect(body.max_price_minor).toBeUndefined();
      return { data: { count: 3, options: OPTIONS } };
    });
    const res = await captureTools().firestarter_marketplace_compare({ country: "th", items: CARDS });
    expect(calls).toHaveLength(1);
    const text = textOf(res);
    expect(text).toMatch(/^compared: 3 of 3$/m);
    // The API ranked; the tool does not reorder.
    expect(text.indexOf("Cotton buds 300")).toBeLessThan(text.indexOf("Cotton buds 100"));
    expect(text.indexOf("Cotton buds 100")).toBeLessThan(text.indexOf("Bundle"));
    // Same per-row lines as search, so the two read identically to the model.
    expect(text).toMatch(/^  id: `shopee:1:2`$/m);
    expect(text).toMatch(/^  image: https:\/\/img\.test\/s1\.jpg$/m);
    expect(text).toMatch(/^  price: THB 39\.00$/m);
    expect(text).toMatch(/^  price: THB 1290\.00$/m);
    expect(text).toContain("2.5k sold");
    expect(text).not.toMatch(/image: null/);
    expect(res.isError).toBeFalsy();
    expect(res.content.every((b: any) => b.type === "text")).toBe(true);
  });

  it("says how many rows were dropped for having no readable price", async () => {
    mockFetch(() => ({ data: { count: 2, options: OPTIONS.slice(0, 2) } }));
    const res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: [...CARDS.slice(0, 2), { ...CARDS[2], price_text: "ราคาพิเศษ" }] });
    const text = textOf(res);
    expect(text).toMatch(/^compared: 2 of 3 \(dropped 1 with no readable price\)$/m);
    expect(text).not.toContain("Bundle");
    expect(res.isError).toBeFalsy();
  });

  it("converts max_price to storefront minor units with the currency exponent", async () => {
    const calls = mockFetch(() => ({ data: { count: 1, options: OPTIONS.slice(1, 2) } }));
    await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS, max_price: 30 });
    expect(calls[0].body).toMatchObject({ country: "TH", max_price_minor: 3000 });
  });

  it("renders a 4xx as a plain sentence with isError false", async () => {
    mockFetch(() => ({ status: 403, data: { error: "nope", code: "STAFF_ONLY", status: 403 } }));
    let res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/limited to Firestarter admins/);

    mockFetch(() => ({ status: 400, data: { error: "items: at least one item is required", code: "INVALID_REQUEST", status: 400 } }));
    res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/at least one item is required/);

    // An API deployed before /v1/scout/compare existed: say so, plainly.
    mockFetch(() => ({ status: 404, data: { error: "Not found", status: 404 } }));
    res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/doesn't have marketplace compare yet/);
  });

  it("answers an empty comparison honestly", async () => {
    mockFetch(() => ({ data: { count: 0, options: [] } }));
    const res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: [{ ...CARDS[2], price_text: "ราคาพิเศษ" }] });
    const text = textOf(res);
    expect(text).toMatch(/^compared: 0 of 1 \(dropped 1 with no readable price\)$/m);
    expect(text).toMatch(/none of the cards had a readable price/i);
    expect(res.isError).toBeFalsy();
  });

  /* One bad card must never cost the whole comparison. browser_products types
   * `price` as a non-nullable string, so a card with price "" is routine; the
   * SDK enforces the Zod shape BEFORE the handler and answers any failure as an
   * `isError: true` result carrying "MCP error -32602" text, which the host
   * throws on — so these go through the real SDK, not the stub. */
  it("tolerates an unpriced card through the SDK: 5 cards, one with price_text '' → compared: 4 of 5", async () => {
    const FOUR = [...OPTIONS, { ...OPTIONS[0], id: "lazada:9", title: "Cotton buds 500", price_minor: 4900, image_url: null }];
    const calls = mockFetch((method, url, body) => {
      expect(url).toBe("http://api.test/v1/scout/compare");
      // The blank-price card is not the API's problem: it is dropped here.
      expect(body.items).toHaveLength(4);
      expect(body.items.every((it: any) => it.price_text.trim().length > 0)).toBe(true);
      return { data: { count: 4, options: FOUR } };
    });
    const res = await callViaSdk("firestarter_marketplace_compare", {
      country: "TH",
      items: [...CARDS, { marketplace: "lazada", title: "Cotton buds 500", price_text: "฿49", url: "https://www.lazada.co.th/products/y-i9.html" }, { marketplace: "shopee", title: "No price shown", price_text: "", url: "https://shopee.co.th/c-i.5.6" }],
    });
    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/^compared: 4 of 5 \(dropped 1 with no readable price\)$/m);
    expect(text).toContain("Cotton buds 500");
    expect(text).not.toContain("No price shown");
  });

  it("drops a card from an unsupported marketplace through the SDK instead of failing the call, and forgives case", async () => {
    const calls = mockFetch(() => ({ data: { count: 2, options: OPTIONS.slice(0, 2) } }));
    const res = await callViaSdk("firestarter_marketplace_compare", {
      country: "TH",
      items: [
        { ...CARDS[0], marketplace: "Lazada" },
        CARDS[1],
        { marketplace: "amazon", title: "Bundle", price_text: "$12.00", url: "https://amazon.com/dp/x" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.items.map((it: any) => it.marketplace)).toEqual(["lazada", "shopee"]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^compared: 2 of 3 \(dropped 1 from an unsupported marketplace\)$/m);
  });

  it("reports both drop reasons when both apply", async () => {
    mockFetch(() => ({ data: { count: 1, options: OPTIONS.slice(1, 2) } }));
    const res = await captureTools().firestarter_marketplace_compare({
      country: "TH",
      items: [CARDS[0], { ...CARDS[1], price_text: "ราคาพิเศษ" }, { ...CARDS[2], marketplace: "tokopedia" }],
    });
    expect(textOf(res)).toMatch(/^compared: 1 of 3 \(dropped 1 with no readable price; 1 from an unsupported marketplace\)$/m);
  });

  it("says so plainly, without calling the API, when nothing can be sent", async () => {
    const calls = mockFetch(() => ({ data: { count: 0, options: [] } }));
    let res = await callViaSdk("firestarter_marketplace_compare", { country: "TH", items: [] });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^compared: 0 of 0$/m);
    expect(textOf(res)).toMatch(/at least one card/i);

    res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: [{ ...CARDS[0], price_text: " " }, { ...CARDS[1], marketplace: "amazon" }] });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^compared: 0 of 2 \(dropped 1 with no readable price; 1 from an unsupported marketplace\)$/m);
    expect(textOf(res)).toMatch(/nothing to rank/i);
    expect(calls).toHaveLength(0);
  });

  /* The API route (firestarter-commerce routes/scout.ts) requires a non-blank
   * title, `url` and any present `image_url` to be URLs, and price_text ≤ 80 —
   * and 400s the WHOLE batch on one bad card. So the same "drop the card, not
   * the batch" rule covers those too, and an empty image_url is omitted rather
   * than sent as "". */
  it("drops blank-title and non-URL cards, omits an empty image_url, and keeps the rest: compared: 3 of 5", async () => {
    const THREE = OPTIONS;
    const calls = mockFetch((method, url, body) => {
      expect(body.items).toHaveLength(3);
      for (const it of body.items) {
        expect(it.title.trim().length).toBeGreaterThan(0);
        expect(it.url).toMatch(/^https:\/\//);
        if ("image_url" in it) expect(it.image_url).toMatch(/^https?:\/\//);
      }
      // The card whose image_url was "" travels without the key at all.
      expect(body.items.find((it: any) => it.title === "Cotton buds 300")).not.toHaveProperty("image_url");
      return { data: { count: 3, options: THREE } };
    });
    const res = await captureTools().firestarter_marketplace_compare({
      country: "TH",
      items: [
        CARDS[0],
        { ...CARDS[1], image_url: "" },
        { ...CARDS[2], image_url: "not a url" },
        { marketplace: "lazada", title: "   ", price_text: "฿19", url: "https://www.lazada.co.th/products/blank-i2.html" },
        { marketplace: "shopee", title: "Priceless", price_text: "", url: "https://shopee.co.th/p-i.7.8" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^compared: 3 of 5 \(dropped 1 with no readable price; 1 with no title\/url\)$/m);
  });

  it("drops a card whose url is not a URL, counted with the blank titles", async () => {
    const calls = mockFetch(() => ({ data: { count: 2, options: OPTIONS.slice(0, 2) } }));
    const res = await captureTools().firestarter_marketplace_compare({
      country: "TH",
      items: [CARDS[0], CARDS[1], { ...CARDS[2], url: "lazada.co.th/products/no-scheme" }],
    });
    expect(calls[0].body.items).toHaveLength(2);
    expect(textOf(res)).toMatch(/^compared: 2 of 3 \(dropped 1 with no title\/url\)$/m);
  });

  it("caps price_text at the API's 80 characters on the wire", () => {
    const schema = z.toJSONSchema(z.object(marketplaceCompareInputShape)) as any;
    expect(schema.properties.items.items.properties.price_text.maxLength).toBe(80);
    expect(schema.properties.items.items.properties.price_text.minLength).toBeUndefined();
    expect(schema.properties.items.minItems).toBeUndefined();
  });

  it("treats a 200 without a result list as a failure, not as a claim about the cards", async () => {
    // A proxy's JSON page, or a wrong route answering 200 {}: rendering it as
    // "dropped 3 with no readable price" would be a false statement.
    for (const data of [{}, { count: 3 }, { options: "nope" }, null]) {
      mockFetch(() => ({ data }));
      const res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
      expect(res.isError).toBe(false);
      const text = textOf(res);
      expect(text).toMatch(/Couldn't compare the cards/);
      expect(text).not.toMatch(/readable price/);
      expect(text).not.toMatch(/^compared:/m);
    }
  });

  it("renders a 5xx, a thrown fetch and a non-JSON body as a plain sentence with isError false", async () => {
    mockFetch(() => ({ status: 503, data: { error: "upstream down", status: 503 } }));
    let res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/Couldn't compare the cards: .*upstream down/);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/Couldn't compare the cards: .*fetch failed/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    res = await captureTools().firestarter_marketplace_compare({ country: "TH", items: CARDS });
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/Couldn't compare the cards/);
    expect(textOf(res)).not.toMatch(/readable price/);
  });

  it("describes itself as ranking what the person's own browser captured", () => {
    const d = describeOf("firestarter_marketplace_compare");
    expect(d).toMatch(/OWN browser/);
    expect(d).toMatch(/browser_products/);
    expect(d).toMatch(/price text exactly as shown/);
    expect(d).toMatch(/never priced 0/);
  });
});

describe("toMarketplaceStructured", () => {
  it("is schema-valid on degraded input", () => {
    for (const j of [null, {}, { results: [{}] }, { results: [{ price_minor: "12", currency: 5 }], progress: { shopee: 7 } }]) {
      expect(() => marketplaceOutputSchema.parse(toMarketplaceStructured(j))).not.toThrow();
    }
    const out = toMarketplaceStructured({ id: "scj_9", status: "completed", results: [RESULT] });
    expect(out.count).toBe(1);
    expect(out.checkoutable_count).toBe(1);
    expect(out.options[0].url).toBe(RESULT.product_url);
  });
});

/* ─── Price units ────────────────────────────────────────────────────────────
 *
 * Reported from the field as "Firestarter prices off by 100x". The arithmetic
 * was never wrong — every adapter emits genuine minor units — but this mapper
 * published NO major-unit price at all, and put the API's ranking key (a
 * deliberately over-estimating static FX table, whose own source says "never
 * use for charging or displaying money") in the field named `price_usd`. A
 * consumer had nothing correct to read, so the RM 12.90 row below rendered as
 * "MYR 3.87".
 */
const USD_ROW = { ...RESULT, id: "shopify:usd:1", source: "shopify", currency: "USD", price_minor: 4200, price_usd: 42 };
const THB_ROW = { ...RESULT, id: "shopee:th:1", currency: "THB", price_minor: 39900, price_usd: 11.2 };
// Zero-decimal (ISO-4217 exponent 0): ¥1290 is 1290 minor units, not ¥12.90.
const JPY_ROW = { ...RESULT, id: "shopee:jp:1", currency: "JPY", price_minor: 1290, price_usd: 8.6 };

describe("scout price units", () => {
  it("publishes a major-unit current_price alongside the minor units", () => {
    const out = toMarketplaceStructured({ results: [RESULT, THB_ROW] });
    expect(out.options[0]).toMatchObject({
      currency: "MYR",
      current_price: 12.9,
      price: { currency: "MYR", amount_minor: 1290 },
    });
    expect(out.options[1]).toMatchObject({ currency: "THB", current_price: 399 });
    expect(() => marketplaceOutputSchema.parse(out)).not.toThrow();
  });

  it("never republishes the FX over-estimate as price_usd on a non-USD row", () => {
    const out = toMarketplaceStructured({ results: [RESULT, THB_ROW, JPY_ROW] });
    expect(out.options.map((o) => o.price_usd)).toEqual([null, null, null]);
  });

  it("keeps price_usd on a genuinely USD row, equal to current_price", () => {
    const out = toMarketplaceStructured({ results: [USD_ROW] });
    expect(out.options[0].current_price).toBe(42);
    expect(out.options[0].price_usd).toBe(42);
  });

  it("does not divide a zero-decimal currency by 100", () => {
    const out = toMarketplaceStructured({ results: [JPY_ROW] });
    expect(out.options[0].current_price).toBe(1290);
  });

  it("leaves current_price null when the row carries no price", () => {
    const out = toMarketplaceStructured({ results: [{ ...RESULT, price_minor: null, price_usd: null }] });
    expect(out.options[0].current_price).toBeNull();
    expect(out.options[0].price_usd).toBeNull();
    expect(() => marketplaceOutputSchema.parse(out)).not.toThrow();
  });
});

describe("scout prose money formatting", () => {
  it("renders a 2-decimal currency from its minor units", () => {
    expect(renderScoutRows([RESULT])[0]).toContain("MYR 12.90");
  });

  it("does not divide a zero-decimal currency by 100", () => {
    const line = renderScoutRows([JPY_ROW])[0];
    expect(line).toContain("JPY 1290");
    expect(line).not.toContain("JPY 12.90");
  });

  it("uses the three-decimal exponent for a Gulf currency", () => {
    expect(renderScoutRows([{ ...RESULT, currency: "KWD", price_minor: 12900 }])[0]).toContain("KWD 12.900");
  });
});

describe("the unit contract on the wire", () => {
  // JSDoc is invisible to an agent: zod never emits it into the JSON Schema a
  // model actually receives. Only .describe() reaches the wire, and its absence
  // is what made "off by 100x" a reasonable reading of the payload.
  it("states minor units, the ISO-4217 exponent and the price_usd rule in the advertised schema", () => {
    const schema = z.toJSONSchema(marketplaceOutputSchema, { io: "output" }) as any;
    const option = schema.properties.options.items.properties;

    const minor = String(option.price.properties.amount_minor.description ?? "");
    expect(minor).toMatch(/minor unit/i);
    expect(minor).toMatch(/1290/);
    expect(minor).toMatch(/JPY/);
    expect(minor).toMatch(/exponent/i);

    expect(String(option.current_price.description ?? "")).toMatch(/major unit/i);
    const usd = String(option.price_usd.description ?? "");
    expect(usd).toMatch(/major unit/i);
    expect(usd).toMatch(/null/i);
    expect(String(option.currency.description ?? "")).toMatch(/4217/);
  });
});
