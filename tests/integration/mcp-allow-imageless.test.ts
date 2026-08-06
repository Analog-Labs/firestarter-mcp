/**
 * `allow_imageless: true` documented override for the NEEDS_IMAGE activation
 * gate — supported server-side (listing-create.ts, listings.ts PATCH), but
 * missing from both firestarter_list and firestarter_update_listing's MCP
 * input schemas, so an MCP agent had no way to pass it through: the field
 * was silently stripped before the request body was ever built.
 *
 * Same harness as mcp-import.test.ts: drive the REAL registered tool handlers
 * (captured via a fake McpServer) against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

// The real MCP SDK parses incoming args through `z.object(rawShape)` (strip
// mode: undeclared keys are silently dropped) before calling the handler
// (server/mcp.js `safeParseAsync(argsObj, request.params.arguments)`), so a
// harness that hands the handler its raw test input — bypassing that parse —
// would pass even when a field is missing from the schema. Replicate the real
// parse step here so a schema gap actually fails the test.
function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      // (description, schema, [annotations], handler) — annotations is
      // optional, so the handler is always the last argument.
      const handler = rest[rest.length - 1];
      const shape = z.object(rest[1]);
      tools[name] = (args: any) => handler(shape.parse(args));
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

type RecordedCall = { method: string; url: string; body: any };

function installFetch(
  respond: (method: string, url: string, body: any) => { status: number; json: any }
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(url), body });
      const { status, json } = respond(method, String(url), body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("allow_imageless passthrough", () => {
  it("firestarter_list forwards allow_imageless: true in the POST /v1/listings body", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({
      status: 201,
      json: { id: "lst_1", product_name: "Widget", status: "active", base_price: 10 },
    }));

    await tools.firestarter_list({ product_name: "Widget", base_price: 10, allow_imageless: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.allow_imageless).toBe(true);
  });

  it("firestarter_update_listing forwards allow_imageless: true in the PATCH body", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({
      status: 200,
      json: { id: "lst_1", product_name: "Widget", status: "active" },
    }));

    await tools.firestarter_update_listing({ listing_id: "lst_1", status: "active", allow_imageless: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.allow_imageless).toBe(true);
  });
});
