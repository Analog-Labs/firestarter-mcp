/**
 * What the two MCP Apps hosts need from us before the widget can work.
 *
 * ChatGPT and Claude Desktop both implement the same MCP Apps standard
 * (`_meta.ui.resourceUri` + `text/html;profile=mcp-app` + the postMessage
 * bridge), which is why ONE view serves both. Two host-specific facts still
 * have to be declared, and both fail silently when they are not:
 *
 *   1. ChatGPT refuses a widget-initiated tools/call unless the target tool is
 *      marked `openai/widgetAccessible`. Without it the detail modal opens and
 *      its description, seller and reviews never arrive — no error, just a
 *      skeleton that never fills.
 *   2. Claude Desktop caches the ui:// resource BY URI and never re-reads it.
 *      Ship new HTML under the old URI and every installed extension keeps
 *      rendering the old widget forever.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/mcp/tools.js";
import { SHOPPING_RESULTS_URI } from "../../src/mcp/shopping-app.js";
import { SHOPPING_RESULTS_HTML } from "../../src/mcp/ui/shopping-results.generated.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, "widget-resource.snapshot.json");

let toolMeta = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  const server = new McpServer({ name: "widget-probe", version: "0.0.0" });
  registerTools(server, "fsk_test_widget_probe", "http://127.0.0.1:1");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  toolMeta = new Map(listed.tools.map((t) => [t.name, (t._meta ?? {}) as Record<string, unknown>]));
  await client.close();
});

describe("widget-initiated tool calls", () => {
  it("marks firestarter_product callable from the widget", () => {
    // The detail modal's whole top-up path. ChatGPT gates it on this key.
    expect(toolMeta.get("firestarter_product")?.["openai/widgetAccessible"]).toBe(true);
  });

  it("does not hand the widget any tool that spends money", () => {
    // A sandboxed iframe rendering third-party product data must never be able
    // to reach a tool that charges a card or moves a payout, whatever a host
    // decides to let it call.
    for (const [name, meta] of toolMeta) {
      if (meta["openai/widgetAccessible"] !== true) continue;
      expect(name).toMatch(/^firestarter_(product|preview|catalog_search)$/);
    }
  });
});

describe("every widget tool still points at the shopping app", () => {
  it("advertises the resource under the standard MCP Apps key", () => {
    // `ui.resourceUri` is what BOTH hosts read now; openai/outputTemplate is
    // only ChatGPT's legacy alias, and the SDK's registerAppTool mirrors it.
    const ui = toolMeta.get("firestarter_product")?.ui as { resourceUri?: string } | undefined;
    expect(ui?.resourceUri).toBe(SHOPPING_RESULTS_URI);
  });
});

describe("resource cache busting", () => {
  it("carries a new URI whenever the widget HTML changes", () => {
    // Claude Desktop caches by URI and never re-reads. This snapshot is the
    // only thing that makes a stale-cache ship fail loudly instead of shipping.
    const current = {
      uri: SHOPPING_RESULTS_URI,
      html_sha256: createHash("sha256").update(SHOPPING_RESULTS_HTML).digest("hex"),
    };
    if (process.env.UPDATE_WIDGET_SNAPSHOT === "1") {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    expect(current).toEqual(
      expect.objectContaining({ uri: expected.uri, html_sha256: expected.html_sha256 }),
    );
  });
});
