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

// ─── Regression: the preview mapper was missed by 2.10.0 ─────────────────────

import { toPreviewStructured, toCatalogStructured } from "../../src/mcp/schemas.js";

const RATED = {
  id: "lst_1", title: "Shoes", price: 1, currency: "USD", purchasable: true,
  image_url: "https://a/1.jpg", images: ["https://a/1.jpg", "https://a/2.jpg"],
  product_rating: 4.8, product_rating_count: 5,
  seller_rating: 4.2, seller_rating_count: 30, units_sold: 9,
};

describe("every structured surface agrees on the display rating", () => {
  it("preview serves the PRODUCT rating, not the seller's", () => {
    // 2.10.0 fixed this in catalogListing and missed the identical line in
    // previewOption, so firestarter_preview — the keyless, first-contact agent
    // surface — served seller stars under the display field's name.
    const o = toPreviewStructured({ options: [RATED] }, { query: "shoes" }).options[0];
    expect(o.rating).toBe(4.8);
    expect(o.rating_count).toBe(5);
    expect(o.rating_is_seller_level).toBe(false);
  });

  it("preview labels the seller fallback instead of passing it off as the product's", () => {
    // The old code set rating to the seller's value AND is_seller_level=false,
    // which is worse than showing nothing: it actively asserts the wrong thing.
    const o = toPreviewStructured({
      options: [{ ...RATED, product_rating: null, product_rating_count: 0 }],
    }, { query: "shoes" }).options[0];
    expect(o.rating).toBe(4.2);
    expect(o.rating_count).toBe(30);
    expect(o.rating_is_seller_level).toBe(true);
  });

  it("preview and catalog return the SAME display rating for the same listing", () => {
    // The whole point of the standard: one listing, one number, every surface.
    const p = toPreviewStructured({ options: [RATED] }, { query: "x" }).options[0];
    const c = toCatalogStructured({}, [{
      id: "lst_1", product_name: "Shoes", current_price: 1, currency: "USD", buyable: true,
      images: RATED.images, product_rating: 4.8, product_rating_count: 5,
      seller_rating: 4.2, seller_rating_count: 30, units_sold: 9,
    }], null).listings[0];
    expect(p.rating).toBe(c.rating);
    expect(p.rating_count).toBe(c.rating_count);
    expect(p.rating_is_seller_level).toBe(c.rating_is_seller_level);
  });

  it("shows nothing when the listing genuinely has no reviews", () => {
    // Production's actual state today: no listing has a single review. Absent
    // must render as absent, never as a zero.
    const o = toPreviewStructured({
      options: [{ ...RATED, product_rating: null, product_rating_count: 0, seller_rating: null, seller_rating_count: 0 }],
    }, { query: "x" }).options[0];
    expect(o.rating).toBeNull();
    expect(o.rating_count).toBe(0);
  });

  it("preview carries the full image array, not just the primary", () => {
    expect(toPreviewStructured({ options: [RATED] }, { query: "x" }).options[0].images).toHaveLength(2);
  });
});
