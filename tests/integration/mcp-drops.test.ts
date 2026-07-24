/**
 * MCP firestarter_drops coverage.
 *
 * The community-sponsored drops tool is the agent-facing surface for the
 * checkout-wired drop discount: `list` shows live drops on a listing (discount,
 * slots left, tier-gate state) and `claim` reserves a slot that then applies at
 * checkout. Underneath, services/drops.ts and routes/drops.ts are unit/route
 * tested; this pins the MCP tool wrapper itself — argument routing to the right
 * endpoint, the buyer-facing formatting, and the required-arg guards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

function textOf(res: any): string {
  return (res?.content || []).map((b: any) => b.text || "").join("\n");
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP firestarter_drops", () => {
  it("lists live drops on a listing with discount, slots and gate state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "GET" && String(url).includes("/v1/drops?listing_id=lst_1")) {
          return jsonResponse(200, {
            drops: [
              { id: "drop_open", discount_cents: 500, remaining: 3, min_tier: 0, in_priority_window: false, priority_until: null },
              { id: "drop_gated", discount_cents: 1000, remaining: 5, min_tier: 2, in_priority_window: true, priority_until: "2026-08-01T00:00:00Z" },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );

    const tools = captureTools();
    const res = await tools.firestarter_drops({ action: "list", listing_id: "lst_1" });
    const text = textOf(res);

    expect(res.isError).toBeFalsy();
    expect(text).toContain("`drop_open` — $5.00 off · 3 left");
    // The gated drop shows its early-access tier window.
    expect(text).toContain("`drop_gated` — $10.00 off · 5 left · early access for tier 2+");
  });

  it("reports no live drops cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { drops: [] })));
    const tools = captureTools();
    const res = await tools.firestarter_drops({ action: "list", listing_id: "lst_none" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("No live community drops on this listing");
  });

  it("requires a listing_id to list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not fetch"); }));
    const tools = captureTools();
    const res = await tools.firestarter_drops({ action: "list" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pass a listing_id");
  });

  it("claims a drop and confirms the reserved discount + slots left", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ method, url: String(url), body });
        if (method === "POST" && String(url).endsWith("/v1/drops/drop_open/claim")) {
          return jsonResponse(200, { claimed: true, claim_id: "dclaim_1", discount_cents: 500, remaining: 2 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );

    const tools = captureTools();
    const res = await tools.firestarter_drops({ action: "claim", drop_id: "drop_open" });
    const text = textOf(res);

    expect(res.isError).toBeFalsy();
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/v1/drops/drop_open/claim"))).toBe(true);
    expect(text).toContain("$5.00 off is reserved");
    expect(text).toContain("2 slots left");
    expect(text).toContain("It applies when you buy the listing");
  });

  it("requires a drop_id to claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not fetch"); }));
    const tools = captureTools();
    const res = await tools.firestarter_drops({ action: "claim" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pass a drop_id");
  });

  it("surfaces a tier-locked claim as an actionable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, {
          error: "This drop is in its early-access window for higher tiers right now. Check back when it opens to all members.",
          code: "TIER_LOCKED",
        })
      )
    );
    const tools = captureTools();
    const res = await tools.firestarter_drops({ action: "claim", drop_id: "drop_gated" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("early-access window for higher tiers");
  });
});

describe("MCP firestarter_create_drop (owner)", () => {
  it("creates a drop on the owner's program and confirms its terms + slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ method, url: String(url), body });
        if (method === "POST" && String(url).endsWith("/v1/attribution/programs/apg_1/drops")) {
          // The owner endpoint receives the drop terms.
          expect(body).toMatchObject({ listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
          return jsonResponse(201, {
            drop: {
              id: "drop_new", listing_id: "lst_9", discount_cents: 500, max_claims: 20,
              claims_used: 0, min_tier: 0, priority_until: null, expires_at: "2026-08-01T00:00:00Z", status: "active",
            },
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/Drop created/i);
    expect(text).toContain("$5.00");
    expect(text).toContain("20");
  });

  it("maps PROGRAM_NOT_FOUND to a firestarter_my_markets hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "Program not found", code: "PROGRAM_NOT_FOUND" })));
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_x", listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("firestarter_my_markets");
  });
});
