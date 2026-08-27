/**
 * How the widget identifies its own tool calls to the server.
 *
 * The detail view tops itself up by calling firestarter_product through the
 * host bridge. That call wants DATA — the widget renders photos straight from
 * the CDN and has no use for the base64 copies firestarter_product inlines for
 * text-only agents, which can be most of the 1MB result budget.
 *
 * Request `_meta` is the channel: MCP passes it through to the handler as
 * `extra._meta`. A host that strips it costs us the wasted bytes and nothing
 * else — this marker gates an optimisation, never a correctness rule, and no
 * behaviour may come to depend on its presence.
 *
 * Shared by the client (which sends it) and tools.ts (which reads it), so the
 * two cannot drift on the spelling. Pure — it is bundled into the iframe.
 */

/** Namespaced so it cannot collide with a host's or the SDK's own `_meta`. */
export const WIDGET_SURFACE_KEY = "network.firestarter/surface";

export const WIDGET_SURFACE = "widget";

/** True when this call came from the shopping widget rather than an agent. */
export function isWidgetCall(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  return (meta as Record<string, unknown>)[WIDGET_SURFACE_KEY] === WIDGET_SURFACE;
}
