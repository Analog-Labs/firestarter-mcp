/**
 * firestarter_approve bare-"approve" resolution (issue #172).
 *
 * A user replying just "approve" in chat sends no execution_id. The approve
 * route needs an id, and the agent often no longer holds it a few turns after
 * the prompt — so the purchase used to dead-end with "nothing pending
 * approval". These tests pin the resolution contract when execution_id is
 * omitted:
 *   - exactly one awaiting_approval -> approve it (no id needed)
 *   - several awaiting_approval     -> ask which, do NOT approve
 *   - none awaiting_approval but one awaiting_payment_method -> target it so
 *     the approve route returns the actionable PAYMENT_METHOD_REQUIRED guidance
 *   - nothing pending               -> clear message, do NOT approve
 *
 * Same harness as mcp-approve-option.test.ts: real registered handler captured
 * via a fake McpServer, driven against a mocked global fetch.
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Route: GET /v1/executions(list) -> `list`; GET /v1/executions/:id -> the
 * matching row (status flips to paid after approve so pollExecution settles);
 * POST :id/approve -> onApprove() or 200.
 */
function installFetch(list: any[], overrides?: { onApprove?: () => Response }) {
  let approved = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ method, url: u, body });

      if (method === "POST" && u.endsWith("/approve")) {
        if (overrides?.onApprove) return overrides.onApprove();
        approved = true;
        return jsonResponse(200, { ok: true });
      }
      // list (has a query string, no trailing /:id)
      if (method === "GET" && u.includes("/v1/executions?")) {
        return jsonResponse(200, { executions: list, total: list.length });
      }
      // single execution (poll after approve)
      if (method === "GET" && u.includes("/v1/executions/")) {
        const id = u.split("/v1/executions/")[1].split("?")[0];
        const row = list.find((e) => e.id === id) || { id, status: "awaiting_approval", options: [], steps: [] };
        return jsonResponse(200, { ...row, status: approved ? "paid" : row.status, options: row.options || [], steps: [] });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    })
  );
}

beforeEach(() => {
  fetchCalls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_approve — bare approve (no execution_id, issue #172)", () => {
  it("approves the single awaiting_approval execution", async () => {
    installFetch([
      { id: "exec_only", status: "awaiting_approval", request_text: "burgundy shirt", options: [], steps: [] },
    ]);
    const tools = captureTools();

    const res = await tools.firestarter_approve({});

    const approve = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/approve"));
    expect(approve).toBeTruthy();
    expect(approve!.url).toContain("/v1/executions/exec_only/approve");
    expect(res.isError).toBeFalsy();
  });

  it("asks which when several are awaiting_approval, without approving any", async () => {
    installFetch([
      { id: "exec_a", status: "awaiting_approval", request_text: "scooter" },
      { id: "exec_b", status: "awaiting_approval", request_text: "electric bike" },
    ]);
    const tools = captureTools();

    const res = await tools.firestarter_approve({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/2 purchases awaiting approval/);
    expect(res.content[0].text).toContain("exec_a");
    expect(res.content[0].text).toContain("exec_b");
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("falls back to a parked awaiting_payment_method order (actionable, not a dead end)", async () => {
    installFetch(
      [{ id: "exec_pay", status: "awaiting_payment_method", request_text: "iphone" }],
      {
        onApprove: () =>
          jsonResponse(409, {
            error: "This order is already approved and is waiting on a payment method. Add one here: https://pay.test/setup",
            code: "PAYMENT_METHOD_REQUIRED",
          }),
      }
    );
    const tools = captureTools();

    const res = await tools.firestarter_approve({});

    const approve = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/approve"));
    expect(approve!.url).toContain("/v1/executions/exec_pay/approve");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/payment method/i);
    // crucially NOT the dead "nothing pending approval" message
    expect(res.content[0].text).not.toMatch(/nothing/i);
  });

  it("returns a clear message and does not approve when nothing is pending", async () => {
    installFetch([
      { id: "exec_done", status: "completed", request_text: "old order" },
    ]);
    const tools = captureTools();

    const res = await tools.firestarter_approve({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/nothing awaiting your approval/i);
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });
});
