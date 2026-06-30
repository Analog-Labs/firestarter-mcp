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
 */
import { describe, it, expect } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";
import manifest from "../../src/mcp/mcp.json" with { type: "json" };

function registeredToolNames(): string[] {
  const names: string[] = [];
  // Minimal McpServer stub: registerTools only calls server.tool(name, ...).
  const stub = { tool: (name: string) => { names.push(name); } } as any;
  delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  registerTools(stub, "fs_test_parity", "http://local");
  return names.sort();
}

const manifestToolNames: string[] = ((manifest as any).tools || []).map((t: any) => t.name).sort();

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
});
