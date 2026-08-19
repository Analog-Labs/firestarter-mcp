/**
 * Accuracy of the information tool results state.
 *
 * From an audit of what the MCP actually tells buyers and sellers. Each case
 * here failed against the shipped v2.3.0 output:
 *
 *  - "all-in" was printed on totals that excluded an unknown shipping cost, on
 *    the same line as "shipping calculated at checkout". That is what made a
 *    shipping-INCLUSIVE step summary ($20.60) contradict a shipping-EXCLUSIVE
 *    row ($13.61) for one item in a live run — the $6.99 estimate.
 *  - money was interpolated raw behind a hardcoded "$", so a THB listing (which
 *    stays browse-only because checkout can only charge USD, but is still
 *    SHOWN) read as "$255" and 13.6 rendered as "$13.6".
 *  - a TEST-MODE receipt was indistinguishable from a real one, complete with a
 *    charge id — screenshot-able as proof of a payment that never happened.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(key = "fs_live_k"): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, key, "http://api.test");
  return tools;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function textOf(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

/** One execution awaiting approval carrying a single option. */
function execWith(option: any) {
  return {
    id: "exec_1", status: "awaiting_approval", request_text: "thing",
    options: [{ id: "opt_1", product_title: "Thing", supplier: "Store", selected: true, purchasable: true, ...option }],
    steps: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("totals only claim all-in when they are", () => {
  it("says item total + shipping-at-checkout when shipping is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(execWith({ total: 13.61, subtotal: 13.61, shipping: null }))));
    const out = textOf(await captureTools().firestarter_status({ execution_id: "exec_1" }));

    expect(out).toContain("$13.61 item total — shipping calculated at checkout");
    expect(out).not.toContain("all-in");
  });

  it("still says all-in when every component is known", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(execWith({ total: 20.60, subtotal: 13.61, shipping: 6.99, tax: 0 }))));
    const out = textOf(await captureTools().firestarter_status({ execution_id: "exec_1" }));

    expect(out).toContain("**$20.60 all-in**");
    expect(out).toContain("$6.99 shipping");
  });
});

describe("money formatting", () => {
  it("prefixes a non-USD option with its currency instead of a dollar sign", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(execWith({
      total: 255, subtotal: 255, shipping: 0, currency: "THB", purchasable: false,
    }))));
    const out = textOf(await captureTools().firestarter_status({ execution_id: "exec_1" }));

    expect(out).toContain("THB 255.00");
    expect(out).not.toContain("$255");
  });

  it("always shows two decimals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(execWith({ total: 13.6, subtotal: 13.6, shipping: 0 }))));
    const out = textOf(await captureTools().firestarter_status({ execution_id: "exec_1" }));

    expect(out).toContain("$13.60");
    expect(out).not.toContain("$13.6 ");
  });
});

describe("test-mode receipts are labelled", () => {
  const receipt = {
    paid_at: "2026-08-14T09:11:14.123Z", product_title: "Thing",
    subtotal_cents: 1361, total_cents: 2060, stripe_charge_id: "ch_test_1",
  };

  it("marks a sandbox receipt as simulated, before any money line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(receipt)));
    const out = textOf(await captureTools("fs_test_k").firestarter_receipt({ execution_id: "exec_1" }));

    expect(out).toContain("TEST MODE");
    expect(out).toContain("No money moved");
    expect(out.indexOf("TEST MODE")).toBeLessThan(out.indexOf("Total"));
  });

  it("leaves a live receipt unmarked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(receipt)));
    const out = textOf(await captureTools("fs_live_k").firestarter_receipt({ execution_id: "exec_1" }));

    expect(out).not.toContain("TEST MODE");
  });

  // Dates were fixed concurrently on main (#599 QA pass, formatBuyerDate).
  // Kept as a regression guard, asserting THAT formatter rather than a second
  // one: this PR deleted its own date helpers in favour of it.
  it("renders the paid date through the shared buyer-date formatter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(receipt)));
    const out = textOf(await captureTools().firestarter_receipt({ execution_id: "exec_1" }));

    expect(out).toContain("Date: Fri, Aug 14, 2026, 9:11 AM UTC");
    expect(out).not.toContain("2026-08-14T09:11:14.123Z");
  });
});

describe("browse-only is explained truthfully", () => {
  // Payout rails stopped gating checkout when sell-first shipped; telling a
  // seller to "finish Stripe Connect" no longer fixes anything.
  it("never blames Stripe Connect or un-enabled checkout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      query: { environment: "live" }, count: 1, has_more: false,
      listings: [{ id: "lst_1", product_name: "Thing", current_price: 5, currency: "USD", buyable: false, images: [] }],
    })));
    const out = textOf(await captureTools().firestarter_catalog_search({ query: "thing" }));

    expect(out).not.toContain("Stripe Connect");
    expect(out).not.toContain("enabled checkout");
  });
});
