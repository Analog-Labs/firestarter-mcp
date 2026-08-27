/**
 * Which surface the detail view asks for.
 *
 * The view used to request "fullscreen" unconditionally, which is a takeover:
 * the transcript disappears behind a product page on both Claude and ChatGPT.
 * A docked side panel is the better read for a thing the buyer is comparing
 * against what the agent just said — and `pip` is the only mode in the MCP Apps
 * spec that means that. So the request became a LADDER over what the host says
 * it can actually do (`availableDisplayModes` in the host context).
 *
 * The fallback matters as much as the preference: a host that never advertises
 * the field at all must keep getting "fullscreen", which is exactly what it got
 * before this existed. A ladder that degraded to inline there would have
 * silently un-fixed the composer bug on every host that has not adopted the key.
 */
import { describe, it, expect } from "vitest";
import { preferredDetailMode } from "../../src/mcp/ui/display-mode.js";

describe("preferredDetailMode", () => {
  it("docks to the side when the host offers a panel", () => {
    expect(preferredDetailMode(["inline", "fullscreen", "pip"])).toBe("pip");
  });

  it("takes the whole window when the host has no panel to give", () => {
    expect(preferredDetailMode(["inline", "fullscreen"])).toBe("fullscreen");
  });

  it("still asks for fullscreen when the host never advertises its modes", () => {
    // The pre-ladder behaviour, preserved. Every host that predates
    // availableDisplayModes lands here, and the detail view must not quietly
    // become an inline card on all of them.
    expect(preferredDetailMode(undefined)).toBe("fullscreen");
    expect(preferredDetailMode(null)).toBe("fullscreen");
  });

  it("stays inline when inline is genuinely all there is", () => {
    expect(preferredDetailMode(["inline"])).toBe("inline");
  });

  it("ignores modes it does not understand rather than requesting them", () => {
    // A host inventing "sidebar" must not have that echoed back at it as a
    // display mode request the spec has no meaning for.
    expect(preferredDetailMode(["inline", "sidebar", "theatre"])).toBe("inline");
  });

  it("treats a non-array as no advertisement at all", () => {
    expect(preferredDetailMode("pip")).toBe("fullscreen");
    expect(preferredDetailMode({ 0: "pip" })).toBe("fullscreen");
  });

  it("survives an advertisement full of junk", () => {
    expect(preferredDetailMode([null, 42, { mode: "pip" }, "pip"])).toBe("pip");
  });
});
