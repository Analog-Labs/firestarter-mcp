import { describe, it, expect } from "vitest";
import {
  MCP_OUTPUT_SCHEMA_VERSION,
  PREVIEW_REASON_LABELS,
  previewOutputSchema,
  toPreviewStructured,
} from "../../src/mcp/schemas.js";

/**
 * P1 — structured, versioned tool outputs.
 * These assert the firestarter_preview mapper produces a payload that validates
 * against the advertised outputSchema (the same object the MCP SDK validates at
 * call time), so a mapper↔schema drift fails here instead of at runtime.
 */
describe("MCP structured output — firestarter_preview", () => {
  const sampleData = {
    query: "polo t-shirt",
    count: 2,
    options: [
      {
        id: "lst_abc",
        title: "Classic Polo",
        price: 18,
        currency: "USD",
        image_url: "https://img.example/1.jpg",
        seller: "Acme",
        source: "firestarter_seller",
        url: "https://firestarter.network/l/lst_abc",
        in_stock: true,
        purchasable: true,
        shipping: { known: true, amount_usd: 0, note: "free" },
        eligible: true,
        reasons: [],
      },
      {
        id: "ext_9",
        title: "Vintage Polo",
        price: 40,
        currency: "USD",
        image_url: null,
        seller: "eBay Seller",
        source: "google_shopping",
        url: "https://ebay.example/9",
        in_stock: true,
        purchasable: false,
        shipping: { known: false, amount_usd: null, note: "at checkout" },
        eligible: false,
        reasons: ["NOT_CHECKOUT_CAPABLE", "BUDGET_EXCEEDED"],
      },
    ],
  };

  it("maps a preview response into a schema-valid structured payload", () => {
    const structured = toPreviewStructured(sampleData, { query: "polo t-shirt", country: "US" });
    const parsed = previewOutputSchema.parse(structured); // throws on drift
    expect(parsed.schema_version).toBe(MCP_OUTPUT_SCHEMA_VERSION);
    expect(parsed.count).toBe(2);
    expect(parsed.buyable_count).toBe(1); // only the eligible + purchasable one
    expect(parsed.destination).toEqual({ country: "US", city: null });
    expect(parsed.blocked).toBe(false);
  });

  it("preserves typed numbers and computes total_usd from price + known shipping", () => {
    const { options } = toPreviewStructured(sampleData, { query: "polo t-shirt" });
    expect(options[0].price_usd).toBe(18);
    expect(options[0].total_usd).toBe(18); // 18 + free shipping
    expect(options[0].id).toBe("lst_abc"); // available for chaining to firestarter_execute
    expect(options[1].price_usd).toBe(40);
    expect(options[1].total_usd).toBeNull(); // shipping unknown → no landed total
  });

  it("labels blocker codes for both humans and machines", () => {
    const { options } = toPreviewStructured(sampleData, { query: "polo t-shirt" });
    expect(options[1].blockers).toEqual([
      { code: "NOT_CHECKOUT_CAPABLE", label: PREVIEW_REASON_LABELS.NOT_CHECKOUT_CAPABLE },
      { code: "BUDGET_EXCEEDED", label: PREVIEW_REASON_LABELS.BUDGET_EXCEEDED },
    ]);
  });

  it("returns valid (non-error) structured output for blocked and empty responses", () => {
    const blocked = previewOutputSchema.parse(
      toPreviewStructured({ blocked: true, reason: "unsupported item", query: "x" }, { query: "x" }),
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe("unsupported item");
    expect(blocked.count).toBe(0);
    expect(blocked.options).toEqual([]);

    const empty = previewOutputSchema.parse(toPreviewStructured({ query: "y", options: [] }, { query: "y" }));
    expect(empty.count).toBe(0);
    expect(empty.blocked).toBe(false);
  });

  it("defaults destination to null when no location is given", () => {
    const s = toPreviewStructured({ query: "z", options: [] }, { query: "z" });
    expect(s.destination).toBeNull();
  });
});
