/**
 * QA 2026-08-13 (firestarter-commerce#726): firestarter_seller_analytics
 * printed "Total revenue: $0.00 / Total orders: 0" while
 * firestarter_seller_orders listed 17 orders for the same account, same key,
 * same moment — so the agent reported $0 revenue over 17 real order lines.
 *
 * The API side now explains the gap: /v1/sellers/analytics returns the
 * excluded test-mode figures and `orders_recorded` (the raw count the orders
 * list shows) alongside live revenue, and /v1/sellers/orders labels each row
 * with test_mode. These tests lock the agent-facing half — a bare "$0.00" with
 * no reason is what made this a bug report instead of a shrug.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatSellerAnalytics, registerTools } from "../../src/mcp/tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const analytics = (over: Record<string, unknown> = {}) => ({
  revenue_cents: 0,
  orders: 0,
  avg_order_cents: 0,
  test_revenue_cents: 0,
  test_orders: 0,
  orders_recorded: 0,
  daily: [],
  ...over,
});

describe("formatSellerAnalytics", () => {
  it("explains a $0 caused entirely by test-mode orders", () => {
    const text = formatSellerAnalytics(analytics({
      test_revenue_cents: 108282, test_orders: 17, orders_recorded: 17,
    }));

    expect(text).toContain("Total revenue: $0.00");
    // The reason, not just the number.
    expect(text).toContain("17");
    expect(text).toMatch(/test mode/i);
    expect(text).toContain("$1082.82");
  });

  it("explains orders that carry no ledger row", () => {
    const text = formatSellerAnalytics(analytics({ orders_recorded: 17 }));
    expect(text).toMatch(/17 order/i);
    expect(text).toMatch(/not (yet )?paid|no payment|awaiting payment/i);
  });

  it("stays quiet when live figures account for everything", () => {
    const text = formatSellerAnalytics(analytics({
      revenue_cents: 108282, orders: 11, avg_order_cents: 9844, orders_recorded: 11,
    }));

    expect(text).toContain("Total revenue: $1082.82");
    expect(text).toContain("Total orders: 11");
    expect(text).not.toMatch(/test mode/i);
    expect(text).not.toMatch(/no ledger|not yet paid/i);
  });

  it("survives an API response without the new fields", () => {
    const text = formatSellerAnalytics({ revenue_cents: 5000, orders: 2, avg_order_cents: 2500 });
    expect(text).toContain("Total revenue: $50.00");
    expect(text).toContain("Total orders: 2");
  });
});

describe("firestarter_seller_orders — marks test-mode orders", () => {
  function captureTool(name: string): (args: any) => Promise<any> {
    let handler: ((args: any) => Promise<any>) | null = null;
    const stub = {
      tool: (toolName: string, _desc: string, _schema: any, _ann: any, cb: any) => {
        if (toolName === name) handler = cb;
      },
    } as any;
    registerTools(stub, "fs_test_sellerorders", "http://api.local");
    if (!handler) throw new Error(`tool ${name} was not registered`);
    return handler;
  }

  function stubFetch(body: any) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  }

  it("labels a test-mode order so it cannot be read as a real sale", async () => {
    stubFetch({
      orders: [
        {
          id: "ord_test", product_title: "Test Widget", quantity: 1, amount_cents: 4999,
          net_payout_cents: 4700, status: "delivered", payout_status: "pending", test_mode: true,
        },
        {
          id: "ord_live", product_title: "Real Widget", quantity: 1, amount_cents: 2000,
          net_payout_cents: 1850, status: "delivered", payout_status: "pending", test_mode: false,
        },
      ],
    });

    const res = await captureTool("firestarter_seller_orders")({});
    const text = res.content.map((b: any) => b.text ?? "").join("\n");

    const testLine = text.split("\n").find((l: string) => l.includes("Test Widget")) ?? "";
    const liveLine = text.split("\n").find((l: string) => l.includes("Real Widget")) ?? "";
    expect(testLine).toMatch(/test mode/i);
    expect(liveLine).not.toMatch(/test mode/i);
  });
});
