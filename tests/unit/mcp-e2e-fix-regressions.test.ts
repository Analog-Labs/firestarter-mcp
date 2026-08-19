/**
 * Regressions pinned from the 2026-08-19 live buyer/seller e2e audit. Each
 * fixture is the EXACT payload shape the production API returned during the
 * audit; each assertion is the defect a real session surfaced:
 *
 *  - a pasted share link failed where the description promised it would work;
 *  - firestarter_demand was the one tool answering a seller in raw JSON;
 *  - a CLOSED dispute still prompted accept/reject/counter on a stale offer;
 *  - tracking a cancelled order promised tracking that would never come;
 *  - the disputes list stuttered "closed (closed)".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fs_test_e2e_regressions", "http://api.test");
  return tools;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function text(res: any): string {
  return (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("share links act as listing ids", () => {
  it("firestarter_product resolves a pasted firestarter.network/l/<id> URL", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      seen.push(String(url));
      return json({
        id: "lst_8mVI1610", product_name: "Coffee Beans", current_price: 1.05, currency: "USD",
        description: "Coffee Beans. Medium Roast.", images: [], share_url: "https://firestarter.network/l/lst_8mVI1610",
        seller: null, seller_verified: false, seller_rating: null, seller_rating_count: 0, units_sold: 0, inventory_qty: 3,
      });
    }));
    const out = await captureTools().firestarter_product({ listing_id: "https://firestarter.network/l/lst_8mVI1610" });

    // The request must hit the extracted id, not the URL-as-id (which 404s).
    expect(seen.some((u) => u.endsWith("/v1/listings/lst_8mVI1610"))).toBe(true);
    expect(text(out)).toContain("Coffee Beans");
  });
});

describe("firestarter_demand speaks prose, not JSON", () => {
  it("renders the per-listing metrics object in words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ demand: { searches_24h: 3, executions_24h: 1, active_monitors_7d: 0, avg_price_point: 12.5 } })));
    const out = text(await captureTools().firestarter_demand({ listing_id: "lst_8mVI1610" }));

    expect(out).toContain("Searches (24h): 3");
    expect(out).toContain("Average buyer price point: $12.50");
    expect(out).not.toContain("{");
  });
});

describe("closed disputes stop soliciting actions", () => {
  it("does not prompt accept/reject/counter on a stale pending offer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ dispute: {
      id: "disp_o11VQBAXPbVG", status: "closed", execution_id: "exec_GNabjDwe",
      reason: "It's taking too long", type: "not_as_described", is_open: false,
      buyer_refund_pct: 0, resolution: "dismissed",
      offers: [{ id: "off_1", offered_by: "seller", buyer_pct: 50, seller_pct: 50, note: "Proposed 50/50 split", accepted_at: null, rejected_at: null }],
      messages: [],
    }})));
    const out = text(await captureTools().firestarter_disputes({ dispute_id: "disp_o11VQBAXPbVG" }));

    expect(out).toContain("This dispute is closed");
    expect(out).not.toContain('action "accept"');
  });

  it("still prompts on an OPEN dispute with a pending seller offer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ dispute: {
      id: "disp_live", status: "negotiating", execution_id: "exec_x", reason: "damaged", type: "damaged",
      is_open: true, offers: [{ id: "off_2", offered_by: "seller", buyer_pct: 40, seller_pct: 60, accepted_at: null, rejected_at: null }],
      messages: [],
    }})));
    const out = text(await captureTools().firestarter_disputes({ dispute_id: "disp_live" }));

    expect(out).toContain('action "accept"');
  });
});

describe("tracking a dead order tells the truth", () => {
  it("cancelled order: says nothing will ship instead of promising tracking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      execution_id: "exec_KsxzQ4r7", status: "cancelled", tracking_number: null, carrier: null,
      promised_delivery_date: "2026-08-02",
      shipping_method: { carrier: "standard", service: null, provider: "platform_estimate" },
      ship_from: { city: "Bang Kaeo", country: "TH" }, ship_to: { city: "Samut Prakan", country: "TH" },
    })));
    const out = text(await captureTools().firestarter_track_order({ execution_id: "exec_KsxzQ4r7" }));

    expect(out).toContain("nothing will ship");
    expect(out).not.toContain("tracking appears here once");
  });

  it("a merely-unshipped order still promises tracking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      execution_id: "exec_live", status: "awaiting_shipment", tracking_number: null, carrier: null,
      ship_from: { city: "Bang Kaeo", country: "TH" }, ship_to: { city: "Samut Prakan", country: "TH" },
    })));
    const out = text(await captureTools().firestarter_track_order({ execution_id: "exec_live" }));

    expect(out).toContain("tracking appears here once");
  });
});

describe("disputes list label", () => {
  it("does not stutter 'closed (closed)'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disputes: [
      { id: "disp_a", product: "Cat Food Can", status: "auto_resolved", is_open: false, execution_id: "exec_1" },
      { id: "disp_b", product: "Coffee Beans 100 G", status: "closed", is_open: false, execution_id: "exec_2" },
    ]})));
    const out = text(await captureTools().firestarter_disputes({}));

    expect(out).not.toContain("closed (closed)");
    expect(out).toContain("disp_a");
    expect(out).toContain("disp_b");
  });
});
