/**
 * MCP manifest <-> runtime parity. The served .well-known/mcp.json (src/mcp/mcp.json)
 * is maintained separately from the tools registered at runtime in tools.ts.
 * Drift caused the S6-05 "ghost tools" defect (manifest advertised tools that
 * didn't exist -> agents got tool-not-found). This guards both directions:
 *   - no ghost tools: every manifest tool is actually registered;
 *   - no hidden tools: every registered tool is advertised.
 * Attribution self-serve tools are env-gated in BOTH (registered only when
 * ATTRIBUTION_SELF_SERVE_ENABLED=true, and absent from the manifest), so we keep
 * the flag off here and they fall out of both sets symmetrically.
 *
 * #570 extends this to the rest of the A7 surface: exact tool COUNT parity (not
 * just the name set), the human-facing "N tools / N prompts / N resources"
 * counts advertised in the manifest description, and that prompts + resources
 * register as a stable, duplicate-free, non-empty set.
 */
import { describe, it, expect } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";
import { registerPrompts } from "../../src/mcp/prompts.js";
import { registerResources } from "../../src/mcp/resources.js";
import manifest from "../../src/mcp/mcp.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The installable stdio manifest at apps/api/mcp.json declares the same tool set
// as the runtime and the served .well-known manifest. It sits outside src/, so
// it's read at runtime rather than imported as typed JSON. It once drifted to 32
// tools because nothing guarded it — the checks below keep all three in lockstep.
const rootManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../mcp.json", import.meta.url)), "utf8"),
);
const rootManifestToolNames: string[] = (rootManifest.tools || []).map((t: any) => t.name).sort();

function registeredToolNames(): string[] {
  const names: string[] = [];
  // Minimal McpServer stub: registerTools only calls server.tool(name, ...).
  const stub = { tool: (name: string) => { names.push(name); } } as any;
  delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  registerTools(stub, "fs_test_parity", "http://local");
  return names.sort();
}

/**
 * Phase 4 (C9): capture each tool's REQUIRED param set from the live Zod schema
 * so the manifest's inputSchema.required can be diffed against it — the exact
 * drift (advertised-required vs actually-required) that made stale connectors
 * reject valid delivery_address args.
 */
function registeredToolRequired(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const reqOf = (shape: any): string[] | null => {
    if (!shape || typeof shape !== "object" || Array.isArray(shape)) return null;
    const keys = Object.keys(shape);
    if (keys.length && !keys.every((k) => shape[k] && typeof shape[k] === "object")) return null;
    return keys.filter((k) => {
      const zt = shape[k];
      return typeof zt.isOptional === "function" ? !zt.isOptional() : true;
    }).sort();
  };
  const capture = (name: string, a2?: any, a3?: any) => {
    // server.tool(name, description, shape, handler): shape = a3
    // registerTool(name, config, handler): shape = config.inputSchema
    const shape = a3 && typeof a3 === "object" && !Array.isArray(a3) ? a3
      : a2 && typeof a2 === "object" && a2.inputSchema ? a2.inputSchema : undefined;
    const req = reqOf(shape);
    if (req !== null) out[name] = req;
  };
  const stub = {
    tool: (name: string, a2?: any, a3?: any) => capture(name, a2, a3),
    registerTool: (name: string, config?: any) => capture(name, config, undefined),
  } as any;
  delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  registerTools(stub, "fs_test_parity", "http://local");
  return out;
}

function registeredPromptNames(): string[] {
  const names: string[] = [];
  // registerPrompts only calls server.prompt(name, ...).
  const stub = { prompt: (name: string) => { names.push(name); } } as any;
  registerPrompts(stub);
  return names.sort();
}

function registeredResourceNames(): string[] {
  const names: string[] = [];
  // registerResources only calls server.resource(name, ...).
  const stub = { resource: (name: string) => { names.push(name); } } as any;
  registerResources(stub, async () => ({}));
  return names.sort();
}

const manifestToolNames: string[] = ((manifest as any).tools || []).map((t: any) => t.name).sort();

/** Parse "36 tools, 7 resources, 10 prompts" out of the manifest description. */
function advertisedCount(kind: "tools" | "prompts" | "resources"): number | null {
  const desc = (manifest as any).description || "";
  const re = kind === "tools" ? /(\d+)\s+tools/ : kind === "prompts" ? /(\d+)\s+prompts/ : /(\d+)\s+resources/;
  const m = re.exec(desc);
  return m ? parseInt(m[1], 10) : null;
}

describe("MCP manifest <-> runtime tool parity", () => {
  it("advertises no ghost tools (every mcp.json tool is registered)", () => {
    const registered = new Set(registeredToolNames());
    const ghosts = manifestToolNames.filter((t) => !registered.has(t));
    expect(ghosts, `mcp.json advertises tools that are NOT registered: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("hides no tools (every registered tool is in mcp.json)", () => {
    const advertised = new Set(manifestToolNames);
    const hidden = registeredToolNames().filter((t) => !advertised.has(t));
    expect(hidden, `tools registered but missing from mcp.json: ${hidden.join(", ")}`).toEqual([]);
  });

  it("registers a non-trivial tool set", () => {
    expect(registeredToolNames().length).toBeGreaterThanOrEqual(15);
  });

  // #570: the tool COUNT (not just the name set) must match the manifest array,
  // and the human-facing "N tools" claim in the description must not drift from
  // reality — that string is what onboarding + partner docs quote.
  it("tool count matches the manifest array and its advertised count", () => {
    const runtime = registeredToolNames().length;
    expect(runtime).toBe(manifestToolNames.length);
    const advertised = advertisedCount("tools");
    if (advertised !== null) {
      expect(advertised, "manifest description 'N tools' is stale vs registered tools").toBe(runtime);
    }
  });
});

describe("MCP prompt + resource registration parity (#570)", () => {
  it("registers a stable, non-empty set of prompts matching the advertised count", () => {
    const prompts = registeredPromptNames();
    expect(prompts.length).toBeGreaterThan(0);
    // No duplicate prompt names (a dupe silently shadows a workflow starter).
    expect(new Set(prompts).size).toBe(prompts.length);
    const advertised = advertisedCount("prompts");
    if (advertised !== null) {
      expect(advertised, "manifest description 'N prompts' is stale vs registered prompts").toBe(prompts.length);
    }
  });

  it("registers a stable, non-empty set of resources matching the advertised count", () => {
    const resources = registeredResourceNames();
    expect(resources.length).toBeGreaterThan(0);
    expect(new Set(resources).size).toBe(resources.length);
    const advertised = advertisedCount("resources");
    if (advertised !== null) {
      expect(advertised, "manifest description 'N resources' is stale vs registered resources").toBe(resources.length);
    }
  });
});

describe("MCP manifest param drift (#Phase4/C9)", () => {
  it("mcp.json inputSchema.required matches the live Zod required params for each tool", () => {
    const runtimeReq = registeredToolRequired();
    const drifts: string[] = [];
    for (const t of ((manifest as any).tools || [])) {
      const rt = runtimeReq[t.name];
      const manifestReq: string[] | undefined = t.inputSchema?.required;
      if (!rt || manifestReq === undefined) continue; // compare only where both sides declare it
      const a = [...rt].sort().join(",");
      const b = [...manifestReq].sort().join(",");
      if (a !== b) drifts.push(`${t.name}: manifest [${b}] != runtime [${a}]`);
    }
    expect(drifts, `mcp.json required params drifted from the live Zod schema:\n${drifts.join("\n")}`).toEqual([]);
  });

  it("firestarter_bulk_list nested items.required matches the zod schema's per-item optional/required fields (src/mcp/mcp.json)", () => {
    checkBulkListNestedRequiredDrift(manifest, "src/mcp/mcp.json");
  });
});

/**
 * Helper to validate firestarter_bulk_list nested items.required against live zod schema.
 * Used by both the served manifest (src/mcp/mcp.json) and the stdio manifest (apps/api/mcp.json).
 */
function checkBulkListNestedRequiredDrift(manifestToCheck: any, manifestName: string) {
  // Capture the actual zod schema from the tool registration
  let bulkListSchema: any = undefined;
  const stub = {
    tool: (name: string, _d: string, _s: any) => {
      if (name === "firestarter_bulk_list") bulkListSchema = _s;
    },
  } as any;
  delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  registerTools(stub, "fs_test_parity", "http://local");

  if (!bulkListSchema) {
    throw new Error("firestarter_bulk_list schema not captured");
  }

  // Extract the per-item required fields from the zod schema
  // For z.array(z.object(...)), the structure is: products._def.element._def.shape
  const productsZod = bulkListSchema.products;
  if (!productsZod || !productsZod._def || !productsZod._def.element) {
    throw new Error("products zod schema structure unexpected");
  }
  const itemShape = productsZod._def.element._def.shape;
  const runtimeItemRequired = Object.keys(itemShape)
    .filter((k) => {
      const zt = itemShape[k];
      return typeof zt.isOptional === "function" ? !zt.isOptional() : true;
    })
    .sort();

  // Extract the per-item required fields from the manifest
  const manifestTool = manifestToCheck.tools?.find((t: any) => t.name === "firestarter_bulk_list");
  const manifestItemRequired = manifestTool?.inputSchema?.properties?.products?.items?.required || [];

  const runtimeStr = runtimeItemRequired.join(",");
  const manifestStr = [...manifestItemRequired].sort().join(",");
  expect(
    runtimeStr,
    `${manifestName}: firestarter_bulk_list nested items.required (manifest: [${manifestStr}]) drifted from zod schema: [${runtimeStr}]`
  ).toBe(manifestStr);
}

// The installable stdio manifest (apps/api/mcp.json) is a SECOND tool-listing
// surface — the client-config form ("transport":"stdio") distinct from the
// served .well-known manifest. Nothing imported it and no test guarded it, so it
// silently froze at 32 tools while the runtime grew to 70. These checks bind it
// to the runtime (the source of truth) exactly like the served manifest above,
// so a new tool must be added to BOTH manifests or CI fails.
describe("stdio mcp.json (apps/api/mcp.json) <-> runtime parity", () => {
  it("advertises no ghost tools (every root mcp.json tool is registered)", () => {
    const registered = new Set(registeredToolNames());
    const ghosts = rootManifestToolNames.filter((t) => !registered.has(t));
    expect(ghosts, `apps/api/mcp.json advertises tools that are NOT registered: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("hides no tools (every registered tool is in root mcp.json)", () => {
    const advertised = new Set(rootManifestToolNames);
    const hidden = registeredToolNames().filter((t) => !advertised.has(t));
    expect(hidden, `tools registered but missing from apps/api/mcp.json: ${hidden.join(", ")}`).toEqual([]);
  });

  it("declares the same tool set as the served .well-known manifest", () => {
    expect(rootManifestToolNames).toEqual(manifestToolNames);
  });

  it("tool count matches runtime and its advertised 'N tools' count", () => {
    const runtime = registeredToolNames().length;
    expect(rootManifestToolNames.length).toBe(runtime);
    const m = /(\d+)\s+tools/.exec(rootManifest.description || "");
    if (m) {
      expect(parseInt(m[1], 10), "apps/api/mcp.json description 'N tools' is stale vs registered tools").toBe(runtime);
    }
  });

  it("firestarter_bulk_list nested items.required matches the zod schema's per-item optional/required fields (apps/api/mcp.json)", () => {
    checkBulkListNestedRequiredDrift(rootManifest, "apps/api/mcp.json");
  });
});

/**
 * Both manifests copy each tool's description out of tools.ts by hand, and the
 * copies rot: when this block was added, src/mcp/mcp.json had 28 stale
 * descriptions and mcp.json had 30, out of 83 tools. Every check above passed
 * throughout, because they only compare tool NAMES and required params — never
 * the prose.
 *
 * The prose is what an agent reads to decide whether to call a tool, and it is
 * served verbatim: src/mcp/mcp.json is the directory-facing manifest, and
 * firestarter-commerce's /discovery route advertises mcp.json's tool list. A
 * stale description is a wrong instruction, not a cosmetic diff.
 *
 * `npm run sync-manifests` rewrites both from runtime.
 */
function registeredToolDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  const stub = { tool: (name: string, description: string) => { out.set(name, description); } } as any;
  delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  registerTools(stub, "fs_test_parity", "http://local");
  return out;
}

describe("manifest tool descriptions match the registered ones", () => {
  const cases: Array<[string, any]> = [
    ["src/mcp/mcp.json", manifest],
    ["mcp.json", rootManifest],
  ];

  it.each(cases)("%s advertises the descriptions the server registers", (label, m) => {
    const live = registeredToolDescriptions();
    expect(live.size).toBeGreaterThan(50); // sanity: the stub captured tools
    const stale = (m.tools || [])
      .filter((t: any) => live.has(t.name) && live.get(t.name) !== t.description)
      .map((t: any) => t.name);
    expect(
      stale,
      `${label} has stale tool descriptions — run \`npm run sync-manifests\`: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * commerce#749 follow-up: the description check above compares only tool-level
 * prose, and sync-manifest-descriptions.ts skips any parameter the manifest
 * does not already declare (`if (!props[param]) continue`). So a NEW parameter
 * could be added to the server, described in the tool prose, synced, and still
 * be absent from both manifests — which is exactly what happened to
 * firestarter_disputes' `image_urls`.
 *
 * That matters because the manifests are what agents actually read:
 * src/mcp/mcp.json is served at /.well-known/mcp.json and commerce's /discovery
 * serves mcp.json verbatim. A parameter missing there is a parameter that does
 * not exist as far as a directory-driven client is concerned — so the fix for
 * a bug can ship green while the bug is still live for the client that hit it.
 */
function registeredToolParams(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const stub = {
    tool: (name: string, _description: string, schema: any) => {
      out.set(name, new Set(Object.keys(schema && typeof schema === "object" ? schema : {})));
    },
  } as any;
  delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  registerTools(stub, "fs_test_parity", "http://local");
  return out;
}


/**
 * Parameters the server accepts that neither manifest declares TODAY. This is a
 * frozen baseline, not an approval: every entry is a parameter an agent reading
 * the published manifest cannot use, which is the same defect class as
 * commerce#749 (`firestarter_disputes.image_urls`, fixed in this change and
 * deliberately NOT listed here).
 *
 * The list only shrinks. Adding a new parameter without declaring it fails the
 * test below; clearing the backlog is tracked separately.
 */
const KNOWN_UNDECLARED = new Set<string>([
  "firestarter_execute.location",
  "firestarter_execute.requested_by",
  "firestarter_approve.delivery_address",
  "firestarter_approve.shipping_option_index",
  "firestarter_approve.consent_nonce",
  "firestarter_list.source_url",
  "firestarter_list.ship_from",
  "firestarter_list.shipping_policy",
  "firestarter_list.fulfillment_mode",
  "firestarter_list.allow_imageless",
  "firestarter_list.allow_duplicate",
  "firestarter_list.brand",
  "firestarter_list.sku",
  "firestarter_list.condition",
  "firestarter_list.return_policy",
  "firestarter_list.ship_time_days",
  "firestarter_list.country_of_origin",
  "firestarter_list.length_in",
  "firestarter_list.width_in",
  "firestarter_list.height_in",
  "firestarter_list.weight_oz",
  "firestarter_list.materials",
  "firestarter_list.tags",
  "firestarter_list.variants",
  "firestarter_update_listing.fulfillment_mode",
  "firestarter_update_listing.allow_imageless",
  "firestarter_update_listing.brand",
  "firestarter_update_listing.sku",
  "firestarter_update_listing.condition",
  "firestarter_update_listing.return_policy",
  "firestarter_update_listing.ship_time_days",
  "firestarter_update_listing.country_of_origin",
  "firestarter_update_listing.length_in",
  "firestarter_update_listing.width_in",
  "firestarter_update_listing.height_in",
  "firestarter_update_listing.weight_oz",
  "firestarter_update_listing.materials",
  "firestarter_update_listing.tags",
  "firestarter_update_listing.variants",
]);

describe("manifest input schemas declare every registered parameter", () => {
  const cases: Array<[string, any]> = [
    ["src/mcp/mcp.json", manifest],
    ["mcp.json", rootManifest],
  ];

  it.each(cases)("%s declares the parameters the server accepts", (label, m) => {
    const live = registeredToolParams();
    expect(live.size).toBeGreaterThan(50);

    const missing: string[] = [];
    for (const tool of m.tools || []) {
      const params = live.get(tool.name);
      if (!params) continue;
      const declared = new Set(Object.keys(tool.inputSchema?.properties || {}));
      for (const p of params) {
        const key = `${tool.name}.${p}`;
        if (!declared.has(p) && !KNOWN_UNDECLARED.has(key)) missing.push(key);
      }
    }
    expect(
      missing,
      `${label} is missing parameters the server accepts — agents reading the manifest cannot use them: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
