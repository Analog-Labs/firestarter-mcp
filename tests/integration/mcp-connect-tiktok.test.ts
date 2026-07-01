/**
 * firestarter_connect_tiktok — token-paste TikTok Shop connection (issue
 * #564/#526/#501). The tool checks for an existing connection, guides the
 * seller through Partner Center token paste when nothing is set, and creates
 * the connection via POST /v1/connections when given access_token + shop id.
 * Same harness as the other mcp-*.test.ts: real registered handlers via a fake
 * McpServer against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    { tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => { tools[name] = handler; } } as any,
    "fsk_test_key",
    "http://api.test",
  );
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function installFetch(handler: (method: string, url: string, body: any) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ method, url: String(url), body });
      return handler(method, String(url), body);
    }),
  );
}

function json(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_connect_tiktok", () => {
  it("gives token-paste setup instructions when nothing is connected and no creds passed", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) return json(200, { connections: [] });
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({}));
    expect(text).toMatch(/No TikTok Shop connected/i);
    expect(text).toMatch(/Partner Center/i);
    // must NOT have attempted to create a connection
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("creates the connection when given access_token + shop_domain", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) return json(200, { connections: [] });
      if (m === "POST" && u.endsWith("/v1/connections")) return json(201, { id: "conn_x", platform: "tiktok_shop", status: "active" });
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({ access_token: "tok_secret", shop_domain: "shop_123" }));

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/connections"));
    expect(post).toBeTruthy();
    expect(post!.body).toMatchObject({ platform: "tiktok_shop", access_token: "tok_secret", shop_domain: "shop_123" });
    expect(text).toMatch(/TikTok Shop connected/i);
    // never echo the secret token back
    expect(text).not.toContain("tok_secret");
  });

  it("asks for the shop id when only a token is provided", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) return json(200, { connections: [] });
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({ access_token: "tok_secret" }));
    expect(text).toMatch(/shop id/i);
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("returns status when a TikTok Shop is already connected", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, { connections: [{ platform: "tiktok_shop", shop_name: "My TT Shop", shop_domain: "shop_123", status: "active", last_synced_at: "2026-06-28T00:00:00Z" }] });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({}));
    expect(text).toMatch(/TikTok Shop connected:.*My TT Shop/i);
    expect(text).toMatch(/active/);
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("surfaces a seller-registration hint when the org has no seller profile", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) return json(200, { connections: [] });
      if (m === "POST" && u.endsWith("/v1/connections")) return json(403, { error: "Register as a seller first via POST /v1/sellers", code: "NO_SELLER_PROFILE" });
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const res = await tools.firestarter_connect_tiktok({ access_token: "t", shop_domain: "s" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/firestarter\.network\/sell/i);
  });
});
