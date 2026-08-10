#!/usr/bin/env tsx
/**
 * Rewrite both mcp.json manifests' tool descriptions from the descriptions the
 * server actually registers.
 *
 * The manifests are hand-maintained copies of what tools.ts declares, and they
 * rot: at the time this was written mcp.json had 30 stale descriptions and
 * src/mcp/mcp.json had 28, out of 83 tools. Nothing caught it, because the
 * parity test only checked that advertised tools exist and that their required
 * params match — never that the prose agrees.
 *
 * That prose is load-bearing. src/mcp/mcp.json is what an MCP directory reads,
 * and firestarter-commerce's /discovery route serves mcp.json verbatim as the
 * advertised tool list. A stale description tells an agent the wrong thing
 * about a tool it is about to call.
 *
 * Run: npm run sync-manifests
 * Guarded by the description-parity assertions in mcp-manifest-parity.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTools } from "../src/mcp/tools.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** name -> description, as registerTools declares them at runtime. */
const runtime = new Map<string, string>();
registerTools(
  { tool: (name: string, description: string) => { runtime.set(name, description); } } as any,
  "fs_test_sync",
  "http://local",
);

if (runtime.size < 50) {
  console.error(`only ${runtime.size} tools registered — refusing to rewrite manifests`);
  process.exit(1);
}

let total = 0;
for (const rel of ["mcp.json", "src/mcp/mcp.json"]) {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  const json = JSON.parse(before);
  const changed: string[] = [];

  for (const tool of json.tools ?? []) {
    const live = runtime.get(tool.name);
    if (live === undefined) {
      // An advertised tool the server does not register is a different bug —
      // the parity test already fails on it. Leave it for that to report.
      console.error(`${rel}: advertises unregistered tool ${tool.name}`);
      process.exit(1);
    }
    if (tool.description !== live) {
      tool.description = live;
      changed.push(tool.name);
    }
  }

  if (changed.length) {
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    total += changed.length;
  }
  console.log(`${rel}: ${changed.length} description(s) synced`);
}

console.log(total ? `synced ${total} description(s) from runtime` : "already in sync with runtime");
