/**
 * Auto-carousel rules for a multi-photo grid card.
 *
 * Pure on purpose: this module holds every judgement call about WHEN photos
 * rotate, and the client module holds the timers and elements that act on
 * them. Same split as shopping-item.ts — esbuild bundles both into the iframe
 * IIFE, and Node can unit-test this half.
 *
 * The dots this replaces were tap-only, so a 4-photo listing read as a 1-photo
 * one to anyone who did not notice a 6px target inside a chat transcript.
 */

/** One photo per ~3.2s: long enough to look at, short enough that a 4-photo
 *  set finishes before a reader scrolls past. */
export const SLIDE_MS = 3200;

/** Spread between neighbouring cards' first rotation. Coprime-ish with nothing
 *  in particular — it just has to be small enough that every card has started
 *  within one interval (see startDelay). */
const STAGGER_MS = 370;

/** The photo after this one, wrapping. A one-photo card stays put. */
export function nextIndex(index: number, count: number): number {
  if (count < 2) return 0;
  return (index + 1) % count;
}

/** An index that is definitely renderable against `count` photos. A payload can
 *  shrink between renders (a 404'd photo dropped), and an index left past the
 *  end blanks the card. */
export function clampIndex(index: number, count: number): number {
  if (count < 1) return 0;
  return Math.min(Math.max(0, index), count - 1);
}

/** Everything that can stop the rotation. All of it is a reason to hold still,
 *  never a reason to reset — a card resumes on the photo it was showing. */
export interface CarouselEnv {
  count: number;
  reducedMotion: boolean;
  /** document.hidden — a background tab must not fetch photos. */
  hidden: boolean;
  hovered: boolean;
  /** Intersecting the viewport, per IntersectionObserver. */
  onscreen: boolean;
}

export function autoAdvances(env: CarouselEnv): boolean {
  return env.count > 1 && !env.reducedMotion && !env.hidden && !env.hovered && env.onscreen;
}

/**
 * How long card `i` waits before its first rotation.
 *
 * Without this every card flips on the same frame and the grid reads as one
 * glitching widget rather than as photos rotating. Wrapped modulo the interval
 * so card 40 does not wait 15 seconds for its first photo change.
 */
export function startDelay(cardIndex: number): number {
  return (cardIndex * STAGGER_MS) % SLIDE_MS;
}
