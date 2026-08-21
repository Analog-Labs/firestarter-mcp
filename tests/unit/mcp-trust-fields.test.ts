/**
 * Trust fields in the preview + catalog structured shapes.
 *
 * The shopping widget has rendered stars and a sold count since it shipped
 * (ui/shopping-item.ts starsLabel, ui/shopping-results.client.ts) — it just
 * never received the fields, because neither schema sent them. This wires the
 * supply side; the widget needs no change.
 *
 * Field names deliberately match what the widget already reads: `rating`,
 * `rating_count`, `units_sold`, `images`.
 */
import { describe, it, expect } from "vitest";
import { toPreviewStructured, toCatalogStructured } from "../../src/mcp/schemas.js";

describe("toPreviewStructured — trust fields", () => {
  it("maps the API's seller aggregate onto the widget's field names", () => {
    const out = toPreviewStructured(
      { options: [{ id: "lst_1", title: "Wallet", price: 40, currency: "USD",
                    seller_rating: 4.6, seller_rating_count: 12, units_sold: 7,
                    images: ["https://a/1.jpg", "https://a/2.jpg"] }] },
      { query: "wallet" },
    );
    expect(out.options[0].rating).toBe(4.6);
    expect(out.options[0].rating_count).toBe(12);
    expect(out.options[0].units_sold).toBe(7);
    expect(out.options[0].images).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
  });

  it("emits null/0/[] when the API sends nothing — never a fabricated zero rating", () => {
    const out = toPreviewStructured({ options: [{ id: "x", title: "T", price: 1, currency: "USD" }] }, { query: "t" });
    expect(out.options[0].rating).toBeNull();
    expect(out.options[0].rating_count).toBe(0);
    expect(out.options[0].units_sold).toBe(0);
    expect(out.options[0].images).toEqual([]);
  });

  it("drops non-https image entries", () => {
    const out = toPreviewStructured(
      { options: [{ id: "x", title: "T", price: 1, currency: "USD",
                    images: ["javascript:alert(1)", "http://a/x.jpg", "https://a/ok.jpg"] }] },
      { query: "t" },
    );
    expect(out.options[0].images).toEqual(["https://a/ok.jpg"]);
  });

  it("does not move the output schema version — the fields are additive", () => {
    const out = toPreviewStructured({ options: [] }, { query: "t" });
    expect(out.schema_version).toBe("2026-07-07");
  });
});

describe("toCatalogStructured — trust fields", () => {
  it("carries rating, count and units sold onto catalog rows", () => {
    const out = toCatalogStructured(
      {}, [{ id: "lst_1", product_name: "Wallet", current_price: 40, currency: "USD",
             buyable: true, images: [], seller_rating: 4.2, seller_rating_count: 9, units_sold: 4 }], null,
    );
    expect(out.listings[0].rating).toBe(4.2);
    expect(out.listings[0].rating_count).toBe(9);
    expect(out.listings[0].units_sold).toBe(4);
  });

  it("emits null/0 for a listing whose seller has no reviews", () => {
    const out = toCatalogStructured(
      {}, [{ id: "lst_2", product_name: "New", current_price: 5, currency: "USD", buyable: true, images: [] }], null,
    );
    expect(out.listings[0].rating).toBeNull();
    expect(out.listings[0].rating_count).toBe(0);
    expect(out.listings[0].units_sold).toBe(0);
  });
});
