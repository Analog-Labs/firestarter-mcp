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

    it("rejects an out-of-range limit at the tool boundary (contract enforcement)", async () => {
        vi.stubGlobal("fetch", vi.fn());
        const client = await connectedClient();
        // limit=0 is below the advertised floor of 1 → the SDK's input validation
        // rejects the call (throws) or surfaces an error result. Either way the
        // out-of-range value never reaches the handler as a silent clamp.
        let rejected = false;
        let result: any = null;
        try {
            result = await client.callTool({
                name: "firestarter_preview",
                arguments: { query: "polo t-shirt", limit: 0 },
            });
        } catch {
            rejected = true;
        }
        expect(rejected || result?.isError === true).toBe(true);
    });

    it("rejects an out-of-range quantity at the tool boundary", async () => {
        vi.stubGlobal("fetch", vi.fn());
        const client = await connectedClient();
        let rejected = false;
        let result: any = null;
        try {
            result = await client.callTool({
                name: "firestarter_preview",
                arguments: { query: "polo t-shirt", quantity: -5 },
            });
        } catch {
            rejected = true;
        }
        expect(rejected || result?.isError === true).toBe(true);
    });
});
