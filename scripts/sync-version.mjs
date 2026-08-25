#!/usr/bin/env node
/**
 * Propagate package.json's version to every other file that states it.
 *
 * Deliberately does NOT touch the "N tools" claim in the manifest
 * descriptions. That count is already guarded by mcp-manifest-parity.test.ts,
 * which gets it by stubbing McpServer and actually running registerTools — the
 * only way to count what is really registered. An earlier draft of this script
 * re-derived it with a regex over tools.ts and came up one short
 * (firestarter_preview is registered in a form the pattern missed), which would
 * have written a wrong count into both manifests. One counter, in the test.
 *
 * The version lives in six places: package.json (what npm publishes),
 * mcpb/manifest.json (what an installed extension reports), src/mcp/server.ts
 * and src/mcp/route.ts (what stdio and remote clients respectively see in the
 * initialize handshake), and both mcp.json manifests. `npm version` only bumps
 * the first, so every release used to leave the other five behind —
 * src/mcp/mcp.json had already drifted to 2.1.0 while everything else sat at
 * 2.0.0. Keep package.json's `version` script staging all five in step with
 * the list below: route.ts was added here and left out of that git add, so
 * 2.12.1 shipped a remote handshake still advertising 2.12.0.
 *
 * Wired to the `version` npm lifecycle, so `npm version 2.1.0` rewrites all of
 * them and stages the result into the version commit. release.yml re-checks the
 * same invariant, so a drifted tag fails the release rather than shipping a
 * bundle whose version lies.
 *
 * Run standalone to repair drift: `node scripts/sync-version.mjs`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const version = JSON.parse(read("package.json")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version is not x.y.z: ${version}`);
  process.exit(1);
}

const changed = [];

/** Rewrite a JSON manifest's version, leaving every other field untouched. */
function syncJson(path) {
  const before = read(path);
  const json = JSON.parse(before);
  json.version = version;
  const after = `${JSON.stringify(json, null, 2)}\n`;
  if (after !== before) {
    writeFileSync(join(root, path), after);
    changed.push(path);
  }
}

for (const path of ["mcpb/manifest.json", "mcp.json", "src/mcp/mcp.json"]) syncJson(path);

// Both entrypoints hold the version as a literal in their McpServer
// constructor, and BOTH are seen by clients: server.ts is the stdio/extension
// handshake, route.ts is the remote HTTP + WebSocket one. Only server.ts used
// to be synced, so api.firestarter.network/mcp advertised 1.1.0 for as long as
// the extension advertised 2.x. Exactly one literal should exist per file; bail
// rather than guess if that stops being true.
for (const path of ["src/mcp/server.ts", "src/mcp/route.ts"]) {
  const before = read(path);
  const matches = before.match(/version: "\d+\.\d+\.\d+"/g) ?? [];
  if (matches.length !== 1) {
    console.error(`expected exactly one version literal in ${path}, found ${matches.length}`);
    process.exit(1);
  }
  const after = before.replace(/version: "\d+\.\d+\.\d+"/, `version: "${version}"`);
  if (after !== before) {
    writeFileSync(join(root, path), after);
    changed.push(path);
  }
}

console.log(
  changed.length ? `synced to ${version}: ${changed.join(", ")}` : `already in sync at ${version}`,
);
