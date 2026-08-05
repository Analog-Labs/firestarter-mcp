/**
 * firestarter_list — source_url param (#569). Companion to
 * mcp-listing-details.test.ts; confirms the new optional field reaches the
 * create-listing REST call unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => { tools[name] = handler; },
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
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_list — source_url (#569)", () => {
  it("forwards source_url to the create-listing REST call when given", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_list({
      product_name: "Blue Ceramic Mug", base_price: 12,
      source_url: "https://example.com/products/blue-mug",
    });

    const createCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect(createCall).toBeDefined();
    expect(createCall!.body.source_url).toBe("https://example.com/products/blue-mug");
  });

  it("omits source_url from the REST body when not given (no undefined leaking through)", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_list({ product_name: "Blue Ceramic Mug", base_price: 12 });

    const createCall = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect(createCall!.body.source_url).toBeUndefined();
    expect("source_url" in createCall!.body).toBe(false);
  });
});
