/**
 * API error bodies must reach the user as PROSE, whatever their shape.
 *
 * The commerce API's errorResponse puts a STRING in `error`, but anything
 * nonstandard in front of it (a proxy's JSON error page, a non-commerce
 * upstream) can put an OBJECT there — which stringified to
 * "Error …: [object Object]" in every tool. Robustness audit, 2026-08-21.
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
  registerTools(fakeServer as any, "fs_test_error_shapes", "http://api.test");
  return tools;
}

function jsonError(body: unknown, status = 500): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function text(res: any): string {
  return (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("error bodies of every shape render as prose", () => {
  it("string error passes through verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonError({ error: "Listing not found", code: "NOT_FOUND" }, 404)));
    const t = text(await captureTools().firestarter_seller_orders({}));
    expect(t).not.toContain("[object Object]");
    expect(t).toContain("Listing not found");
  });

  it("object error {error:{message}} surfaces the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonError({ error: { code: "INTERNAL", message: "upstream exploded" } })));
    const t = text(await captureTools().firestarter_seller_orders({}));
    expect(t).not.toContain("[object Object]");
    expect(t).toContain("upstream exploded");
  });

  it("top-level {message} without error falls back to it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonError({ message: "gateway timeout" }, 504)));
    const t = text(await captureTools().firestarter_seller_orders({}));
    expect(t).not.toContain("[object Object]");
    expect(t).toContain("gateway timeout");
  });

  it("no usable field at all falls back to the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonError({ error: {} }, 502)));
    const t = text(await captureTools().firestarter_seller_orders({}));
    expect(t).not.toContain("[object Object]");
    expect(t).toContain("502");
  });
});
