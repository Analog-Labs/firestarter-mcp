/**
 * #526 MCP surface: fulfillment_mode passthrough on firestarter_list and
 * firestarter_update_listing.
 *
 * QA 2026-08-10 retest: "still no seller-fulfilled option on firestarter_list,
 * so 'no platform label was purchased' remains unreachable from MCP." The API
 * honors listings.fulfillment_mode at ship time (explicit 'seller_managed'
 * holds the paid order in awaiting_shipment for firestarter_ship_order); these
 * tools are the surface that lets a seller's agent actually set it.
 *
 * Same fake-McpServer + mocked-fetch harness as mcp-set-shipping-policy.test.ts.
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
      new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

function bodyOf(fetchMock: ReturnType<typeof installFetch>, n = 0): any {
  return JSON.parse((fetchMock.mock.calls[n][1] as any).body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fulfillment_mode passthrough (#526)", () => {
  it("firestarter_list forwards 'seller_managed' and tells the seller how the hold works", async () => {
    const fetchMock = installFetch(200, {
      id: "lst_fm1",
      product_name: "Hand-thrown Mug",
      base_price: 30,
      status: "active",
      fulfillment_mode: "seller_managed",
      images: ["https://img/mug.jpg"],
    });
    const tools = captureTools();

    const res = await tools.firestarter_list({
      product_name: "Hand-thrown Mug",
      base_price: 30,
      fulfillment_mode: "seller_managed",
    });

    expect(res.isError).toBeFalsy();
    expect(bodyOf(fetchMock).fulfillment_mode).toBe("seller_managed");
    const text = textOf(res);
    expect(text).toContain("seller-managed");
    expect(text).toContain("firestarter_ship_order");
  });

  it("firestarter_list omits the field entirely when not given (auto)", async () => {
    const fetchMock = installFetch(200, {
      id: "lst_fm2",
      product_name: "Hand-thrown Mug",
      base_price: 30,
      status: "active",
      images: ["https://img/mug.jpg"],
    });
    const tools = captureTools();

    const res = await tools.firestarter_list({ product_name: "Hand-thrown Mug", base_price: 30 });

    expect(res.isError).toBeFalsy();
    expect("fulfillment_mode" in bodyOf(fetchMock)).toBe(false);
  });

  it("firestarter_update_listing PATCHes fulfillment_mode on an existing listing", async () => {
    const fetchMock = installFetch(200, {
      id: "lst_fm3",
      product_name: "Hand-thrown Mug",
      status: "active",
      fulfillment_mode: "seller_managed",
    });
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({
      listing_id: "lst_fm3",
      fulfillment_mode: "seller_managed",
    });

    expect(res.isError).toBeFalsy();
    const [url, opts] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toContain("/v1/listings/lst_fm3");
    expect((opts as any).method).toBe("PATCH");
    expect(bodyOf(fetchMock).fulfillment_mode).toBe("seller_managed");
  });

  it("firestarter_update_listing forwards an explicit null (clear back to auto)", async () => {
    const fetchMock = installFetch(200, {
      id: "lst_fm4",
      product_name: "Hand-thrown Mug",
      status: "active",
    });
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({
      listing_id: "lst_fm4",
      fulfillment_mode: null,
    });

    expect(res.isError).toBeFalsy();
    const body = bodyOf(fetchMock);
    expect("fulfillment_mode" in body).toBe(true);
    expect(body.fulfillment_mode).toBeNull();
  });
});
