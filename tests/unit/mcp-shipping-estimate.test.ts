/**
 * Pre-purchase shipping estimate renderer (renderShippingEstimate).
 *
 * The web listing page could already quote shipping for a listing+destination
 * pair (POST /v1/shipping/estimate), but the MCP surface could not — everything
 * shipping-rich required an execution to exist. These tests lock the new
 * buyer-facing estimate rendering: bulleted (NOT numbered) rows so the output
 * can never be confused with the approve menu's shipping_option_index, the
 * carrier/estimate tagging rules shared with renderDeliveryOptions, and the
 * soft-ask / not-shippable relays instead of hard errors.
 */
import { describe, it, expect } from "vitest";
import { renderShippingEstimate } from "../../src/mcp/tools.js";

const OPTIONS = [
  { method_type: "standard", label: "USPS Ground", carrier: "USPS", service: "Ground", price_cents: 699, currency: "USD", delivery_days: 6, delivery_range: "~6 business days", is_estimated: false, badges: ["Best Value"] },
  { method_type: "express", label: "UPS 2-Day", carrier: "UPS", service: "2-Day", price_cents: 2299, currency: "USD", delivery_days: 2, is_estimated: false, badges: ["Fastest"] },
];

function estimate(over: Record<string, unknown> = {}) {
  return { shippable: true, options: OPTIONS, fallback_used: false, ...over };
}

describe("renderShippingEstimate", () => {
  it("renders a bulleted (non-numbered) list — estimate rows are not approve indices", () => {
    const lines = renderShippingEstimate(estimate());
    expect(lines[0]).toMatch(/Shipping estimate/i);
    expect(lines[0]).toMatch(/pre-purchase/i);
    const body = lines.join("\n");
    expect(body).toContain("- USPS Ground");
    expect(body).toContain("- UPS 2-Day");
    // No [0]/[1] menu numbers anywhere — that idiom belongs to the approve menu.
    expect(body).not.toMatch(/\[\d+\]/);
    // The closing hint routes the buyer into the real buy flow.
    expect(lines[lines.length - 1]).toMatch(/firestarter_execute/);
    expect(lines[lines.length - 1]).toMatch(/NOT approve indices/);
  });

  it("shows each option's price, ETA, and badges", () => {
    const body = renderShippingEstimate(estimate()).join("\n");
    expect(body).toContain("$6.99");
    expect(body).toContain("$22.99");
    expect(body).toContain("~6 business days"); // delivery_range preferred
    expect(body).toContain("~2 days"); // delivery_days fallback
    expect(body).toContain("Best Value");
    expect(body).toContain("Fastest");
  });

  it("renders free shipping as 'free' and a missing price as 'price at checkout'", () => {
    const body = renderShippingEstimate(estimate({
      options: [
        { label: "Local Pickup Courier", price_cents: 0, delivery_days: 1, is_estimated: false, badges: [] },
        { label: "Freight", price_cents: null, delivery_days: 14, is_estimated: false, badges: [] },
      ],
    })).join("\n");
    expect(body).toContain("free");
    expect(body).toContain("price at checkout");
  });

  it("shows non-USD prices with their currency code instead of a $ sign", () => {
    const body = renderShippingEstimate(estimate({
      options: [{ label: "Kerry Express", price_cents: 5000, currency: "THB", delivery_days: 2, is_estimated: false, badges: [] }],
    })).join("\n");
    expect(body).toContain("50.00 THB");
    expect(body).not.toContain("$50.00");
  });

  it("tags 'via <carrier>' only when the label doesn't already lead with it", () => {
    const body = renderShippingEstimate(estimate({
      options: [
        { label: "USPS Ground", carrier: "USPS", price_cents: 699, delivery_days: 6, is_estimated: false, badges: [] },
        { label: "Two-Day Air", carrier: "UPS", price_cents: 2299, delivery_days: 2, is_estimated: false, badges: [] },
      ],
    })).join("\n");
    expect(body).toContain("via UPS");
    expect(body).not.toContain("via USPS");
  });

  it("marks estimate tiers, naming the no-carrier case explicitly", () => {
    const lines = renderShippingEstimate(estimate({
      fallback_used: true,
      options: [
        { label: "Standard Shipping", price_cents: 699, delivery_days: 6, is_estimated: true, badges: [] },
        { label: "DHL Express", carrier: "DHL", price_cents: 2299, delivery_days: 2, is_estimated: true, badges: [] },
      ],
    }));
    const body = lines.join("\n");
    expect(body).toContain("estimate · carrier assigned at fulfillment"); // no carrier
    expect(body).toMatch(/DHL Express.*estimate/); // has carrier: plain "estimate" tag
    expect(body).toContain("live carrier rates are quoted at approval"); // fallback banner
  });

  it("relays the not-shippable reason instead of erroring", () => {
    const lines = renderShippingEstimate({ shippable: false, reason: "Seller only ships within Thailand", options: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("can't ship");
    expect(lines[0]).toContain("Seller only ships within Thailand");
  });

  it("relays the SHIPPING_ESTIMATE_NEEDS_FIELDS soft-ask with the missing fields", () => {
    const lines = renderShippingEstimate({
      shippable: false,
      code: "SHIPPING_ESTIMATE_NEEDS_FIELDS",
      missing: ["country", "zip"],
      message: "What country and ZIP should this ship to?",
      options: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("What country and ZIP should this ship to?");
    expect(lines[0]).toContain("missing: country, zip");
  });

  it("suggests a tighter locality when shippable but no rates came back", () => {
    const lines = renderShippingEstimate(estimate({ options: [] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/country \+ ZIP/);
  });
});

// Route-class context: an international route carries a duties warning and a
// hyperlocal route advertises the same-day possibility — both change the buying
// decision and must ride along with the estimate, not surface after approval.
describe("renderShippingEstimate route context", () => {
  it("notes import duties on an international route", () => {
    const body = renderShippingEstimate(estimate({ route_class: "international" })).join("\n");
    expect(body).toMatch(/international route/i);
    expect(body).toMatch(/duties/i);
  });

  it("notes possible same-day courier on a hyperlocal route", () => {
    const body = renderShippingEstimate(estimate({ route_class: "hyperlocal" })).join("\n");
    expect(body).toMatch(/same-day/i);
  });

  it("adds no route note for a plain domestic route", () => {
    const body = renderShippingEstimate(estimate({ route_class: "domestic" })).join("\n");
    expect(body).not.toMatch(/duties|same-day/i);
  });
});
