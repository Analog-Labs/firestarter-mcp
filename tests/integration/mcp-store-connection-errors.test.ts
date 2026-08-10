/**
 * Store connection tools claiming success on an errored connection —
 * 2026-08-10 QA pass: TikTok Shop (status: error, invalid app_key) and
 * WooCommerce (status: error — fetch failed) both closed with "Products from
 * this store are listed on Firestarter and discoverable by buyers' agents",
 * even though a broken connection never synced a catalog to be discoverable.
 *
 * firestarter_connect_shopify already got this right in #556 (branches on
 * status === "error" instead of always claiming success) — firestarter_
 * connect_tiktok and the generic firestarter_connect_store never got the same
 * fix. This file pins the fix for both, plus two adjacent issues found while
 * root-causing: firestarter_sync_shopify blindly said "Catalog sync started"
 * with no caveat even when it already knew (from the connections list it had
 * just fetched) that the target connection was in an error state; and the
 * connection's error_message — which for TikTok/WooCommerce is the adapter's
 * raw upstream HTTP response body (see catalog-sync/adapters.ts's apiFetch:
 * `${status} ${statusText}: ${body}`) — was relayed to the seller verbatim,
 * including whatever internal fields (request_id, logid, error codes) the
 * upstream API put in that body.
 *
 * Same harness as mcp-connect-tiktok.test.ts / mcp-connect-store.test.ts: real
 * registered handlers via a fake McpServer against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } } as any,
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

describe("firestarter_connect_tiktok — errored connection", () => {
  const RAW_TIKTOK_ERROR = '401 Unauthorized: {"code":36004201,"message":"Invalid app_key","request_id":"20260810081234ABCDEF"}';

  it("does not claim products are listed/discoverable when status is error", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, {
          connections: [{ platform: "tiktok_shop", shop_name: "My TT Shop", shop_domain: "shop_123", status: "error", error_message: RAW_TIKTOK_ERROR }],
        });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({}));

    expect(text).toContain("Status: error");
    expect(text).not.toMatch(/listed on Firestarter and discoverable/i);
  });

  it("does not relay the raw upstream error body (request_id etc.) verbatim", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, {
          connections: [{ platform: "tiktok_shop", shop_name: "My TT Shop", shop_domain: "shop_123", status: "error", error_message: RAW_TIKTOK_ERROR }],
        });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({}));

    expect(text).not.toContain("request_id");
    expect(text).not.toContain("20260810081234ABCDEF");
    expect(text).not.toContain("36004201");
    // The status line itself is still useful context.
    expect(text).toContain("401 Unauthorized");
  });

  it("still claims discoverability for an active connection (regression guard)", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, { connections: [{ platform: "tiktok_shop", shop_name: "My TT Shop", shop_domain: "shop_123", status: "active" }] });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_tiktok({}));

    expect(text).toMatch(/listed on Firestarter and discoverable/i);
  });
});

describe("firestarter_connect_shopify — errored connection", () => {
  it("does not claim products are already listed when never-synced and status is error", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, { connections: [{ platform: "shopify", shop_domain: "store.myshopify.com", status: "error", error_message: "fetch failed" }] });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_shopify({}));

    expect(text).toContain("Status: error");
    expect(text).not.toMatch(/already listed on Firestarter and discoverable/i);
    expect(text).toMatch(/never completed a sync/i);
  });

  it("says items from the last sync remain listed (but stale) when status is error AFTER a prior successful sync", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, {
          connections: [{ platform: "shopify", shop_domain: "store.myshopify.com", status: "error", error_message: "fetch failed", last_synced_at: "2026-08-01T00:00:00Z" }],
        });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_shopify({}));

    expect(text).toMatch(/last successful sync remain listed/i);
    expect(text).not.toMatch(/never completed a sync/i);
  });

  it("still claims discoverability for an active connection (regression guard)", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, { connections: [{ platform: "shopify", shop_domain: "store.myshopify.com", status: "active" }] });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_shopify({}));

    expect(text).toMatch(/listed on Firestarter and discoverable/i);
  });
});

describe("firestarter_connect_store — errored connection (WooCommerce etc.)", () => {
  it("does not claim products are listed/discoverable when status is error", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, {
          connections: [{ platform: "woocommerce", shop_domain: "mystore.com", status: "error", error_message: "fetch failed" }],
        });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_store({ platform: "woocommerce" }));

    expect(text).toContain("Status: error");
    expect(text).not.toMatch(/listed on Firestarter and discoverable/i);
  });

  it("still claims discoverability for an active connection (regression guard)", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, { connections: [{ platform: "woocommerce", shop_domain: "mystore.com", status: "active" }] });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_connect_store({ platform: "woocommerce" }));

    expect(text).toMatch(/listed on Firestarter and discoverable/i);
  });
});

describe("firestarter_sync_shopify — syncing a connection already known to be broken", () => {
  it("warns the connection is in an error state instead of a bare 'sync started'", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, {
          connections: [{ id: "conn_woo1", platform: "woocommerce", shop_domain: "mystore.com", status: "error", error_message: "fetch failed" }],
        });
      }
      if (m === "POST" && u.endsWith("/v1/connections/conn_woo1/sync")) {
        return json(200, { message: "Sync started", connection_id: "conn_woo1" });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_sync_shopify({ connection_id: "conn_woo1" }));

    expect(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/conn_woo1/sync"))).toBe(true);
    expect(text.toLowerCase()).toMatch(/error state|previously failed|was in an error/);
  });

  it("no caveat for a healthy connection (regression guard)", async () => {
    installFetch((m, u) => {
      if (m === "GET" && u.endsWith("/v1/connections")) {
        return json(200, { connections: [{ id: "conn_shop1", platform: "shopify", shop_domain: "store.myshopify.com", status: "active" }] });
      }
      if (m === "POST" && u.endsWith("/v1/connections/conn_shop1/sync")) {
        return json(200, { message: "Sync started", connection_id: "conn_shop1" });
      }
      throw new Error(`unexpected ${m} ${u}`);
    });
    const tools = captureTools();
    const text = textOf(await tools.firestarter_sync_shopify({}));

    expect(text).toMatch(/Catalog sync started/i);
    expect(text.toLowerCase()).not.toMatch(/error state|previously failed|was in an error/);
  });
});
