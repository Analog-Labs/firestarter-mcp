import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/mcp/tools.js";
import { previewOutputSchema } from "../../src/mcp/schemas.js";

/**
 * End-to-end confirmation on a REAL McpServer (not the lightweight test double):
 * firestarter_preview must advertise an outputSchema and return structuredContent
 * that the SDK's own output validator accepts. If the payload were invalid the
 * SDK would reject the call and client.callTool() would throw — so these tests
 * lock in the production registerTool + structuredContent path.
 */
const PREVIEW_JSON = {
  query: "polo t-shirt",
  count: 1,
  options: [
    {
      id: "lst_1",
      title: "Classic Polo",
      price: 18,
      currency: "USD",
      image_url: "https://img.example/1.jpg",
      seller: "Acme",
      source: "firestarter_seller",
      url: "https://firestarter.network/l/lst_1",
      in_stock: true,
      purchasable: true,
      shipping: { known: true, amount_usd: 0, note: "free" },
      eligible: true,
      reasons: [],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

async function connectedClient() {
  const server = new McpServer({ name: "firestarter", version: "test" });
  registerTools(server, "fs_test_key", "http://api.test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("firestarter_preview — real MCP server structured output", () => {
  it("advertises an object outputSchema in tools/list", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const preview = tools.find((t) => t.name === "firestarter_preview");
    expect(preview).toBeTruthy();
    expect(preview!.outputSchema).toBeTruthy();
    expect((preview!.outputSchema as any).type).toBe("object");
    expect((preview!.annotations as any)?.readOnlyHint).toBe(true);
  });

  it("returns SDK-validated structuredContent (and keeps the text block)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(PREVIEW_JSON), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const client = await connectedClient();
    // Would throw here if the SDK's output validation rejected our payload.
    const res: any = await client.callTool({
      name: "firestarter_preview",
      arguments: { query: "polo t-shirt", country: "US" },
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeTruthy();
    const parsed = previewOutputSchema.parse(res.structuredContent);
    expect(parsed.count).toBe(1);
    expect(parsed.buyable_count).toBe(1);
    expect(parsed.options[0].id).toBe("lst_1");
    expect(parsed.options[0].total_usd).toBe(18);
    // Back-compat: the human-readable text block is still present.
    expect(res.content.some((b: any) => b.type === "text")).toBe(true);
  });
});
