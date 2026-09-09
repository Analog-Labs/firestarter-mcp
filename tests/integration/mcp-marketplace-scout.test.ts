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

vi.hoisted(() => {
  process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS = "1";
  process.env.FIRESTARTER_MCP_SCOUT_WAIT_MS = "60";
});

import { registerTools } from "../../src/mcp/tools.js";
import { marketplaceOutputSchema, toMarketplaceStructured } from "../../src/mcp/schemas.js";
import { renderScoutRows } from "../../src/mcp/scout-tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools({ tool: (...args: any[]) => { tools[args[0] as string] = args[args.length - 1] as ToolHandler; } } as any, "fsk_test", "http://api.test");
  return tools;
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

afterEach(() => vi.unstubAllGlobals());

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
    // in BOTH directions — a longer wait here, a shorter one for Cole in prod.
    mockFetch((method) => method === "POST"
      ? { status: 202, data: { job: job({ id: "job_1", status: "running", results: [], progress: { lazada: "running" } }) } }
      : { data: { job: job({ id: "job_1", status: "running", results: [], progress: { lazada: "running" } }) } });
    const started = Date.now();
    const res = await captureTools().firestarter_marketplace_search({ query: "cotton buds", wait_ms: 300 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
    const text = textOf(res);
    expect(text).toMatch(/^job_id: job_1$/m);
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
    expect(res.isError).toBeFalsy();
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
