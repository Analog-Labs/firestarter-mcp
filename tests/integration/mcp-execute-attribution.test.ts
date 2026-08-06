/**
 * firestarter_execute requester attribution (Ogbaa follow-up).
 *
 * Team-chat integrations relay purchases on behalf of a human ("Durga asked
 * for tennis balls"), but executions used to land with empty metadata — the
 * dashboard couldn't show who asked. The MCP tool now takes `requested_by`
 * {name, id, channel} and threads it into the REST body as
 * `metadata.requested_by`, which POST /v1/executions stores verbatim.
 *
 * Same harness as mcp-approve-option.test.ts: drive the REAL registered tool
 * handler (captured via a fake McpServer) against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

// Terminal status so pollExecution returns on its first GET.
const COMPLETED_EXEC = {
  id: "exec_attr1",
  status: "completed",
  request_text: "tennis balls",
  options: [],
  steps: [],
};

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ method, url: String(url), body });

      if (method === "POST" && String(url).endsWith("/v1/executions")) {
        return new Response(JSON.stringify({ id: "exec_attr1", status: "finding" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "GET" && String(url).includes("/v1/executions/")) {
        return new Response(JSON.stringify(COMPLETED_EXEC), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    })
  );
}

beforeEach(() => {
  fetchCalls = [];
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_execute — requested_by attribution", () => {
  it("threads requested_by into the create body as metadata.requested_by", async () => {
    const tools = captureTools();

    const res = await tools.firestarter_execute({
      request: "tennis balls",
      requested_by: { name: "Durga", id: "U0DURGA1", channel: "slack" },
    });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.metadata).toEqual({
      requested_by: { name: "Durga", id: "U0DURGA1", channel: "slack" },
    });
    expect(res.isError).toBeFalsy();
  });

  it("sends no metadata when requested_by is omitted (no empty-object noise)", async () => {
    const tools = captureTools();

    await tools.firestarter_execute({ request: "tennis balls" });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.metadata).toBeUndefined();
  });

  it("drops a requested_by that identifies no one (channel only)", async () => {
    const tools = captureTools();

    await tools.firestarter_execute({
      request: "tennis balls",
      requested_by: { channel: "slack" },
    });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.metadata).toBeUndefined();
  });

  it("attribution composes with the share-link pin (both ride one body)", async () => {
    const tools = captureTools();

    await tools.firestarter_execute({
      request: "Buy Tennis Ball Set",
      listing_id: "lst_qLcYasBq",
      requested_by: { name: "Durga", id: "U0DURGA1", channel: "slack" },
    });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.listing_id).toBe("lst_qLcYasBq");
    expect(create?.body.metadata.requested_by.name).toBe("Durga");
  });
});
