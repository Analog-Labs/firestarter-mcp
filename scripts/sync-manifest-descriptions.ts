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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/mcp/tools.js";

/**
 * #788: the JSON Schema the SERVER advertises, per tool.
 *
 * Taken from a real McpServer's `tools/list` response rather than converted
 * from the Zod shape here, so what lands in the manifests is byte-for-byte
 * what a client sees over the wire — including the 2020-12 dialect
 * enforceSchemaDialect re-stamps. A local reimplementation of the Zod ->
 * JSON Schema conversion would be a second source of truth, and drifting from
 * the wire is the whole bug this closes.
 */
async function advertisedSchemas(): Promise<Map<string, any>> {
  const server = new McpServer({ name: "firestarter", version: "sync" });
  registerTools(server as any, "fs_test_sync", "http://local");
  const inner = (server as any).server;
  const listTools = inner?._requestHandlers?.get("tools/list");
  if (!listTools) throw new Error("could not reach the SDK's tools/list handler");
  const result = await listTools({ method: "tools/list", params: {} }, {});
  const out = new Map<string, any>();
  for (const t of result?.tools ?? []) out.set(t.name, t.inputSchema);
  return out;
}

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

const schemas = await advertisedSchemas();

let total = 0;
let totalAdded = 0;
for (const rel of ["mcp.json", "src/mcp/mcp.json"]) {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  const json = JSON.parse(before);
  const changed: string[] = [];
  const added: string[] = [];

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
        if (props[param] && props[param].description !== desc) {
          props[param].description = desc;
          changed.push(`${tool.name}.${param}`);
        }
      }
    }

    // #788: a param the manifest OMITS used to be skipped here — "parity's
    // job" — so `npm run sync-manifests` reported success and changed nothing,
    // which read as "in sync". It was not: 39 parameters the server accepts
    // were absent from both manifests, and a manifest-driven agent cannot use
    // a parameter it cannot see. That is what caused #749.
    //
    // The property is copied from the SDK's own advertised schema, so the
    // manifest says exactly what the wire says.
    const advertised = schemas.get(tool.name)?.properties;
    if (advertised && props) {
      for (const [param, schema] of Object.entries(advertised)) {
        if (props[param]) continue;
        props[param] = JSON.parse(JSON.stringify(schema));
        added.push(`${tool.name}.${param}`);
      }
    }
  }

  if (changed.length || added.length) {
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    total += changed.length;
    totalAdded += added.length;
  }
  console.log(`${rel}: ${changed.length} description(s) synced, ${added.length} param(s) declared${added.length ? ` (${added.join(", ")})` : ""}`);
}

console.log(total || totalAdded
  ? `synced ${total} description(s) and declared ${totalAdded} missing param(s) from runtime`
  : "already in sync with runtime");
