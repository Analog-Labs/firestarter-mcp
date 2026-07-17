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
});
