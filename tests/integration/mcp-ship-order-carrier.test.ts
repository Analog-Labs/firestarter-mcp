/**
 * commerce #526 / PR #1097: the API no longer fills an omitted carrier with
 * "USPS". It infers the carrier when the number's format identifies it (UPS
 * 1Z…, USPS IMpb) and otherwise answers 400 CARRIER_REQUIRED. The tool must
 * (a) report the carrier the API actually recorded, never a client-side
 * "USPS", and (b) turn CARRIER_REQUIRED into an ask for the courier's name.
 *
 * Same fake-McpServer + mocked-fetch harness as mcp-listing-fulfillment-mode.
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
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

function installFetch(status: number, json: any) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_ship_order carrier handling (#526)", () => {
  it("reports the carrier the API recorded when the seller omitted it", async () => {
    installFetch(200, {
      execution_id: "exec_1", shipment_id: "shp_1", tracking_number: "1Z999AA10123456784",
      tracking_url: "https://www.ups.com/track?tracknum=1Z999AA10123456784", carrier: "UPS", status: "shipped",
    });
    const res = await captureTools().firestarter_ship_order({ order_id: "ord_1", tracking_number: "1Z999AA10123456784" });
    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("UPS 1Z999AA10123456784");
    expect(text).not.toContain("USPS");
  });

  it("asks for the courier's name when the API answers CARRIER_REQUIRED", async () => {
    installFetch(400, {
      error: "carrier is required: that tracking number's format doesn't identify the carrier.",
      code: "CARRIER_REQUIRED", status: 400,
    });
    const res = await captureTools().firestarter_ship_order({ order_id: "ord_1", tracking_number: "TH123456789" });
    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/which carrier|courier/i);
    expect(text).toContain("carrier");
    expect(text).not.toMatch(/defaults? to USPS/i);
  });
});
