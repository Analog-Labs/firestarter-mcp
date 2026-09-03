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

vi.hoisted(() => {
  process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS = "1";
  process.env.FIRESTARTER_MCP_SCOUT_WAIT_MS = "60";
});

import { registerTools } from "../../src/mcp/tools.js";
import { marketplaceOutputSchema, toMarketplaceStructured } from "../../src/mcp/schemas.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools({ tool: (...args: any[]) => { tools[args[0] as string] = args[args.length - 1] as ToolHandler; } } as any, "fsk_test", "http://api.test");
  return tools;
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
