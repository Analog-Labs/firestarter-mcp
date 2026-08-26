/**
 * Which surface the detail view asks the host for.
 *
 * The MCP Apps spec has exactly three display modes — `inline`, `fullscreen`
 * and `pip` — and both host families (Claude and ChatGPT) negotiate over the
 * same three. There is no "side panel" mode to request: `pip` IS the docked
 * panel, and asking for it is how a view says "put me beside the conversation
 * rather than on top of it".
 *
 * The view used to request `fullscreen` unconditionally, which is a takeover of
 * the whole window for something the buyer is usually reading against what the
 * agent just said. Preferring `pip` keeps the transcript on screen.
 *
 * A LADDER rather than a fixed choice, because the mode is the host's to grant:
 * it publishes `availableDisplayModes` in the host context, and asking for one
 * it never offered just burns a round trip to be told no. Pure and Node-tested
 * for the same reason safe-area.ts is — the decision is worth testing, the DOM
 * plumbing around it is not.
 */

/** The three modes the spec defines, best surface for a detail view first. */
const LADDER = ["pip", "fullscreen", "inline"] as const;

export type DetailDisplayMode = (typeof LADDER)[number];

/**
 * The best detail surface this host actually offers.
 *
 * A host that advertises nothing (or advertises something unreadable) gets
 * `fullscreen` — the behaviour that predates this function. Falling through to
 * `inline` there would silently downgrade every host that has not adopted
 * `availableDisplayModes` yet, which is most of them.
 */
export function preferredDetailMode(available: unknown): DetailDisplayMode {
  if (!Array.isArray(available)) return "fullscreen";
  const offered = new Set(available.filter((m): m is string => typeof m === "string"));
  return LADDER.find((mode) => offered.has(mode)) ?? "fullscreen";
}
