/**
 * Pure view helpers for the shopping-results product grid.
 *
 * These live outside shopping-results.client.ts so they can be tested in Node —
 * the client itself touches DOM globals at import time. esbuild bundles them
 * into the same IIFE, so what is tested here is what ships in the iframe.
 *
 * The badge is the reason this module exists. The grid was written for the two
 * buyer-facing tools, where every item carries a `buyable`/`purchasable` flag,
 * so an item with neither fell through to "Browse-only". Seller listings and
 * community shelves carry no such flag, so every one of their cards would have
 * claimed the item cannot be bought.
 */
import { describe, it, expect } from "vitest";
import { badgeFor, priceLabel, firstImage } from "../../src/mcp/ui/shopping-item.js";

describe("badgeFor", () => {
  it("marks a buyable, eligible catalog hit as buyable now", () => {
    expect(badgeFor({ buyable: true, eligible: true })).toEqual({ text: "Buyable now", cls: "ok" });
  });

  it("drops the 'now' when a purchasable option fails a hard gate", () => {
    expect(badgeFor({ purchasable: true, eligible: false })).toEqual({ text: "Buyable", cls: "ok" });
  });

  it("still calls an explicitly non-buyable listing browse-only", () => {
    expect(badgeFor({ buyable: false })).toEqual({ text: "Browse-only", cls: "muted" });
  });

  it("shows no badge at all when buyability is simply unknown", () => {
    // The old fallback was "Browse-only", which told a seller their own live
    // listing could not be bought. Saying nothing is the honest option.
    expect(badgeFor({})).toBeNull();
    expect(badgeFor({ title: "No flags here" })).toBeNull();
  });

  it("uses the item's own status label when it has one", () => {
    expect(badgeFor({ status_label: "Draft" })).toEqual({ text: "Draft", cls: "muted" });
    expect(badgeFor({ status_label: "★ Pick" })).toEqual({ text: "★ Pick", cls: "muted" });
  });

  it("lets explicit buyability outrank a status label", () => {
    // Whether a buyer can check out is the more consequential fact; a
    // provenance label must never mask it.
    expect(badgeFor({ status_label: "★ Pick", buyable: false })).toEqual({
      text: "Browse-only",
      cls: "muted",
    });
  });

  it("ignores a blank status label rather than rendering an empty pill", () => {
    expect(badgeFor({ status_label: "   " })).toBeNull();
  });
});

describe("priceLabel", () => {
  it("formats a catalog listing's price in its own currency", () => {
    expect(priceLabel({ current_price: 18.5, currency: "USD" })).toBe("USD 18.50");
  });

  it("formats a preview option's usd price", () => {
    expect(priceLabel({ price_usd: 42, currency: "USD" })).toBe("USD 42.00");
  });

  it("falls back to minor units when no float price is present", () => {
    expect(priceLabel({ price: { amount_minor: 1299, currency: "EUR" } })).toBe("EUR 12.99");
  });

  it("renders nothing when there is no price to show", () => {
    expect(priceLabel({})).toBe("");
    expect(priceLabel({ price: { amount_minor: null, currency: "USD" } as any })).toBe("");
  });
});

describe("firstImage", () => {
  it("reads the singular image field a community shelf sends", () => {
    expect(firstImage({ image: "https://cdn.test/a.jpg" })).toBe("https://cdn.test/a.jpg");
  });

  it("reads the first usable entry of an images array", () => {
    expect(firstImage({ images: ["https://cdn.test/b.jpg", "https://cdn.test/c.jpg"] }))
      .toBe("https://cdn.test/b.jpg");
  });

  it("skips a non-http entry rather than returning a broken src", () => {
    expect(firstImage({ images: ["/relative.jpg", "https://cdn.test/d.jpg"] }))
      .toBe("https://cdn.test/d.jpg");
    expect(firstImage({ image: "javascript:alert(1)" })).toBeNull();
  });

  it("returns null when the item has no photo", () => {
    expect(firstImage({})).toBeNull();
    expect(firstImage({ images: [] })).toBeNull();
  });
});
