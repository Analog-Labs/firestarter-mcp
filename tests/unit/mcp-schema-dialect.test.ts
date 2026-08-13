/**
 * JSON Schema dialect contract for the advertised tool surface (#736).
 *
 * MCP's schema dialect is draft 2020-12. Every tool we advertise was declaring
 * draft-07 instead — not because of anything in this repo, but because the
 * SDK's zod-v3 compat shim (`server/zod-json-schema-compat.js`) defaults
 * `mapMiniTarget(undefined)` to `'draft-7'`, and `server/mcp.js` calls it with
 * no target for both inputSchema and outputSchema. We are on zod 4, whose own
 * `toJSONSchema()` targets 2020-12; the shim overrode it back down, and there
 * is no `registerTool` option to change that.
 *
 * A lenient host does not care, which is exactly why this went unnoticed: the
 * tools work fine in Claude Code. A host that validates the advertised schema
 * against the spec dialect rejects the tool outright.
 *
 * These assertions read the REAL schemas off a connected client's `tools/list`,
 * never from source, so they cover whatever the SDK actually emits — including
 * after an SDK bump silently changes the default back.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/mcp/tools.js";
import { buildMcpServer } from "../../src/mcp/route.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

type JsonSchema = Record<string, unknown>;
interface ListedTool {
  name: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

let tools: ListedTool[] = [];

beforeAll(async () => {
  const server = new McpServer({ name: "dialect-probe", version: "0.0.0" });
  registerTools(server, "fs_test_dialect_probe", "http://127.0.0.1:1");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  tools = listed.tools as unknown as ListedTool[];
  await client.close();
});

/** Every advertised schema, flattened to (tool, which, schema) rows. */
function advertisedSchemas(): { name: string; which: string; schema: JsonSchema }[] {
  const rows: { name: string; which: string; schema: JsonSchema }[] = [];
  for (const t of tools) {
    if (t.inputSchema) rows.push({ name: t.name, which: "inputSchema", schema: t.inputSchema });
    if (t.outputSchema) rows.push({ name: t.name, which: "outputSchema", schema: t.outputSchema });
  }
  return rows;
}

describe("advertised JSON Schema dialect", () => {
  it("exposes the tool surface to a connected client", () => {
    expect(tools.length).toBeGreaterThan(70);
  });

  it("never advertises draft-07 on any tool", () => {
    const offenders = advertisedSchemas()
      .filter(({ schema }) => typeof schema.$schema === "string" && /draft-0?7/.test(schema.$schema as string))
      .map(({ name, which }) => `${name}.${which}`);
    expect(
      offenders,
      `these schemas declare JSON Schema draft-07, which hosts validating against ` +
      `MCP's 2020-12 dialect reject: ${offenders.slice(0, 10).join(", ")}` +
      `${offenders.length > 10 ? ` (+${offenders.length - 10} more)` : ""}`,
    ).toEqual([]);
  });

  it("declares the 2020-12 dialect wherever a dialect is declared", () => {
    const wrong = advertisedSchemas()
      .filter(({ schema }) => schema.$schema !== undefined && schema.$schema !== DRAFT_2020_12)
      .map(({ name, which, schema }) => `${name}.${which}=${String(schema.$schema)}`);
    expect(wrong, "unexpected dialect marker").toEqual([]);
  });

  it("covers firestarter_preview, the tool the rejection was reported against", () => {
    const preview = tools.find((t) => t.name === "firestarter_preview");
    expect(preview, "firestarter_preview is not registered").toBeDefined();
    // It is one of only two tools carrying an outputSchema, so it has twice the
    // schema surface and is the first a strict host trips over.
    expect(preview!.outputSchema, "firestarter_preview should advertise an outputSchema").toBeDefined();
    expect(preview!.inputSchema!.$schema).toBe(DRAFT_2020_12);
    expect(preview!.outputSchema!.$schema).toBe(DRAFT_2020_12);
  });

  /**
   * The probe above drives `registerTools` directly. This one goes through
   * `buildMcpServer`, the factory the HTTP transport actually serves /mcp with
   * — so the wiring is pinned at the entrypoint a real client reaches, not
   * just at the function the fix happens to live in.
   */
  it("applies to a server built the way the HTTP transport builds it", async () => {
    const server = buildMcpServer("fs_test_dialect_probe", "http://127.0.0.1:1");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = (await client.listTools()).tools as unknown as ListedTool[];
    await client.close();

    const offenders = listed
      .flatMap((t) => [t.inputSchema, t.outputSchema])
      .filter((s): s is JsonSchema => !!s)
      .filter((s) => s.$schema !== DRAFT_2020_12);
    expect(offenders.length, "schemas not on the 2020-12 dialect over the HTTP server factory").toBe(0);
  });

  it("keeps the schemas usable after the dialect rewrite", () => {
    const preview = tools.find((t) => t.name === "firestarter_preview")!;
    // The rewrite must not flatten the schema into something contentless — the
    // properties and required list a host validates against still have to be there.
    expect(preview.inputSchema!.type).toBe("object");
    expect(Object.keys(preview.inputSchema!.properties as object)).toContain("query");
    expect(preview.inputSchema!.required).toEqual(["query"]);
    expect(Object.keys(preview.outputSchema!.properties as object)).toContain("options");
  });
});
