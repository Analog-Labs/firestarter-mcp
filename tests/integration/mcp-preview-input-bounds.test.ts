import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/mcp/tools.js";

/**
 * firestarter_preview input-contract bounds (Copilot review follow-up, PR #112).
 *
 * The preview service clamps quantity to 1..100 and page size (limit) to 1..50
 * (src/services/preview.ts clampQty/clampLimit). Copilot flagged that the MCP
 * tool's Zod input schema advertised these as unbounded integers, so an agent
 * relying on the tool contract could send 0/negative/huge values that silently
 * clamp instead of being told the supported range. The Zod schema now enforces
 * `.min().max()` matching the service. This test locks the advertised JSON
 * Schema bounds so the tool contract and the service clamp cannot drift.
 */
afterEach(() => vi.unstubAllGlobals());

async function connectedClient() {
  const server = new McpServer({ name: "firestarter", version: "test" });
  registerTools(server, "fs_test_key", "http://api.test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Assert an out-of-range argument is rejected by the tool's input schema BEFORE
 * the handler runs. Proof-of-schema-enforcement: the handler is the only thing
 * that calls fetch(), so if the value were silently clamped instead of rejected,
 * fetch would have been invoked. We assert both a rejection AND fetch-not-called
 * so a runtime failure inside the handler can't produce a false positive.
 */
async function expectRejectedBeforeHandler(args: Record<string, unknown>) {
  const fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ query: "x", count: 0, options: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  const client = await connectedClient();

  let rejected = false;
  try {
    const result: any = await client.callTool({ name: "firestarter_preview", arguments: args });
    rejected = result?.isError === true;
  } catch {
    rejected = true; // SDK threw McpError (-32602 Invalid params)
  }

  expect(rejected).toBe(true);
  // The handler never ran → the rejection came from the schema, not a clamp.
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe("firestarter_preview — input schema bounds", () => {
  it("advertises quantity bounded to 1..100 and limit bounded to 1..50", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const preview = tools.find((t) => t.name === "firestarter_preview");
    expect(preview).toBeTruthy();

    const props = (preview!.inputSchema as any).properties;
    expect(props.quantity.minimum).toBe(1);
    expect(props.quantity.maximum).toBe(100);
    expect(props.limit.minimum).toBe(1);
    expect(props.limit.maximum).toBe(50);
  });

  it("rejects limit below the floor (0) at the schema, not via silent clamp", async () => {
    await expectRejectedBeforeHandler({ query: "polo t-shirt", limit: 0 });
  });

  it("rejects limit above the ceiling (51) at the schema", async () => {
    await expectRejectedBeforeHandler({ query: "polo t-shirt", limit: 51 });
  });

  it("rejects a negative quantity at the schema, not via silent clamp", async () => {
    await expectRejectedBeforeHandler({ query: "polo t-shirt", quantity: -5 });
  });

  it("rejects quantity above the ceiling (101) at the schema", async () => {
    await expectRejectedBeforeHandler({ query: "polo t-shirt", quantity: 101 });
  });
});
