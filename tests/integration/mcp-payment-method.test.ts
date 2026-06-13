/**
 * Surfacing the payment-method setup link in chat.
 *
 * When an order is approved but the org has no payment method, the worker parks
 * it on `awaiting_payment_method` and stores a no-login setup_url. Previously
 * the MCP layer never relayed that link (pollExecution didn't stop on the
 * parked state, and formatExecution didn't render it), so chat buyers were
 * stuck and orders parked forever. These tests pin the fix via the public
 * firestarter_status tool (which runs formatExecution).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch(exec: any) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      if (method === "GET" && String(url).includes("/v1/executions/")) {
        return jsonResponse(200, exec);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    })
  );
}

function allText(res: any): string {
  return (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_status — awaiting_payment_method surfaces the setup link", () => {
  it("renders the setup_url and a clear call to action", async () => {
    installFetch({
      id: "exec_pm",
      status: "awaiting_payment_method",
      request_text: "iPhone Air",
      setup_url: "https://pay.test/setup/xyz",
      options: [],
      steps: [],
    });
    const tools = captureTools();

    const res = await tools.firestarter_status({ execution_id: "exec_pm" });
    const text = allText(res);

    expect(text).toContain("https://pay.test/setup/xyz");
    expect(text).toMatch(/payment method/i);
  });

  it("falls back to dashboard guidance when no setup_url is present", async () => {
    installFetch({
      id: "exec_pm2",
      status: "awaiting_payment_method",
      request_text: "iPhone Air",
      setup_url: null,
      options: [],
      steps: [],
    });
    const tools = captureTools();

    const res = await tools.firestarter_status({ execution_id: "exec_pm2" });
    const text = allText(res);

    expect(text).toMatch(/payment method/i);
    expect(text).not.toContain("undefined");
  });
});
