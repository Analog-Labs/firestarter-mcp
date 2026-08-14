/**
 * Advertise the tool surface in MCP's JSON Schema dialect, draft 2020-12(#736).
 *
 * The SDK emits draft-07 for every tool, and gives us no way to ask for
 * anything else. `server/zod-json-schema-compat.js` defaults
 * `mapMiniTarget(undefined)` to `'draft-7'`, and `server/mcp.js` calls it with
 * no target for both `inputSchema` and `outputSchema` — so the target is not
 * plumbed through `registerTool` at all. We are on zod 4, whose own
 * `toJSONSchema()` targets 2020-12; the v3-compat shim overrides it back down.
 *
 * A lenient host does not care — the tools work fine in Claude Code, which is
 * why this went unnoticed until a strict host rejected `firestarter_preview`.
 * A host that validates the advertised schema against the spec dialect refuses
 * the tool outright, which would block listing the server on agent
 * marketplaces (#524).
 *
 * WHY A BARE `$schema` SWAP IS SUFFICIENT, and not a structural conversion:
 * the two dialects disagree on `definitions` vs `$defs`, tuple-form `items`
 * vs `prefixItems`, and `dependencies`. None of those appear anywhere in what
 * we emit. The full keyword set across all ~95 tools is `type`, `properties`,
 * `required`, `description`, `additionalProperties`, `anyOf`, `const`, `enum`,
 * `format`, `pattern`, `items` (schema form only), `propertyNames`, and the
 * numeric/length bounds — every one of which means the same thing in both
 * dialects. `tests/unit/mcp-schema-dialect.test.ts` pins that: if a future tool
 * introduces a construct that genuinely differs, the dialect assertion is the
 * thing that has to grow a real converter.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The dialect MCP specifies. */
export const MCP_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

type JsonSchema = Record<string, unknown>;

/** Re-stamp one schema's dialect, leaving every other keyword untouched. */
function retarget(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  return { ...(schema as JsonSchema), $schema: MCP_JSON_SCHEMA_DIALECT };
}

/**
 * Wrap the server's `tools/list` so every advertised schema declares 2020-12.
 *
 * Called at the end of `registerTools`, so it covers every transport (stdio,
 * Streamable HTTP, WebSocket) without each entrypoint having to remember. The
 * SDK installs its `tools/list` handler on the FIRST tool registration and
 * guards re-installation, so wrapping afterwards is stable: a tool registered
 * later still flows through the SDK handler we captured, and still gets
 * re-stamped here.
 *
 * No-ops on the minimal server doubles some unit tests pass in (they implement
 * `tool()` only and have no underlying protocol object).
 */
export function enforceSchemaDialect(server: McpServer): void {
  const inner = (server as unknown as { server?: Record<string, unknown> }).server;
  if (!inner || typeof (inner as { setRequestHandler?: unknown }).setRequestHandler !== "function") return;

  // The only private touch: the SDK exposes no getter for an installed
  // handler. `setRequestHandler` is documented to REPLACE, so capturing the
  // SDK's handler first is what keeps this a wrapper instead of a rewrite of
  // the listing logic.
  const handlers = (inner as { _requestHandlers?: Map<string, unknown> })._requestHandlers;
  const listTools = handlers?.get("tools/list") as
    | ((request: unknown, extra: unknown) => Promise<{ tools?: unknown[] }>)
    | undefined;
  if (!listTools) return;

  (inner as unknown as {
    setRequestHandler: (schema: unknown, handler: (req: unknown, extra: unknown) => unknown) => void;
  }).setRequestHandler(ListToolsRequestSchema, async (request: unknown, extra: unknown) => {
    const result = await listTools(request, extra);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return {
      ...result,
      tools: tools.map((tool) => {
        const t = tool as { inputSchema?: unknown; outputSchema?: unknown };
        const next: Record<string, unknown> = { ...(t as Record<string, unknown>) };
        if (t.inputSchema) next.inputSchema = retarget(t.inputSchema);
        if (t.outputSchema) next.outputSchema = retarget(t.outputSchema);
        return next;
      }),
    };
  });
}
