/**
 * The three MCP-surface gaps the 2026-08-19 sandbox run found.
 *
 *   1. commerce#771 — firestarter_execute could not set
 *      preferences.hold_at_shipped, so the flag the API has accepted since
 *      commerce#829 was REST-only and the tests it exists for (#695's retest,
 *      #526's E2E) stayed unstageable from any agent surface.
 *   2. commerce#769 — firestarter_my_markets emitted a bare "Members: N",
 *      the single unqualified number that issue was filed about. The API
 *      answers both windows and the web tile names them; this surface did not.
 *   3. firestarter_reprice printed "Buyer-facing price right now" for a
 *      listing no buyer can see, which reads as "it is on sale at this price".
 *
 * Harness: drive the REAL registered tool handlers (captured via a fake
 * McpServer) against a mocked global fetch — same as
 * mcp-execute-attribution.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, "fs_test_key", "http://api.test");
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

const COMPLETED_EXEC = { id: "exec_qa1", status: "completed", request_text: "soap", options: [], steps: [] };

function installFetch(routes: (method: string, url: string) => any) {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, url: String(url), body });
    const payload = routes(method, String(url));
    if (payload === undefined) throw new Error(`unexpected fetch: ${method} ${url}`);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_execute — hold_at_shipped (commerce#771)", () => {
  const routes = (method: string, url: string) => {
    if (method === "POST" && url.endsWith("/v1/executions")) return { id: "exec_qa1", status: "finding" };
    if (method === "GET" && url.includes("/v1/executions/")) return COMPLETED_EXEC;
    return undefined;
  };

  it("forwards hold_at_shipped into preferences", async () => {
    installFetch(routes);
    await captureTools().firestarter_execute({ request: "soap", hold_at_shipped: true });
    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.preferences.hold_at_shipped).toBe(true);
    // The flag must ride ALONGSIDE the existing preferences, not replace them.
    expect(create?.body.preferences.priority).toBe("cost");
    expect(create?.body.preferences.require_approval).toBe(true);
  });

  it("sends no hold_at_shipped key when the flag is absent (byte-identical to before)", async () => {
    installFetch(routes);
    await captureTools().firestarter_execute({ request: "soap" });
    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.preferences).toEqual({ priority: "cost", require_approval: true });
  });

  it("false is treated as absent rather than sent as false", async () => {
    installFetch(routes);
    await captureTools().firestarter_execute({ request: "soap", hold_at_shipped: false });
    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.preferences).not.toHaveProperty("hold_at_shipped");
  });
});

describe("firestarter_my_markets — name the member window (commerce#769)", () => {
  const withPrograms = (programs: any[]) => (method: string, url: string) =>
    method === "GET" && url.includes("/v1/attribution/programs") ? { programs } : undefined;

  const base = { id: "prg_1", status: "active", override_bps: 250, display_name: "Sunset District Makers", slug: "sunset", links: [] };

  it("names both windows when members have left", async () => {
    installFetch(withPrograms([{ ...base, member_count: 0, member_count_all_time: 6 }]));
    const res = await captureTools().firestarter_my_markets({});
    const text = res.content[0].text as string;
    expect(text).toContain("Members: 0 now · 6 have been, all-time");
    // The contradiction #769 was filed about: a bare "Members: 0" beside real
    // sales. The unqualified form must not survive.
    expect(text).not.toMatch(/Members: 0(?! now)/);
  });

  it("reads exactly as before when nobody has left", async () => {
    installFetch(withPrograms([{ ...base, member_count: 6, member_count_all_time: 6 }]));
    const res = await captureTools().firestarter_my_markets({});
    expect(res.content[0].text as string).toContain("Members: 6");
    expect(res.content[0].text as string).not.toContain("all-time");
  });

  it("falls back to the single number when the API predates the field", async () => {
    installFetch(withPrograms([{ ...base, member_count: 3 }]));
    const res = await captureTools().firestarter_my_markets({});
    expect(res.content[0].text as string).toContain("Members: 3");
    expect(res.content[0].text as string).not.toContain("all-time");
  });
});

describe("firestarter_reprice — do not imply a draft is on sale", () => {
  const patched = (listing: any) => (method: string, url: string) =>
    method === "PATCH" && url.includes("/v1/listings/") ? listing : undefined;

  it("says the listing is not buyable when it is not active", async () => {
    installFetch(patched({ id: "lst_1", base_price: 750, current_price: 750, status: "draft" }));
    const res = await captureTools().firestarter_reprice({ listing_id: "lst_1", base_price: 750 });
    const text = res.content[0].text as string;
    expect(text).toContain("this listing is draft, so no buyer can see or buy it right now");
    expect(text).not.toContain("Buyer-facing price right now");
  });

  it("still reports the buyer-facing price for an active listing", async () => {
    installFetch(patched({ id: "lst_1", base_price: 40, current_price: 40, status: "active" }));
    const res = await captureTools().firestarter_reprice({ listing_id: "lst_1", base_price: 40 });
    expect(res.content[0].text as string).toContain("Buyer-facing price right now: $40");
  });

  it("an API that returns no status keeps the old wording", async () => {
    installFetch(patched({ id: "lst_1", base_price: 40, current_price: 40 }));
    const res = await captureTools().firestarter_reprice({ listing_id: "lst_1", base_price: 40 });
    expect(res.content[0].text as string).toContain("Buyer-facing price right now: $40");
  });
});
