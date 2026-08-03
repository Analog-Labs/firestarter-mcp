import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, _d: string, _s: any, handler: ToolHandler) => { tools[name] = handler; } };
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
    if (method === "POST" && String(url).endsWith("/v1/listings/bulk")) {
      return jsonResponse(201, {
        created: [{ index: 0, id: "lst_bulk1", status: "active" }],
        failed: [{ index: 1, error: "base_price is required", code: "MISSING_BASE_PRICE" }],
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_bulk_list", () => {
  it("forwards the products array to POST /v1/listings/bulk", async () => {
    installFetch();
    const tools = captureTools();
    await tools.firestarter_bulk_list({
      products: [
        { product_name: "Widget A", base_price: 10 },
        { product_name: "Widget B" },
      ],
    });
    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings/bulk"));
    expect(post?.body.products).toHaveLength(2);
    expect(post?.body.products[0].product_name).toBe("Widget A");
  });

  it("summarizes created and failed counts in the response text", async () => {
    installFetch();
    const tools = captureTools();
    const result = await tools.firestarter_bulk_list({
      products: [{ product_name: "Widget A", base_price: 10 }, { product_name: "Widget B" }],
    });
    const text = result.content[0].text as string;
    expect(text).toMatch(/1 created/i);
    expect(text).toMatch(/1 failed/i);
    expect(text).toContain("lst_bulk1");
    expect(text).toMatch(/MISSING_BASE_PRICE|base_price is required/);
  });
});
