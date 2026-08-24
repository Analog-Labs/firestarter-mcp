/**
 * Structured `rating` is the DISPLAY rating: this product's own stars when it
 * has any, the seller's otherwise.
 *
 * Every MCP rating call was seller-level (`stars(l.seller_rating, …)`) while
 * apps/web had switched to product-first in Phase 2. Same listing, two numbers
 * — the exact cross-surface disagreement the product-detail standard exists to
 * end, and it would have gone live the moment staging promoted.
 *
 * The widget reads `rating`/`rating_count` (ui/shopping-item.ts starsLabel) and
 * has no concept of the distinction, so the explicit product_rating and
 * seller_rating fields ride along for hosts that want to draw it themselves.
 */
import { describe, it, expect } from "vitest";
import { displayRating } from "../../src/mcp/media.js";

describe("displayRating", () => {
  it("prefers the product's own rating once it has a single review", () => {
    // One honest review about THIS item beats ninety about the seller's others.
    expect(displayRating({ product_rating: 4.9, product_rating_count: 1, seller_rating: 4.1, seller_rating_count: 90 }))
      .toEqual({ rating: 4.9, rating_count: 1, is_seller_level: false });
  });

  it("falls back to the seller and flags that it did", () => {
    expect(displayRating({ product_rating: null, product_rating_count: 0, seller_rating: 4.1, seller_rating_count: 80 }))
      .toEqual({ rating: 4.1, rating_count: 80, is_seller_level: true });
  });

  it("is null when neither exists — never a fabricated zero", () => {
    expect(displayRating({})).toEqual({ rating: null, rating_count: 0, is_seller_level: false });
  });

  it("treats a rating with a zero count as absent", () => {
    // Unreachable from AVG/COUNT, but a stale cache or hand-built payload can
    // produce it, and "4.0 (0)" describes reviews that do not exist.
    expect(displayRating({ product_rating: 4, product_rating_count: 0 }).rating).toBeNull();
  });

  it("tolerates string numerics from a JSON payload", () => {
    expect(displayRating({ product_rating: "4.5", product_rating_count: "3" }))
      .toEqual({ rating: 4.5, rating_count: 3, is_seller_level: false });
  });

  it("ignores a non-finite rating rather than emitting NaN", () => {
    expect(displayRating({ product_rating: "abc", product_rating_count: 5, seller_rating: 3, seller_rating_count: 2 }))
      .toEqual({ rating: 3, rating_count: 2, is_seller_level: true });
  });
});
