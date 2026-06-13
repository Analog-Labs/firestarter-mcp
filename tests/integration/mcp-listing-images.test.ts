/**
 * firestarter_list / firestarter_update_listing image_urls support.
 *
 * Bug: a seller sends a photo in chat ("sell this for me"), the gateway hosts
 * it and hands the agent an [image attached: <url>] marker — but the MCP tools
 * had NO way to put that URL on the listing, so every chat-created listing went
 * up imageless and the agent fell back to "re-send the photo" (which also
 * couldn't work). The POST/PATCH /v1/listings routes already accept `images`;
 * these tests pin that the tools now forward image_urls -> body.images.
 *
 * Same harness as mcp-approve-option.test.ts: real registered handlers via a
 * fake McpServer against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ method, url: String(url), body });
      if (method === "POST" && String(url).endsWith("/v1/listings")) {
        return jsonResponse(201, { id: "lst_new1", product_name: body.product_name, base_price: body.base_price, status: "active", images: body.images || [] });
      }
      if (method === "PATCH" && String(url).includes("/v1/listings/")) {
        return jsonResponse(200, { id: "lst_new1", product_name: "X", status: "active", images: body.images ?? [] });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    })
  );
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_list / update — image_urls", () => {
  it("forwards image_urls to the create body as images", async () => {
    installFetch();
    const tools = captureTools();
    const url = "https://cole.pocodot.ai/api/poco/uploads/public/abc123";

    const res = await tools.firestarter_list({ product_name: "MX Master 3S", base_price: 40, image_urls: [url] });

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect(post?.body.images).toEqual([url]);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/1 attached/);
  });

  it("omits images when no image_urls given (back-compat)", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_list({ product_name: "No Photo Item", base_price: 10 });

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect("images" in (post?.body ?? {})).toBe(false);
  });

  it("forwards image_urls to the update body as images (attach photo to existing listing)", async () => {
    installFetch();
    const tools = captureTools();
    const url = "https://cole.pocodot.ai/api/poco/uploads/public/def456";

    const res = await tools.firestarter_update_listing({ listing_id: "lst_new1", image_urls: [url] });

    const patch = fetchCalls.find((c) => c.method === "PATCH");
    expect(patch?.body.images).toEqual([url]);
    expect(res.isError).toBeFalsy();
  });
});
