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
  // Phase B: a drop the owner's own wallet fully covers self-funds and skips
  // seller approval entirely — the API signals this via drop.funding_mode.
  it("creates a self-funded (owner_wallet) drop and confirms it's live with no seller approval needed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "POST" && String(url).endsWith("/v1/attribution/programs/apg_1/drops")) {
          return jsonResponse(201, {
            drop: {
              id: "drop_wallet", listing_id: "lst_other", discount_cents: 500, max_claims: 20,
              claims_used: 0, min_tier: 0, priority_until: null, expires_at: "2026-08-01T00:00:00Z",
              status: "active", funding_mode: "owner_wallet",
            },
            status: "active",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_other", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/funding it from your wallet/i);
    expect(text).toContain("$5.00");
    expect(text).toMatch(/no seller approval needed/i);
    expect(text).not.toMatch(/pending the seller's approval/i);
    expect(text).not.toContain("firestarter_cancel_drop");
  });

  it("creates a drop on the owner's program and confirms it's LIVE when status is active", async () => {
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
            status: "active",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/Drop is live/i);
    expect(text).toContain("$5.00");
    expect(text).toContain("20");
    // Live drops point the agent at claiming, not at withdrawing a request.
    expect(text).toContain("firestarter_drops");
    expect(text).not.toContain("firestarter_cancel_drop");
  });

  // A drop on someone else's listing (no standing grant) is parked pending the
  // seller's decision — the API is the source of truth via `status`, and the
  // owner must be told they can't claim yet and can withdraw the ask.
  it("renders a request on another seller's listing as PENDING the seller's approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "POST" && String(url).endsWith("/v1/attribution/programs/apg_1/drops")) {
          return jsonResponse(201, {
            drop: {
              id: "drop_pending", listing_id: "lst_other", discount_cents: 300, max_claims: 10,
              claims_used: 0, min_tier: 0, priority_until: null, expires_at: null, status: "pending_seller_approval",
            },
            status: "pending_seller_approval",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_other", discount_cents: 300, max_claims: 10 });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/pending the seller's approval/i);
    expect(text).toContain("firestarter_cancel_drop");
    expect(text).not.toMatch(/Drop is live/i);
  });

  it("maps DROP_DUPLICATE to an actionable 'already pending' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, { error: "A pending drop request already exists for this listing.", code: "DROP_DUPLICATE" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/pending drop request already exists/i);
    expect(textOf(res)).toContain("firestarter_cancel_drop");
  });

  it("maps LISTING_NOT_SELLABLE to a 'listing isn't active' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(400, { error: "That listing isn't active, so it can't take a drop.", code: "LISTING_NOT_SELLABLE" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_paused", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/isn't active/i);
    expect(textOf(res)).toContain("firestarter_catalog_search");
  });

  it("maps PROGRAM_NOT_FOUND to a firestarter_my_markets hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "Program not found", code: "PROGRAM_NOT_FOUND" })));
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_x", listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("firestarter_my_markets");
  });

  it("surfaces a below-floor rejection instead of silently creating an unusable drop", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(400, {
        error: "A drop can't discount a $1.05 listing without leaving the seller below the $0.50 payable minimum. This listing is priced at the payable minimum, so it can't take any drop discount — raise its price first.",
        code: "DROP_BELOW_FLOOR",
      })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_cheap", discount_cents: 50, max_claims: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/payable minimum/i);
  });

  // #480 — an owner sponsoring the same listing twice got two identical LIVE
  // drops. The duplicate guard now covers a live drop as well as a pending
  // request, so DROP_DUPLICATE carries both cases through to the agent.
  it("surfaces a duplicate-drop rejection and points at the owner's existing drops", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, {
        error: "This listing already has a drop in this community — either live or awaiting the seller's approval. End or wait out the existing one before starting another.",
        code: "DROP_DUPLICATE",
      })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_create_drop({ program_id: "apg_1", listing_id: "lst_9", discount_cents: 500, max_claims: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/already has a drop in this community/i);
    expect(textOf(res)).toContain("firestarter_market_drops");
  });
});

// The owner can CREATE a drop but, until this tool, had no MCP way to SEE the
// drops they created — claim progress, status, expiry. The web owner dashboard
// (CommunityDrops.tsx) already lists them via GET /programs/:id/drops; this
// closes that tool<->web gap so an agent-only owner isn't blind to their drops.
describe("MCP firestarter_market_drops (owner list)", () => {
  it("lists the owner's drops with discount, claim progress, status and gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "GET" && String(url).endsWith("/v1/attribution/programs/apg_1/drops")) {
          return jsonResponse(200, {
            drops: [
              { id: "drop_a", listing_id: "lst_9", discount_cents: 500, max_claims: 20, claims_used: 3, min_tier: 2, priority_until: "2999-01-01T00:00:00Z", expires_at: "2999-02-01T00:00:00Z", status: "active" },
              { id: "drop_b", listing_id: "lst_x", discount_cents: 1000, max_claims: 10, claims_used: 10, min_tier: 0, priority_until: null, expires_at: "2026-07-30T00:00:00Z", status: "exhausted" },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_market_drops({ program_id: "apg_1" });
    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    // Hit the owner-scoped GET, not the buyer /v1/drops surface.
    expect(fetchCalls.some((c) => c.method === "GET" && c.url.endsWith("/v1/attribution/programs/apg_1/drops"))).toBe(true);
    expect(text).toContain("$5.00 off lst_9 — 3/20 claimed · active");
    expect(text).toContain("tier 2+");
    expect(text).toContain("$10.00 off lst_x — 10/10 claimed · exhausted");
    // Each row leads with the drop id so firestarter_cancel_drop can use it.
    expect(text).toContain("`drop_a`");
    expect(text).toContain("`drop_b`");
  });

  it("surfaces a pending request's id + decision deadline + cancel hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "GET" && String(url).endsWith("/v1/attribution/programs/apg_1/drops")) {
          return jsonResponse(200, {
            drops: [
              { id: "drop_pending", listing_id: "lst_other", discount_cents: 200, max_claims: 2, claims_used: 0, min_tier: 0, priority_until: null, expires_at: null, request_expires_at: "2999-03-01T00:00:00Z", status: "pending_seller_approval" },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_market_drops({ program_id: "apg_1" });
    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("`drop_pending`");
    expect(text).toContain("pending_seller_approval");
    expect(text).toContain("awaiting the seller's approval");
    // A pending drop is cancelable → the tool tells the owner how, with the id.
    expect(text).toContain("firestarter_cancel_drop");
  });

  it("reports no drops cleanly with a create hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { drops: [] })));
    const tools = captureTools();
    const res = await tools.firestarter_market_drops({ program_id: "apg_1" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("firestarter_create_drop");
  });

  it("maps PROGRAM_NOT_FOUND to a firestarter_my_markets hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "Program not found", code: "PROGRAM_NOT_FOUND" })));
    const tools = captureTools();
    const res = await tools.firestarter_market_drops({ program_id: "apg_x" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("firestarter_my_markets");
  });
});

// Owner withdraws a still-pending drop request before the seller decided.
describe("MCP firestarter_cancel_drop (owner)", () => {
  it("cancels a pending request against the program's cancel route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "POST" && String(url).endsWith("/v1/attribution/programs/apg_1/drops/drop_pending/cancel")) {
          return jsonResponse(200, { ok: true });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_cancel_drop({ program_id: "apg_1", drop_id: "drop_pending" });
    expect(res.isError).toBeFalsy();
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/v1/attribution/programs/apg_1/drops/drop_pending/cancel"))).toBe(true);
    expect(textOf(res)).toMatch(/cancelled/i);
  });

  it("maps PROGRAM_NOT_FOUND to a firestarter_my_markets hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: "Program not found", code: "PROGRAM_NOT_FOUND" })));
    const tools = captureTools();
    const res = await tools.firestarter_cancel_drop({ program_id: "apg_x", drop_id: "drop_1" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("firestarter_my_markets");
  });

  it("maps DROP_NOT_FOUND (already decided/live/gone) to an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(404, { error: "No pending drop request found to cancel", code: "DROP_NOT_FOUND", ok: false })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_cancel_drop({ program_id: "apg_1", drop_id: "drop_done" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no pending drop request/i);
  });
});

// Seller review queue: drops proposed on the seller's own listings by a
// community that doesn't (yet) have standing trust.
describe("MCP firestarter_drop_requests (seller)", () => {
  it("lists pending requests with community, listing, discount, slots and deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "GET" && String(url).endsWith("/v1/drops/requests")) {
          return jsonResponse(200, {
            requests: [
              {
                id: "drop_req_1", program_id: "apg_1", community_name: "Analog Fans",
                listing_id: "lst_9", product_name: "Wireless Mouse", discount_cents: 500, max_claims: 20,
                request_expires_at: "2026-08-03T00:00:00Z",
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_drop_requests({});
    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(fetchCalls.some((c) => c.method === "GET" && c.url.endsWith("/v1/drops/requests"))).toBe(true);
    expect(text).toContain("drop_req_1");
    expect(text).toContain("Analog Fans");
    expect(text).toContain("Wireless Mouse");
    expect(text).toContain("$5.00");
    expect(text).toContain("20");
    expect(text).toContain("2026-08-03");
    expect(text).toContain("firestarter_approve_drop");
    expect(text).toContain("firestarter_reject_drop");
    expect(text).toContain("firestarter_trust_community_drops");
  });

  it("reports no pending requests cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { requests: [] })));
    const tools = captureTools();
    const res = await tools.firestarter_drop_requests({});
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/no pending drop requests/i);
  });

  it("surfaces a listing error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "Internal error" })));
    const tools = captureTools();
    const res = await tools.firestarter_drop_requests({});
    expect(res.isError).toBe(true);
  });
});

describe("MCP firestarter_approve_drop (seller)", () => {
  it("approves a pending request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "POST" && String(url).endsWith("/v1/drops/drop_req_1/approve")) {
          return jsonResponse(200, { ok: true });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_approve_drop({ drop_id: "drop_req_1" });
    expect(res.isError).toBeFalsy();
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/v1/drops/drop_req_1/approve"))).toBe(true);
    expect(textOf(res)).toMatch(/approved/i);
  });

  it("maps NOT_PENDING to an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, { error: "This drop request is no longer pending — it may have already been decided or expired.", code: "NOT_PENDING" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_approve_drop({ drop_id: "drop_req_1" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no longer pending/i);
  });
});

describe("MCP firestarter_reject_drop (seller)", () => {
  it("rejects a pending request with a reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ method, url: String(url), body });
        if (method === "POST" && String(url).endsWith("/v1/drops/drop_req_1/reject")) {
          expect(body).toMatchObject({ reason: "Discount too deep" });
          return jsonResponse(200, { ok: true });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_reject_drop({ drop_id: "drop_req_1", reason: "Discount too deep" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/declined/i);
    expect(textOf(res)).toContain("Discount too deep");
  });

  it("maps NOT_PENDING to an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, {
        error: "This drop request can't be rejected — it may not exist, may not belong to you, or may no longer be pending.",
        code: "NOT_PENDING",
      })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_reject_drop({ drop_id: "drop_gone" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/can't be rejected/i);
  });
});

describe("MCP firestarter_trust_community_drops (seller)", () => {
  it("grants standing trust and reports auto-approved pending requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "POST" && String(url).endsWith("/v1/drops/programs/apg_1/trust")) {
          return jsonResponse(200, { ok: true, approved_pending: 2 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_trust_community_drops({ program_id: "apg_1" });
    expect(res.isError).toBeFalsy();
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/v1/drops/programs/apg_1/trust"))).toBe(true);
    expect(textOf(res)).toMatch(/trusted/i);
    expect(textOf(res)).toContain("2 pending requests");
  });

  it("grants trust with nothing pending to auto-approve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true, approved_pending: 0 })));
    const tools = captureTools();
    const res = await tools.firestarter_trust_community_drops({ program_id: "apg_2" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/trusted/i);
    expect(textOf(res)).not.toMatch(/pending request/i);
  });
});

describe("MCP firestarter_untrust_community_drops (seller)", () => {
  it("revokes standing trust", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "POST" && String(url).endsWith("/v1/drops/programs/apg_1/untrust")) {
          return jsonResponse(200, { ok: true, revoked: true });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_untrust_community_drops({ program_id: "apg_1" });
    expect(res.isError).toBeFalsy();
    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/v1/drops/programs/apg_1/untrust"))).toBe(true);
    expect(textOf(res)).toMatch(/untrusted/i);
  });

  it("reports cleanly when nothing was trusted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: true, revoked: false })));
    const tools = captureTools();
    const res = await tools.firestarter_untrust_community_drops({ program_id: "apg_3" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/wasn't trusted/i);
  });
});

// Phase B: owner-funded drop wallet — deposit (Stripe Checkout), balance, and
// withdraw (idempotent payout). Distinct from firestarter_connect_payouts,
// which is the Stripe Connect account market-fee earnings pay out to.
describe("MCP firestarter_fund_wallet (owner)", () => {
  it("returns the Stripe Checkout deposit URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ method, url: String(url), body });
        if (method === "POST" && String(url).endsWith("/v1/drops/wallet/deposit")) {
          expect(body).toMatchObject({ amount_cents: 2000 });
          return jsonResponse(200, { url: "https://checkout.stripe.com/pay/cs_test_123", session_id: "cs_test_123" });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_fund_wallet({ amount_cents: 2000 });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("https://checkout.stripe.com/pay/cs_test_123");
    expect(text).toContain("$20.00");
    // Self-funded framing: once funded, drops the owner creates need no seller approval.
    expect(text).toMatch(/no seller approval needed/i);
  });

  it("maps INVALID_AMOUNT to a clear $1 minimum message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(400, { error: "amount_cents must be an integer of at least 100 ($1.00).", code: "INVALID_AMOUNT" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_fund_wallet({ amount_cents: 50 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/\$1\.00/);
  });
});

describe("MCP firestarter_wallet_balance (owner)", () => {
  it("renders balance, reserved, deposited and withdrawn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "GET" && String(url).endsWith("/v1/drops/wallet")) {
          // Four DISTINCT values so a dropped/mislabeled figure can't hide behind
          // a duplicate — each assertion below pins its value to its own label.
          return jsonResponse(200, { balance_cents: 4500, reserved_cents: 1000, deposited_cents: 6000, withdrawn_cents: 500 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_wallet_balance({});
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/\$45\.00 spendable/);
    expect(text).toMatch(/Reserved for live drops[^\n]*\$10\.00/);
    expect(text).toMatch(/Lifetime deposited: \$60\.00/);
    expect(text).toMatch(/Lifetime withdrawn: \$5\.00/);
  });

  it("surfaces a fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "Internal error" })));
    const tools = captureTools();
    const res = await tools.firestarter_wallet_balance({});
    expect(res.isError).toBe(true);
  });
});

describe("MCP firestarter_withdraw_wallet (owner)", () => {
  it("sends a fresh Idempotency-Key header and confirms the payout on ok", async () => {
    let capturedHeaders: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ method, url: String(url), body });
        if (method === "POST" && String(url).endsWith("/v1/drops/wallet/withdraw")) {
          capturedHeaders = init?.headers;
          expect(body).toMatchObject({ amount_cents: 1500 });
          return jsonResponse(200, { ok: true, balance_cents: 3000, transfer_id: "tr_123" });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();
    const res = await tools.firestarter_withdraw_wallet({ amount_cents: 1500 });
    expect(res.isError).toBeFalsy();
    expect(capturedHeaders?.["Idempotency-Key"]).toBeTruthy();
    expect(typeof capturedHeaders["Idempotency-Key"]).toBe("string");
    expect(capturedHeaders["Idempotency-Key"].length).toBeGreaterThan(10);
    const text = textOf(res);
    expect(text).toContain("$15.00");
    expect(text).toContain("$30.00");
  });

  it("generates a DIFFERENT Idempotency-Key on separate invocations", async () => {
    const seenKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        seenKeys.push(init?.headers?.["Idempotency-Key"]);
        return jsonResponse(200, { ok: true, balance_cents: 1000, transfer_id: "tr_1" });
      })
    );
    const tools = captureTools();
    await tools.firestarter_withdraw_wallet({ amount_cents: 100 });
    await tools.firestarter_withdraw_wallet({ amount_cents: 100 });
    expect(seenKeys.length).toBe(2);
    expect(seenKeys[0]).not.toBe(seenKeys[1]);
  });

  it("maps INSUFFICIENT_FUNDS to a 'reserved funds aren't withdrawable' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(400, { error: "Your withdrawable balance is lower than that.", code: "INSUFFICIENT_FUNDS" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_withdraw_wallet({ amount_cents: 999999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/spendable balance/i);
    expect(textOf(res)).toMatch(/reserved funds.*aren't withdrawable/i);
  });

  it("maps NOT_CONNECTED to a firestarter_connect_payouts hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, { error: "Connect a payout account first.", code: "NOT_CONNECTED" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_withdraw_wallet({ amount_cents: 500 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("firestarter_connect_payouts");
  });

  it("maps PREVIOUS_ATTEMPT_FAILED to a 'try a fresh withdrawal' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(409, { error: "A withdrawal with this Idempotency-Key already failed.", code: "PREVIOUS_ATTEMPT_FAILED" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_withdraw_wallet({ amount_cents: 500 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/already attempted and failed/i);
    expect(textOf(res)).toMatch(/fresh withdrawal/i);
  });

  it("maps STRIPE_ERROR to a 'temporary payout issue' message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(502, { error: "Payment provider error", code: "STRIPE_ERROR" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_withdraw_wallet({ amount_cents: 500 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/temporary payout issue/i);
  });

  it("maps INVALID_AMOUNT to a clear $1 minimum message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(400, { error: "amount_cents must be an integer of at least 100 ($1.00).", code: "INVALID_AMOUNT" })
    ));
    const tools = captureTools();
    const res = await tools.firestarter_withdraw_wallet({ amount_cents: 100 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/\$1\.00/);
  });
});
