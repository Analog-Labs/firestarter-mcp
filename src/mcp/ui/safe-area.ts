/**
 * Keeping the detail view clear of whatever the host draws over the widget.
 *
 * The sheet asks for fullscreen and gets the whole widget viewport — but the
 * host keeps its message composer on top of the bottom of that viewport. The
 * stylesheet reserved 20px, so the last stretch of the sheet (the seller line,
 * the photo and video links) sat behind the composer and could not be scrolled
 * clear of it. Laid out, present, permanently unreachable.
 *
 * Both host families can say how much they are covering — `safeAreaInsets` in
 * the MCP Apps host context, `safeArea` on window.openai — but the host that
 * shipped this bug reported nothing at all. So a reported inset can only RAISE
 * the reserve, never lower it: the floor is the defence, the report is the
 * refinement.
 */

/** Enough to clear a chat composer on the hosts we have seen. Deliberately
 *  generous: over-reserving costs scroll slack at the end of a scrollable
 *  panel, under-reserving costs content nobody can reach. */
export const SHEET_BOTTOM_FLOOR_PX = 160;

/** A host claiming to cover half the screen would push every link below the
 *  fold — the same failure, mirrored. */
const SHEET_BOTTOM_MAX_PX = 400;

/**
 * Pixels to reserve at the bottom of the detail view for host chrome.
 *
 * Accepts either host's shape and distrusts both: a string, a negative, a NaN
 * or an Infinity all fall back to the floor rather than collapsing the reserve.
 */
export function sheetBottomInset(hostContext: unknown): number {
  const ctx = (hostContext ?? {}) as {
    safeAreaInsets?: { bottom?: unknown };
    safeArea?: { bottom?: unknown; insets?: { bottom?: unknown } };
  };
  const reported =
    ctx.safeAreaInsets?.bottom ?? ctx.safeArea?.bottom ?? ctx.safeArea?.insets?.bottom;
  const n = Number(reported);
  if (!Number.isFinite(n) || n <= SHEET_BOTTOM_FLOOR_PX) return SHEET_BOTTOM_FLOOR_PX;
  return Math.min(n, SHEET_BOTTOM_MAX_PX);
}

/**
 * Whether the widget should keep telling the host how tall its content is.
 *
 * Inline, yes: that notification is how the host sizes the frame. In
 * fullscreen the host owns the whole window, and a stream of "I am 712px tall"
 * is at best meaningless there — at worst it reads as a request to go back to
 * being 712px tall in the transcript.
 *
 * Which is what the first-open report looked like: the first card click opened
 * fullscreen and then dropped straight back to the chat with the detail
 * rendered inline, while every click after it behaved. The first open is
 * exactly when the reported height is smallest and changes most — skeletons,
 * unloaded photos, then the lazy fetch landing — so it is the open that
 * generates the noisiest size notifications at the moment the host is deciding
 * what to do with the panel.
 */
export function reportsOwnSize(displayMode: string | undefined): boolean {
  return displayMode !== "fullscreen" && displayMode !== "pip";
}
