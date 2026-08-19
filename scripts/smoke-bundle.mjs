#!/usr/bin/env node
/**
 * Smoke-test the PACKED extension, not the source tree.
 *
 * `npm test` exercises the source; this unzips mcpb/dist/firestarter.mcpb and
 * drives the bundled server over real stdio JSON-RPC. It catches the class of
 * failure the unit tests structurally cannot: a bundler config that drops a
 * dependency, a manifest pointing at the wrong entry point, or an artifact
 * that builds fine and then can't complete a handshake once installed.
 *
 * Asserts the directory-review invariants too — every tool needs a title and
 * the applicable read-only/destructive hint — so a regression fails CI rather
 * than a submission.
 *
 * It also pins the MCP Apps wiring, which is invisible to every other test we
 * have. The inline product grid renders only if THREE things line up on the
 * wire: the ui:// resource is listed, it is readable with the MCP Apps mime
 * type, and the shopping tools point `_meta.ui.resourceUri` at that exact URI.
 * A tool aimed at a URI the server does not serve renders nothing at all, and
 * fails silently — the tool call still succeeds and returns its text, so the
 * only symptom is a missing grid nobody notices until a user reports it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "mcpb", "dist", "firestarter.mcpb");

// Imported from the build, never copied: the 2.5.1 promotion failed because
// shopping-app.ts renamed the URI (…/shopping-results/v2) while a hand-kept
// copy here still checked the old one — this smoke test reported a working
// product grid as broken and blocked the release.
const { SHOPPING_RESULTS_URI } = await import(
  pathToFileURL(join(root, "dist", "mcp", "shopping-app.js")).href
);
/** ext-apps RESOURCE_MIME_TYPE. Hosts ignore a ui:// resource served as
 *  anything else, so the exact string is load-bearing. */
const APP_MIME_TYPE = "text/html;profile=mcp-app";
/** Tools whose results the grid is supposed to render. Losing the wiring on
 *  one of these is the regression this file exists to catch. */
const GRID_TOOLS = [
  "firestarter_preview",
  "firestarter_catalog_search",
  "firestarter_listings",
  "firestarter_market_preview",
  "firestarter_join_market",
  "firestarter_my_market",
  "firestarter_set_market_picks",
];

if (!existsSync(bundle)) {
  console.error(`No bundle at ${bundle} — run \`npm run build:mcpb\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "mcpb-smoke-"));
try {
  execFileSync("unzip", ["-q", bundle, "-d", work]);

  const request = (id, method, params) =>
    JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });

  const input = [
    request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ci-smoke", version: "1.0" },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    request(2, "tools/list"),
    request(3, "prompts/list"),
    request(4, "resources/list"),
    request(5, "resources/read", { uri: SHOPPING_RESULTS_URI }),
  ].join("\n") + "\n";

  const stdout = execFileSync("node", [join(work, "server", "index.mjs")], {
    input,
    encoding: "utf8",
    // A placeholder key: the server requires one at boot, and tools/list never
    // calls the API, so nothing leaves the runner.
    env: { ...process.env, FIRESTARTER_API_KEY: "fs_test_ci_smoke" },
    timeout: 60_000,
  });

  const byId = new Map();
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) byId.set(msg.id, msg);
  }

  const fail = (why) => {
    console.error(`✗ ${why}`);
    process.exitCode = 1;
  };

  const init = byId.get(1)?.result;
  if (!init) fail("no initialize response");
  else console.log(`✓ handshake: ${init.serverInfo.name} ${init.serverInfo.version}`);

  const tools = byId.get(2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    fail("tools/list returned nothing");
  } else {
    console.log(`✓ ${tools.length} tools`);

    const untitled = tools.filter((t) => !t.annotations?.title).map((t) => t.name);
    if (untitled.length) fail(`tools missing an annotations title: ${untitled.join(", ")}`);
    else console.log("✓ every tool has a title");

    const unhinted = tools
      .filter((t) => t.annotations?.readOnlyHint === undefined && t.annotations?.destructiveHint === undefined)
      .map((t) => t.name);
    if (unhinted.length) fail(`tools missing a read-only/destructive hint: ${unhinted.join(", ")}`);
    else console.log("✓ every tool declares a safety hint");

    const contradictory = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    if (contradictory.length) fail(`tools claiming both read-only and destructive: ${contradictory.join(", ")}`);
  }

  const prompts = byId.get(3)?.result?.prompts;
  if (!Array.isArray(prompts) || prompts.length === 0) fail("prompts/list returned nothing");
  else console.log(`✓ ${prompts.length} prompts`);

  // ── MCP Apps wiring ────────────────────────────────────────────────────────
  const resources = byId.get(4)?.result?.resources;
  if (!Array.isArray(resources)) {
    fail("resources/list returned nothing");
  } else {
    const app = resources.find((r) => r.uri === SHOPPING_RESULTS_URI);
    if (!app) {
      fail(`the shopping-results app resource is not served: ${SHOPPING_RESULTS_URI}`);
    } else if (app.mimeType !== APP_MIME_TYPE) {
      fail(`app resource has mime type "${app.mimeType}", expected "${APP_MIME_TYPE}" — hosts ignore anything else`);
    } else {
      console.log(`✓ app resource served as ${APP_MIME_TYPE}`);
    }

    // Every tool that points at a UI resource must point at one that exists.
    // A dangling resourceUri renders nothing while the tool call still
    // succeeds, so nothing else in CI would notice.
    const served = new Set(resources.map((r) => r.uri));
    const dangling = (Array.isArray(tools) ? tools : [])
      .map((t) => [t.name, t._meta?.ui?.resourceUri])
      .filter(([, uri]) => uri && !served.has(uri))
      .map(([name, uri]) => `${name} -> ${uri}`);
    if (dangling.length) fail(`tools pointing at unserved UI resources: ${dangling.join(", ")}`);
  }

  const missingWiring = GRID_TOOLS.filter(
    (name) => (Array.isArray(tools) ? tools : []).find((t) => t.name === name)?._meta?.ui?.resourceUri !== SHOPPING_RESULTS_URI,
  );
  if (missingWiring.length) {
    fail(`tools that should render the product grid no longer declare it: ${missingWiring.join(", ")}`);
  } else {
    console.log(`✓ ${GRID_TOOLS.length} tools wired to the product grid`);
  }

  const appHtml = byId.get(5)?.result?.contents?.[0];
  if (!appHtml) {
    fail("resources/read on the app resource returned no contents");
  } else if (typeof appHtml.text !== "string" || !appHtml.text.includes("<")) {
    fail("app resource body is not HTML");
  } else {
    // An App iframe has NO network access beyond this allowlist, so an empty
    // one means every product photo silently degrades to "No photo".
    const domains = appHtml._meta?.ui?.csp?.resourceDomains;
    if (!Array.isArray(domains) || domains.length === 0) {
      fail("app resource declares no csp.resourceDomains — every product photo would be blocked");
    } else {
      console.log(`✓ app resource readable (${Math.round(appHtml.text.length / 1024)}KB, ${domains.length} image origins allowlisted)`);
    }
  }

  if (process.exitCode) console.error("\nBundle smoke test FAILED");
  else console.log("\nBundle smoke test passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
