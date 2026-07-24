import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools({
    tool: (name: string, ...args: any[]) => {
      tools[name] = args[args.length - 1] as ToolHandler;
    },
  } as any, "fs_live_context", "http://api.test");
  return tools;
}

function response(data: any): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function textOf(result: any): string {
  return result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("MCP order and shipping context", () => {
  it("uses the order fulfillment status while retaining the workflow state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      id: "exec_1",
      status: "shipping",
      order_status: "delivered",
      display_status: "delivered",
      request_text: "Coffee set",
      options: [],
      steps: [],
    })));

    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_1" }));
    expect(text).toContain("Status: delivered");
    expect(text).toContain("Workflow state: shipping");
  });

  it("renders ship-from, provider/carrier, and the explicit quote breakdown", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/shipping-options")) {
        return response({
          product_title: "Coffee set",
          ship_from: { city: "Austin", state: "TX", country: "US", source: "listing" },
          ship_to: { city: "Bangkok", state: "Bangkok", country: "TH" },
          fee_breakdown: { subtotal_cents: 4000, tax_cents: 320 },
          options: [{
            index: 0,
            label: "UPS Worldwide Saver",
            provider: "shippo",
            carrier: "UPS",
            service: "Worldwide Saver",
            price_cents: 800,
            all_in_cents: 5120,
            delivery_days: 3,
            badges: [],
            is_estimated: false,
          }],
        });
      }
      return response({ developer_margin: null });
    }));

    const text = textOf(await captureTools().firestarter_shipping_options({ execution_id: "exec_1" }));
    expect(text).toContain("Ships from: Austin, TX, US");
    expect(text).toContain("Ships to: Bangkok, Bangkok, TH");
    expect(text).toContain("Item subtotal: $40.00");
    // Quoter-vs-shipper separation: the rating service is named in buyer terms
    // ("rate quoted by Shippo"), and the carrier leads the row label ("UPS
    // Worldwide Saver") — never the old internal-enum dump (provider:/carrier:).
    expect(text).toContain("rate quoted by Shippo");
    expect(text).toContain("UPS Worldwide Saver");
    expect(text).not.toContain("provider: shippo");
    expect(text).toContain("$51.20 all-in");
  });

  it("renders canonical tracking status, origin, provider, and paid fees", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      tracking_number: "1Z123",
      tracking_url: "https://track.example/1Z123",
      carrier: "UPS",
      status: "shipped",
      order_status: "shipped",
      ship_from: { city: "Austin", state: "TX", country: "US" },
      shipping_method: { provider: "shippo", carrier: "UPS", service: "Worldwide Saver" },
      fee_breakdown: { subtotal_cents: 4000, shipping_cents: 800, tax_cents: 320, total_cents: 5120 },
      events: [{ status: "shipped", detail: "Shipped via UPS (1Z123)", date: "2026-07-21T00:00:00Z" }],
    })));

    const text = textOf(await captureTools().firestarter_track_order({ execution_id: "exec_1" }));
    expect(text).toContain("Ships from: Austin, TX, US");
    // Post-ship: the label-purchase service is named in buyer terms, distinct
    // from the carrier moving the parcel.
    expect(text).toContain("Label booked via: Shippo");
    expect(text).toContain("Carrier: UPS");
    expect(text).toContain("Status: shipped");
    expect(text).toContain("Fees: item $40.00 + shipping $8.00 + tax $3.20 = $51.20");
    expect(text).toContain("Shipped via UPS (1Z123)");
  });
});
