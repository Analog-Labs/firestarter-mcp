import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch(existingConnections: any[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, url: String(url), body });
    if (method === "GET" && String(url).endsWith("/v1/connections")) {
      return jsonResponse(200, { connections: existingConnections });
    }
    if (method === "POST" && String(url).endsWith("/v1/connections")) {
      return jsonResponse(201, { id: "conn_new1", platform: body.platform, shop_domain: body.shop_domain, status: "active" });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_connect_store", () => {
  it("reports an existing connection for the given platform without creating a new one", async () => {
    installFetch([{ id: "conn_1", platform: "bigcommerce", shop_domain: "store123", status: "active", shop_name: "My Store" }]);
    const tools = captureTools();
    const result = await tools.firestarter_connect_store({ platform: "bigcommerce" });
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(result.content[0].text).toMatch(/My Store|store123/);
  });

  it("connects with access_token + shop_domain for bigcommerce/shopee/lazada/wix", async () => {
    installFetch([]);
    const tools = captureTools();
    await tools.firestarter_connect_store({ platform: "bigcommerce", access_token: "tok_abc", shop_domain: "store123" });
    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/connections"));
    expect(post?.body).toEqual({ platform: "bigcommerce", access_token: "tok_abc", shop_domain: "store123" });
  });

  it("base64-encodes consumer_key:consumer_secret into access_token for woocommerce", async () => {
    installFetch([]);
    const tools = captureTools();
    await tools.firestarter_connect_store({
      // shop_domain is a BARE domain, no scheme — the woocommerceAdapter builds
      // `https://${shop_domain}/wp-json/...` itself, so a scheme here would
      // produce a broken "https://https://..." request URL.
      platform: "woocommerce", shop_domain: "mystore.com",
      consumer_key: "ck_123", consumer_secret: "cs_456",
    });
    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/connections"));
    expect(post?.body.platform).toBe("woocommerce");
    expect(post?.body.shop_domain).toBe("mystore.com");
    expect(post?.body.access_token).toBe(Buffer.from("ck_123:cs_456").toString("base64"));
  });

  it("strips a leading https:// from shop_domain for woocommerce (defensive, in case an agent includes it anyway)", async () => {
    installFetch([]);
    const tools = captureTools();
    await tools.firestarter_connect_store({
      platform: "woocommerce", shop_domain: "https://mystore.com",
      consumer_key: "ck_123", consumer_secret: "cs_456",
    });
    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/connections"));
    expect(post?.body.shop_domain).toBe("mystore.com");
  });

  it("rejects shopify and tiktok_shop without calling the API", async () => {
    installFetch([]);
    const tools = captureTools();
    const result = await tools.firestarter_connect_store({ platform: "shopify" as any, access_token: "x", shop_domain: "y" });
    expect(fetchCalls).toHaveLength(0);
    expect(result.content[0].text).toMatch(/firestarter_connect_shopify/i);
  });

  it("asks for missing credentials instead of calling the API with a partial request", async () => {
    installFetch([]);
    const tools = captureTools();
    const result = await tools.firestarter_connect_store({ platform: "shopee" });
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(result.content[0].text).toMatch(/access_token|shop_domain/i);
  });
});
