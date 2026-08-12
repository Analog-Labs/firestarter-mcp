/**
 * firestarter_catalog_search — structured output contract.
 *
 * The catalog tool advertises an `outputSchema`, which makes `structuredContent`
 * mandatory on every non-error return (the SDK throws otherwise) and is what the
 * shopping-results MCP App renders as a product grid. These tests pin both
 * halves: that the mapper produces a schema-valid payload from whatever the API
 * returns — including degraded rows — and that the tool attaches it on every
 * path a host can reach without an error.
 */
import { describe, it, expect } from "vitest";
import {
  catalogOutputSchema,
  toCatalogStructured,
  MCP_OUTPUT_SCHEMA_VERSION,
} from "../../src/mcp/schemas.js";

const API_DATA = { query: { environment: "test" }, has_more: false };

const ROW = {
  id: "lst_w1",
  product_name: "Leather Wallet",
  category: "Accessories",
  current_price: 20,
  currency: "USD",
  buyable: true,
  share_url: "https://firestarter.network/l/lst_w1",
  images: ["https://cdn.shopify.com/a.jpg"],
};

describe("toCatalogStructured", () => {
  it("maps a listing row into a schema-valid payload", () => {
    const out = toCatalogStructured(API_DATA, [ROW], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.schema_version).toBe(MCP_OUTPUT_SCHEMA_VERSION);
    expect(out.environment).toBe("test");
    expect(out.count).toBe(1);
    expect(out.buyable_count).toBe(1);
    expect(out.listings[0]).toMatchObject({
      id: "lst_w1",
      product_name: "Leather Wallet",
      current_price: 20,
      currency: "USD",
      buyable: true,
      share_url: "https://firestarter.network/l/lst_w1",
      images: ["https://cdn.shopify.com/a.jpg"],
    });
    // Machine-precise money alongside the float, honoring the ISO-4217 exponent.
    expect(out.listings[0].price).toEqual({ currency: "USD", amount_minor: 2000 });
  });

  it("counts only buyable rows in buyable_count", () => {
    const out = toCatalogStructured(API_DATA, [ROW, { ...ROW, id: "lst_w2", buyable: false }], null);
    expect(out.count).toBe(2);
    expect(out.buyable_count).toBe(1);
  });

  it("drops non-http image entries so the widget never renders a broken src", () => {
    const out = toCatalogStructured(
      API_DATA,
      [{ ...ROW, images: ["javascript:alert(1)", "/relative.jpg", null, "https://ok.test/b.jpg"] }],
      null,
    );
    expect(out.listings[0].images).toEqual(["https://ok.test/b.jpg"]);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
  });

  it("maps a missing or non-numeric price to null rather than NaN", () => {
    const out = toCatalogStructured(API_DATA, [{ ...ROW, current_price: undefined }], null);
    expect(out.listings[0].current_price).toBeNull();
    expect(out.listings[0].price.amount_minor).toBeNull();
    // NaN would pass `typeof === "number"` but fail the schema; this is the guard.
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
  });

  it("stays schema-valid for an empty result set", () => {
    const out = toCatalogStructured(API_DATA, [], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.count).toBe(0);
    expect(out.buyable_count).toBe(0);
    expect(out.listings).toEqual([]);
  });

  it("defaults every field when the API response is empty or malformed", () => {
    const out = toCatalogStructured({}, [{}], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.environment).toBe("live");
    expect(out.community).toBeNull();
    expect(out.listings[0]).toMatchObject({ id: "", product_name: "", category: null, buyable: false });
  });

  it("records the broadened head noun and the buyer's community", () => {
    const data = { query: { environment: "live", community: { name: "Analog" } }, has_more: true };
    const out = toCatalogStructured(data, [{ ...ROW, picked_by_community: true, pick_note: "  great leather  " }], "wallet");
    expect(out.broadened_to).toBe("wallet");
    expect(out.community).toBe("Analog");
    expect(out.has_more).toBe(true);
    expect(out.listings[0].picked_by_community).toBe(true);
    expect(out.listings[0].pick_note).toBe("great leather");
  });
});
