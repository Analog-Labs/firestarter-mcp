/**
 * firestarter_approve option targeting (post-#107 follow-up).
 *
 * The approve route takes `option_id`, but the MCP tool used to send
 * `selected_option` (an index) — which the API silently ignored, so every MCP
 * approval hit the pre-selected row no matter what the agent asked for.
 *
 * These tests drive the REAL registered tool handler (captured via a fake
 * McpServer) against a mocked global fetch, and pin the new contract:
 *   - `option_id` is passed straight through to the approve route
 *   - `selected_option` (0-based, display order) is resolved to the matching
 *     option id via GET /v1/executions/:id before approving
 *   - out-of-range indexes error out WITHOUT calling approve
 *   - omitting both approves the pre-selected option (empty body)
 *   - API rejections (e.g. #107 browse-only 422) surface their message
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

/** Recorded fetch calls: [method, url, parsedBody|undefined]. */
let fetchCalls: Array<{ method: string; url: string; body: any }>;

const EXEC_WITH_OPTIONS = {
  id: "exec_1",
  status: "awaiting_approval",
  request_text: "buy a widget",
  options: [
    { id: "opt_best", product_title: "Best Widget", total: 35, purchasable: true, selected: true },
    { id: "opt_alt", product_title: "Alt Widget", total: 30, purchasable: true, selected: false },
    { id: "opt_ext", product_title: "Ext Widget", total: 28, purchasable: false, selected: false },
  ],
  steps: [],
};

const PAID_EXEC = { ...EXEC_WITH_OPTIONS, status: "paid" };

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Default routing: GET execution -> awaiting (then paid after approve), POST approve -> ok. */
function installFetch(overrides?: {
  onApprove?: () => Response;
  execution?: any;
}) {
  let approved = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ method, url: String(url), body });

      if (method === "POST" && String(url).endsWith("/approve")) {
        if (overrides?.onApprove) return overrides.onApprove();
        approved = true;
        return jsonResponse(200, { ok: true });
      }
      if (method === "GET" && String(url).includes("/v1/executions/")) {
        const exec = overrides?.execution ?? (approved ? PAID_EXEC : EXEC_WITH_OPTIONS);
        return jsonResponse(200, exec);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    })
  );
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_approve — option targeting", () => {
  it("passes option_id straight through to the approve route", async () => {
    installFetch();
    const tools = captureTools();

    const res = await tools.firestarter_approve({ execution_id: "exec_1", option_id: "opt_alt" });

    const approve = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/approve"));
    expect(approve?.body).toEqual({ option_id: "opt_alt" });
    expect(res.isError).toBeFalsy();
    // No need to pre-fetch the execution when the id is explicit.
    const getsBeforeApprove = fetchCalls.slice(0, fetchCalls.indexOf(approve!)).filter((c) => c.method === "GET");
    expect(getsBeforeApprove).toHaveLength(0);
  });

  it("resolves selected_option index to the displayed option's id", async () => {
    installFetch();
    const tools = captureTools();

    const res = await tools.firestarter_approve({ execution_id: "exec_1", selected_option: 1 });

    const approve = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/approve"));
    // Index 1 = the option displayed as "2." = opt_alt — NOT the legacy
    // `selected_option` field the API used to ignore.
    expect(approve?.body).toEqual({ option_id: "opt_alt" });
    expect(res.isError).toBeFalsy();
  });

  it("errors on an out-of-range index without calling approve", async () => {
    installFetch();
    const tools = captureTools();

    const res = await tools.firestarter_approve({ execution_id: "exec_1", selected_option: 5 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/out of range/);
    expect(res.content[0].text).toMatch(/3 option/);
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("approves the pre-selected option when neither param is given", async () => {
    installFetch();
    const tools = captureTools();

    const res = await tools.firestarter_approve({ execution_id: "exec_1" });

    const approve = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/approve"));
    expect(approve?.body).toEqual({});
    expect(res.isError).toBeFalsy();
  });

  it("surfaces the API's rejection message (e.g. #107 browse-only 422)", async () => {
    installFetch({
      onApprove: () =>
        jsonResponse(422, {
          error:
            'Option opt_ext ("Ext Widget") cannot be purchased through Firestarter — it is an external google_shopping result (browse-only).',
          code: "EXTERNAL_PRODUCT_NOT_PURCHASABLE",
        }),
    });
    const tools = captureTools();

    const res = await tools.firestarter_approve({ execution_id: "exec_1", option_id: "opt_ext" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/browse-only/);
  });
});
