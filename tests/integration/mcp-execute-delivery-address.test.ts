/**
 * firestarter_execute structured delivery_address forwarding.
 *
 * Regression: the tool used to accept delivery_address as a natural-language
 * STRING and wrap it as `{ address: "<string>" }` before POSTing to
 * /v1/executions. The backend's normalizeDeliveryAddress requires a structured
 * object with street1 + city, so every free-text address was rejected with
 * "delivery_address.street1 is required". The tool now takes the same
 * structured object as firestarter_approve and forwards it verbatim.
 *
 * Same harness as mcp-execute-attribution.test.ts: drive the REAL registered
 * tool handler (captured via a fake McpServer) against a mocked global fetch.
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
  id: "exec_addr1",
  status: "completed",
  request_text: "mineral water",
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
        return new Response(JSON.stringify({ id: "exec_addr1", status: "finding" }), {
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

describe("firestarter_execute — structured delivery_address", () => {
  it("forwards a structured delivery_address verbatim (no { address } wrapper)", async () => {
    const tools = captureTools();

    const address = {
      street1: "231-F Block, Johar Town",
      city: "Lahore",
      country: "PK",
    };

    await tools.firestarter_execute({
      request: "Mont Fleur Natural Mineral Water 1.5L",
      delivery_address: address,
    });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    // The object is passed through as-is — NOT wrapped in { address: ... }.
    expect(create?.body.delivery_address).toEqual(address);
    expect(create?.body.delivery_address.address).toBeUndefined();
    expect(create?.body.delivery_address.street1).toBe("231-F Block, Johar Town");
  });

  it("sends no delivery_address when the buyer relies on their saved default", async () => {
    const tools = captureTools();

    await tools.firestarter_execute({ request: "Mont Fleur Natural Mineral Water 1.5L" });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body.delivery_address).toBeUndefined();
  });
});
