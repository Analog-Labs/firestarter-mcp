/**
 * What the two MCP Apps hosts need from us before the widget can work.
 *
 * ChatGPT and Claude Desktop both implement the same MCP Apps standard
 * (`_meta.ui.resourceUri` + `text/html;profile=mcp-app` + the postMessage
 * bridge), which is why ONE view serves both. Three host-specific facts still
 * have to be declared, and each fails silently when it is not:
 *
 *   1. ChatGPT refuses a widget-initiated tools/call unless the target tool is
 *      marked `openai/widgetAccessible`. Without it the detail view opens and
 *      its description, seller and reviews never arrive — no error, just a
 *      skeleton that never fills.
 *   2. Claude Desktop caches the ui:// resource BY URI and never re-reads it.
 *      Ship new HTML under the old URI and every installed extension keeps
 *      rendering the old widget forever.
 *   3. ChatGPT wants the exact opposite: it serves the widget from its own
 *      template store keyed by that URI, and a URI it has not ingested comes
 *      back "Failed to fetch template" — which is what the v5 → v7 bump in
 *      2.15.0 did to every live connector. So it is pointed at a stable alias
 *      through its own key while Claude keeps the versioned one.
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

/**
 * The URI ChatGPT is pointed at, and it must NEVER change.
 *
 * ChatGPT resolves a widget through its own template store keyed by this URI.
 * A URI it has not already ingested answers "Failed to fetch template" instead
 * of rendering — which is exactly what shipping 2.15.0 did, when the versioned
 * URI moved v5 → v7 under a connector holding v5.
 *
 * Claude Desktop needs the opposite (it caches by URI and never re-reads, so
 * only a NEW URI can ever show it new HTML), which is why SHOPPING_RESULTS_URI
 * still carries its version segment and this one does not. Written out as a
 * literal on purpose: this string is the contract with ChatGPT, so any attempt
 * to version it has to break a test.
 */
const CHATGPT_TEMPLATE_URI = "ui://firestarter/shopping-results";

let toolMeta = new Map<string, Record<string, unknown>>();
let listedResources: { uri: string; mimeType?: string }[] = [];
const widgetHtml = new Map<string, string>();
const widgetMime = new Map<string, string>();

beforeAll(async () => {
  const server = new McpServer({ name: "widget-probe", version: "0.0.0" });
  registerTools(server, "fsk_test_widget_probe", "http://127.0.0.1:1");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  toolMeta = new Map(listed.tools.map((t) => [t.name, (t._meta ?? {}) as Record<string, unknown>]));
  listedResources = (await client.listResources()).resources.map((r) => ({ uri: r.uri, mimeType: r.mimeType }));
  for (const uri of [SHOPPING_RESULTS_URI, CHATGPT_TEMPLATE_URI]) {
    // A URI that isn't registered rejects; leave it unset and let the test say so.
    const read = await client.readResource({ uri }).catch(() => null);
    const content = read?.contents?.[0] as { text?: string; mimeType?: string } | undefined;
    if (!content) continue;
    widgetHtml.set(uri, content.text ?? "");
    widgetMime.set(uri, content.mimeType ?? "");
  }
  await client.close();
});

describe("widget-initiated tool calls", () => {
  it("marks firestarter_product callable from the widget", () => {
    // The detail view's whole top-up path. ChatGPT gates it on this key.
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
    // `ui.resourceUri` is the standard key both hosts understand, and it is
    // the one Claude Desktop reads. ChatGPT is sent to the stable alias
    // instead, via openai/outputTemplate — asserted just below.
    const ui = toolMeta.get("firestarter_product")?.ui as { resourceUri?: string } | undefined;
    expect(ui?.resourceUri).toBe(SHOPPING_RESULTS_URI);
  });
});

describe("the URI ChatGPT fetches never moves", () => {
  it("advertises the stable alias to ChatGPT on every widget tool", () => {
    // ui.resourceUri is the standard key and stays versioned for Claude
    // Desktop; openai/outputTemplate is ChatGPT's own alias, and pointing it at
    // a URI that never changes is what keeps a release from 404ing its cache.
    const widgetTools = [...toolMeta].filter(([, meta]) => (meta.ui as { resourceUri?: string } | undefined)?.resourceUri);
    expect(widgetTools.length).toBeGreaterThan(0);
    for (const [name, meta] of widgetTools) {
      expect(`${name}: ${String(meta["openai/outputTemplate"])}`).toBe(`${name}: ${CHATGPT_TEMPLATE_URI}`);
    }
  });

  it("serves the same widget from the stable alias as from the versioned URI", () => {
    // One HTML document, two URIs. If they can drift, ChatGPT and Claude
    // Desktop render different widgets from the same release.
    expect(widgetHtml.get(CHATGPT_TEMPLATE_URI)).toBe(widgetHtml.get(SHOPPING_RESULTS_URI));
    expect(widgetMime.get(CHATGPT_TEMPLATE_URI)).toBe(widgetMime.get(SHOPPING_RESULTS_URI));
    expect(widgetHtml.get(CHATGPT_TEMPLATE_URI)).toBe(SHOPPING_RESULTS_HTML);
  });

  it("lists both URIs so a host can discover either one", () => {
    const uris = listedResources.map((r) => r.uri);
    expect(uris).toContain(CHATGPT_TEMPLATE_URI);
    expect(uris).toContain(SHOPPING_RESULTS_URI);
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
