/**
 * firestarter_list / firestarter_update_listing — listing detail fields
 * (brand, sku, condition, dimensions, materials, tags, variants, return
 * policy, ship time, country of origin). Companion to mcp-listing-images.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, url: String(url), body });
    if (method === "POST" && String(url).endsWith("/v1/listings")) {
      return jsonResponse(201, { id: "lst_new1", product_name: body.product_name, base_price: body.base_price, status: "active" });
    }
    if (method === "PATCH" && String(url).includes("/v1/listings/")) {
      return jsonResponse(200, { id: "lst_new1", product_name: "X", status: "active" });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_list — listing detail fields", () => {
  it("forwards brand/condition/dimensions/materials/tags/variants to the create body", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_list({
      product_name: "Trail Runner Jacket", base_price: 89,
      brand: "Acme Outdoors", sku: "ACME-TRJ-001", condition: "new",
      length_in: 12, width_in: 8, height_in: 3, weight_oz: 14,
      country_of_origin: "VN", materials: ["nylon"], tags: ["hiking"],
      return_policy: "30-day returns", ship_time_days: 2,
      variants: [{ label: "Medium", sku: "ACME-TRJ-001-M" }],
    });

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect(post?.body.brand).toBe("Acme Outdoors");
    expect(post?.body.sku).toBe("ACME-TRJ-001");
    expect(post?.body.materials).toEqual(["nylon"]);
    expect(post?.body.variants).toEqual([{ label: "Medium", sku: "ACME-TRJ-001-M" }]);
  });

  it("omits detail fields entirely when not given (back-compat)", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_list({ product_name: "No Detail Item", base_price: 10 });

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect("brand" in (post?.body ?? {})).toBe(false);
    expect("variants" in (post?.body ?? {})).toBe(false);
  });
});

describe("firestarter_update_listing — listing detail fields", () => {
  it("forwards brand/condition/materials/tags/variants to the PATCH body", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_update_listing({
      listing_id: "lst_new1", brand: "Acme Outdoors", condition: "used_good",
      materials: ["nylon"], tags: ["hiking"], return_policy: "30-day returns",
      variants: [{ label: "Medium", sku: "ACME-TRJ-001-M" }],
    });

    const patch = fetchCalls.find((c) => c.method === "PATCH");
    expect(patch?.body.brand).toBe("Acme Outdoors");
    expect(patch?.body.condition).toBe("used_good");
    expect(patch?.body.variants).toEqual([{ label: "Medium", sku: "ACME-TRJ-001-M" }]);
  });
});
