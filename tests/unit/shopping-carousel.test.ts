/**
 * Auto-carousel state for a multi-photo grid card.
 *
 * The grid used to render a row of tap-only dots: a 4-photo listing looked
 * identical to a 1-photo one until someone noticed the dots and tapped, which
 * nobody does inside a chat transcript. Auto-advancing shows the whole set
 * without a tap.
 *
 * The rules live here, apart from the DOM, because every one of them is a
 * judgement call that must not quietly change: when the rotation runs, when it
 * must stop, and how a grid of cards is de-synchronised. The client module owns
 * timers and elements; this owns the decisions.
 */
import { describe, it, expect } from "vitest";
import { nextIndex, clampIndex, autoAdvances, startDelay, SLIDE_MS } from "../../src/mcp/ui/carousel.js";

describe("nextIndex", () => {
  it("wraps to the first photo after the last", () => {
    // Dead-ending on the last photo reads as a broken gallery rather than a
    // finished one — the same rule apps/web's ListingGallery applies.
    expect(nextIndex(2, 3)).toBe(0);
  });

  it("advances one photo at a time", () => {
    expect(nextIndex(0, 3)).toBe(1);
  });

  it("leaves a one-photo card on its only photo", () => {
    expect(nextIndex(0, 1)).toBe(0);
  });
});

describe("clampIndex", () => {
  it("clamps an out-of-range index to the last photo", () => {
    // A payload can shrink between renders (a photo 404s and is dropped); an
    // index left pointing past the end would blank the card.
    expect(clampIndex(7, 3)).toBe(2);
  });

  it("clamps a negative index to the first photo", () => {
    expect(clampIndex(-1, 3)).toBe(0);
  });

  it("collapses to zero when there are no photos", () => {
    expect(clampIndex(2, 0)).toBe(0);
  });
});

describe("autoAdvances", () => {
  const running = { count: 4, reducedMotion: false, hidden: false, hovered: false, onscreen: true };

  it("rotates a multi-photo card that is on screen and unattended", () => {
    expect(autoAdvances(running)).toBe(true);
  });

  it("never rotates a single-photo card", () => {
    expect(autoAdvances({ ...running, count: 1 })).toBe(false);
  });

  it("holds still while the pointer is on the card", () => {
    // A photo that swaps out from under a buyer mid-look is worse than no
    // rotation at all.
    expect(autoAdvances({ ...running, hovered: true })).toBe(false);
  });

  it("holds still while the card is scrolled out of view", () => {
    // A 50-result grid must not run 50 timers and 50 image fetches for cards
    // nobody is looking at.
    expect(autoAdvances({ ...running, onscreen: false })).toBe(false);
  });

  it("holds still while the tab is hidden", () => {
    expect(autoAdvances({ ...running, hidden: true })).toBe(false);
  });

  it("respects prefers-reduced-motion", () => {
    // Motion the viewer asked not to see. The photos stay reachable by tap.
    expect(autoAdvances({ ...running, reducedMotion: true })).toBe(false);
  });
});

describe("startDelay", () => {
  it("gives neighbouring cards different start times", () => {
    // Without a stagger every card in the grid flips on the same frame, which
    // reads as the whole widget glitching rather than as photos rotating.
    expect(startDelay(0)).not.toBe(startDelay(1));
  });

  it("keeps every stagger inside one slide interval", () => {
    // A stagger longer than the interval delays a card's FIRST rotation past
    // the point a reader has moved on.
    for (const i of [0, 1, 2, 7, 19, 100]) {
      expect(startDelay(i)).toBeGreaterThanOrEqual(0);
      expect(startDelay(i)).toBeLessThan(SLIDE_MS);
    }
  });
});
