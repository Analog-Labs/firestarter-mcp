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
/** name -> { param -> description }, from the Zod shape registerTools declares. */
const runtimeParams = new Map<string, Map<string, string>>();

/**
 * Pull the `.describe()` text off a Zod field.
 *
 * `.optional()` and `.default()` wrap the schema, so the description sits on
 * whichever object `.describe()` was called on last: outer for the usual
 * `z.string().optional().describe(...)`, inner for `z.string().describe(...)
 * .optional()`. Both spellings appear in tools.ts, so check both rather than
 * silently skipping the params written the other way round.
 */
function zodDescription(field: any): string | undefined {
  return field?.description
    ?? field?._def?.description
    ?? field?._def?.innerType?.description
    ?? field?._def?.innerType?._def?.description;
}

registerTools(
  {
    tool: (name: string, description: string, ...rest: any[]) => {
      runtime.set(name, description);
      // server.tool(name, description, shape, annotations, handler) — the shape
      // is the first object whose values look like Zod fields.
      const shape = rest.find(
        (a) => a && typeof a === "object" && !Array.isArray(a)
          && Object.values(a).some((v: any) => v?._def !== undefined),
      );
      if (!shape) return;
      const params = new Map<string, string>();
      for (const [param, field] of Object.entries(shape)) {
        const d = zodDescription(field);
        if (d) params.set(param, d);
      }
      if (params.size) runtimeParams.set(name, params);
    },
  } as any,
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

    // Parameter prose rots exactly like tool prose, and for the same reason: it
    // is hand-copied here. It went unnoticed longer because this script only
    // ever synced the tool description, so a corrected param could look synced
    // while still advertising the opposite. That is not hypothetical — the
    // payout `country` param kept telling agents Stripe "rejects every other
    // country" after the API's allowlist was deleted, steering SEA sellers onto
    // a rail that could not pay them.
    const liveParams = runtimeParams.get(tool.name);
    const props = tool.inputSchema?.properties;
    if (liveParams && props) {
      for (const [param, desc] of liveParams) {
        if (!props[param]) continue; // a param the manifest omits is parity's job
        if (props[param].description !== desc) {
          props[param].description = desc;
          changed.push(`${tool.name}.${param}`);
        }
      }
    }
  }

  if (changed.length) {
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    total += changed.length;
  }
  console.log(`${rel}: ${changed.length} description(s) synced`);
}

console.log(total ? `synced ${total} description(s) from runtime` : "already in sync with runtime");
