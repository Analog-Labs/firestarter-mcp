/**
 * Keeping the detail view out from under the host's chat composer.
 *
 * When a host puts the widget fullscreen it gets the whole widget viewport —
 * but the host keeps drawing its message box over the bottom of that
 * viewport. With only the stylesheet's 20px of bottom padding, the last
 * stretch of the view (the seller line, the photo and video links) sat behind
 * that box and could not be scrolled clear of it: the content existed, was
 * laid out, and was permanently unreachable. The widget no longer asks for
 * fullscreen itself, but a host can still move it there on its own.
 *
 * Both host families can say how much of the viewport they are covering —
 * hostContext.safeAreaInsets in MCP Apps, window.openai.safeArea in ChatGPT —
 * but a host that reports nothing still covers it. So the reported inset is a
 * floor to raise, never the only defence.
 */
import { describe, it, expect } from "vitest";
import { sheetBottomInset, reportsOwnSize, SHEET_BOTTOM_FLOOR_PX } from "../../src/mcp/ui/safe-area.js";

describe("sheetBottomInset", () => {
  it("clears a composer the host never mentioned", () => {
    // The observed bug: Claude Desktop overlaid its message box and this code
    // had no idea. Reserving nothing is what put the links behind it.
    expect(sheetBottomInset(undefined)).toBe(SHEET_BOTTOM_FLOOR_PX);
    expect(sheetBottomInset({})).toBe(SHEET_BOTTOM_FLOOR_PX);
  });

  it("takes the host at its word when it reserves more than the floor", () => {
    expect(sheetBottomInset({ safeAreaInsets: { top: 0, right: 0, bottom: 220, left: 0 } })).toBe(220);
  });

  it("still reserves the floor when the host claims it covers nothing", () => {
    // A zero here is a host that does not implement insets, not a promise that
    // nothing overlaps — that is precisely the case that shipped broken.
    expect(sheetBottomInset({ safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } })).toBe(SHEET_BOTTOM_FLOOR_PX);
  });

  it("reads ChatGPT's safeArea shape too", () => {
    expect(sheetBottomInset({ safeArea: { bottom: 200 } })).toBe(200);
    expect(sheetBottomInset({ safeArea: { insets: { bottom: 260 } } })).toBe(260);
  });

  it("ignores a nonsense inset instead of collapsing the sheet", () => {
    for (const bottom of [NaN, -50, "tall", null, Infinity]) {
      expect(sheetBottomInset({ safeAreaInsets: { bottom } })).toBe(SHEET_BOTTOM_FLOOR_PX);
    }
  });

  it("caps an absurd inset so the sheet cannot be padded off screen", () => {
    // A host reporting most of the viewport would otherwise push every link
    // below the fold — the failure this fixes, in the other direction.
    expect(sheetBottomInset({ safeAreaInsets: { bottom: 100000 } })).toBeLessThanOrEqual(400);
  });
});

describe("reportsOwnSize", () => {
  it("reports content height while the widget is inline", () => {
    // Inline, the host sizes the frame to whatever we say we need — that is
    // the whole point of the size-changed notification.
    expect(reportsOwnSize("inline")).toBe(true);
    expect(reportsOwnSize(undefined)).toBe(true);
  });

  it("stays quiet once the host has given us the whole window", () => {
    // Reported: the first card click opened fullscreen and then dropped back
    // to the chat with the detail inline; the second click behaved. In
    // fullscreen the host owns the surface, so a stream of "I am 712px tall"
    // notifications is at best meaningless and at worst read as a request to
    // go back to being 712px tall in the transcript.
    expect(reportsOwnSize("fullscreen")).toBe(false);
    expect(reportsOwnSize("pip")).toBe(false);
  });
});
