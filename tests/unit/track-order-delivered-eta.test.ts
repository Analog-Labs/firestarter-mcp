/**
 * commerce#1025 — a delivered order must not also carry a future ETA.
 *
 * Reported verbatim: "It's showing Delivered and in next line it's showing
 * Delivery by Monday 31 August. Isn't it contradictory". It was.
 * `estimated_delivery` is the carrier ETA captured once at label time; nothing
 * supersedes it, and firestarter_track_order printed it unconditionally
 * immediately above `Status: delivered`.
 *
 * The real delivery date was already in the same payload — getExecutionTracking
 * emits a `delivered` event from orders.delivered_at, which the tool prints ten
 * lines lower under "Recent events". So the output stated the arrival twice and
 * contradicted itself once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deliveryStatusLine, registerTools } from "../../src/mcp/tools.js";

// The exact shape behind the report: shipped Aug 30 with an Aug 31 ETA, then
// delivered the same day — a day AHEAD of the estimate.
const DELIVERED = {
  status: "delivered",
  estimated_delivery: "2026-08-31",
  events: [
    { status: "shipped", detail: "Shipped via TestCarrier", date: "2026-08-30T09:00:00.000Z" },
    { status: "delivered", detail: "Package delivered", date: "2026-08-30T17:20:00.000Z" },
  ],
};

describe("deliveryStatusLine", () => {
  it("replaces the ETA with the real delivery date once delivered", () => {
    const line = deliveryStatusLine(DELIVERED)!;
    expect(line).toContain("Delivered:");
    expect(line).toContain("Aug 30, 2026");
    // The contradiction itself: no future promise under a past fact.
    expect(line).not.toContain("Estimated");
    expect(line).not.toContain("Aug 31");
  });

  it("still says delivered when only the EVENT knows it, not the status field", () => {
    const { status, ...noStatus } = DELIVERED;
    expect(deliveryStatusLine(noStatus)).toContain("Delivered:");
  });

  it("still says delivered when no timestamp was recorded, rather than falling back to the ETA", () => {
    const line = deliveryStatusLine({ status: "delivered", estimated_delivery: "2026-08-31", events: [] });
    expect(line).toBe("Delivered");
  });

  it("promises nothing for an order that will never arrive", () => {
    for (const status of ["cancelled", "canceled", "refunded", "failed", "returned"]) {
      expect(deliveryStatusLine({ status, estimated_delivery: "2026-08-31" })).toBeNull();
    }
  });

  it("still quotes the carrier ETA while the parcel is in transit", () => {
    const line = deliveryStatusLine({ status: "in_transit", estimated_delivery: "2026-08-31" })!;
    expect(line).toBe("Estimated delivery: Mon, Aug 31, 2026");
  });

  it("falls back to the date promised at approval, and says so", () => {
    const line = deliveryStatusLine({ status: "shipped", promised_delivery_date: "2026-09-02" })!;
    expect(line).toBe("Estimated delivery: ~Wed, Sep 2, 2026 (quoted at approval)");
  });

  it("says nothing at all when no date is known", () => {
    expect(deliveryStatusLine({ status: "shipped" })).toBeNull();
    expect(deliveryStatusLine({})).toBeNull();
  });
});

// ── The wiring, not just the helper ───────────────────────────────────────────
// Without this the helper could be perfect and unused: the seven cases above
// all still pass if the call site keeps printing the old unconditional ETA.

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; },
    registerTool: (name: string, _cfg: any, handler: ToolHandler) => { tools[name] = handler; },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

function text(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_track_order output", () => {
  it("does not put a future ETA under a delivered status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...DELIVERED,
      tracking_number: "TEST_hmfEj47SOvHv",
      carrier: "TestCarrier",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const out = text(await captureTools().firestarter_track_order({ execution_id: "exec_ixH5FpX1" }));

    expect(out).toContain("Status: delivered");
    expect(out).toContain("Delivered: Sun, Aug 30, 2026");
    // The line the reporter screenshotted.
    expect(out).not.toMatch(/Estimated delivery/);
  });
});
