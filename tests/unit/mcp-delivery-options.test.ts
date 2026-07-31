/**
 * Buyer-facing delivery-options menu (renderDeliveryOptions).
 *
 * The rates already existed on execution_options.shipping_options; the gap was
 * that they were never SHOWN, so the agent silently used the cheapest and the
 * buyer never got to pick a speed. These tests lock the surfaced menu: it lists
 * every method with its index (= approve's shipping_option_index), price, ETA,
 * and an all-in total that includes the app margin. When there is only ONE
 * method it still NAMES that service (no index — nothing to choose), and it
 * stays out of the way entirely for browse-only options.
 */
import { describe, it, expect } from "vitest";
import { renderDeliveryOptions } from "../../src/mcp/tools.js";

const METHODS = [
  { method_type: "standard", label: "USPS Ground", carrier: "USPS", service: "Ground", price_cents: 699, delivery_days: 6, delivery_range: "~6 business days", is_estimated: false, badges: ["Best Value"] },
  { method_type: "express", label: "UPS 2-Day", carrier: "UPS", service: "2-Day", price_cents: 2299, delivery_days: 2, is_estimated: false, badges: ["Fastest"] },
];

function purchasableOpt(over: Record<string, unknown> = {}) {
  return { purchasable: true, subtotal: 45.0, tax: 0, shipping_options: METHODS, ...over };
}

describe("renderDeliveryOptions", () => {
  it("renders a numbered menu whose numbers are the shipping_option_index", () => {
    const lines = renderDeliveryOptions(purchasableOpt(), null);
    expect(lines[0]).toMatch(/Delivery options/i);
    expect(lines.some((l) => l.includes("[0] USPS Ground"))).toBe(true);
    expect(lines.some((l) => l.includes("[1] UPS 2-Day"))).toBe(true);
    // closing hint tells the agent how to act on the numbers
    expect(lines[lines.length - 1]).toMatch(/shipping_option_index/);
  });

  it("shows each method's price, ETA, and badges", () => {
    const lines = renderDeliveryOptions(purchasableOpt(), null).join("\n");
    expect(lines).toContain("$6.99");
    expect(lines).toContain("$22.99");
    expect(lines).toContain("~6 business days"); // delivery_range preferred
    expect(lines).toContain("~2 days"); // delivery_days fallback
    expect(lines).toContain("Best Value");
    expect(lines).toContain("Fastest");
  });

  it("computes an all-in total = subtotal + shipping + tax (no margin) when no margin", () => {
    const lines = renderDeliveryOptions(purchasableOpt(), null).join("\n");
    // standard: 4500 + 699 + 0 = 5199
    expect(lines).toContain("$51.99 all-in");
    // express: 4500 + 2299 + 0 = 6799
    expect(lines).toContain("$67.99 all-in");
  });

  it("subtracts a voucher/drop discount from the all-in (subtotal is gross)", () => {
    // Regression: subtotal is GROSS, so a discounted option used to preview an
    // all-in that overstated the real charge by the discount amount.
    const lines = renderDeliveryOptions(purchasableOpt({ discount: 10 }), null).join("\n");
    // standard: 4500 - 1000 + 699 + 0 = 4199
    expect(lines).toContain("$41.99 all-in");
    // express: 4500 - 1000 + 2299 + 0 = 5799
    expect(lines).toContain("$57.99 all-in");
  });

  it("adds the app integration margin to the all-in, matching the charge path", () => {
    // 2% margin, no cap. standard base 5199 -> +104 (round(5199*0.02)) = 5303
    const lines = renderDeliveryOptions(purchasableOpt(), { margin_bps: 200 }).join("\n");
    expect(lines).toContain("$53.03 all-in");
  });

  it("names the single delivery service (no [index]) when there is no speed choice", () => {
    const lines = renderDeliveryOptions(purchasableOpt({ shipping_options: [METHODS[0]] }), null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Delivery: USPS Ground/);
    expect(lines[0]).toContain("$6.99");
    expect(lines[0]).toContain("~6 business days");
    expect(lines[0]).toContain("$51.99 all-in");
    // a single service has no choice to make — no numbered index, no menu header
    expect(lines[0]).not.toMatch(/\[0\]/);
  });

  it("returns nothing for browse-only options", () => {
    expect(renderDeliveryOptions(purchasableOpt({ purchasable: false }), null)).toEqual([]);
  });

  it("returns nothing when no shipping options exist", () => {
    expect(renderDeliveryOptions(purchasableOpt({ shipping_options: null }), null)).toEqual([]);
  });

  it("labels an estimated (non-carrier) rate as an estimate", () => {
    const est = [
      { label: "Standard", price_cents: 649, delivery_days: 5, is_estimated: true, badges: [] },
      { label: "Express", price_cents: 2199, delivery_days: 1, is_estimated: true, badges: [] },
    ];
    const lines = renderDeliveryOptions(purchasableOpt({ shipping_options: est }), null).join("\n");
    expect(lines).toContain("estimate");
  });

  it("shows free shipping as 'free', not $0.00", () => {
    const withFree = [
      { label: "Standard", price_cents: 0, delivery_days: 5, is_estimated: false, badges: ["Best Value"] },
      { label: "Express", price_cents: 1500, delivery_days: 1, is_estimated: false, badges: ["Fastest"] },
    ];
    const lines = renderDeliveryOptions(purchasableOpt({ shipping_options: withFree }), null).join("\n");
    expect(lines).toContain("[0] Standard · free");
  });
});

// Concrete arrival dates + the helpers behind them. "arrives ~Tue, Jul 28"
// answers "when will it get here?" without making the buyer do date math;
// estimate tiers get NO date (a fabricated date implies a promise no carrier
// made). provenanceLine turns the internal shipping_provenance enum into a
// human sentence.
import { arrivalDateFromDays, provenanceLine } from "../../src/mcp/tools.js";

describe("arrival dates on delivery options", () => {
  it("appends a concrete arrival date to real carrier rows", () => {
    const body = renderDeliveryOptions(purchasableOpt(), null).join("\n");
    expect(body).toMatch(/arrives ~\w{3}, \w{3} \d{1,2}/);
  });

  it("never fabricates a date for an estimated tier", () => {
    const est = purchasableOpt({
      shipping_options: [
        { method_type: "standard", label: "Standard Shipping", carrier: "Estimated", service: "standard", price_cents: 699, delivery_days: 5, is_estimated: true, badges: [] },
        { method_type: "express", label: "Express Shipping", carrier: "Estimated", service: "express", price_cents: 2299, delivery_days: 1, is_estimated: true, badges: [] },
      ],
    });
    expect(renderDeliveryOptions(est, null).join("\n")).not.toMatch(/arrives ~/);
  });
});

describe("arrivalDateFromDays", () => {
  it("computes now + days in en-US short form", () => {
    const now = new Date("2026-07-22T12:00:00Z");
    expect(arrivalDateFromDays(2, now)).toBe(new Date("2026-07-24T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));
  });
  it("returns null for missing/invalid day counts", () => {
    expect(arrivalDateFromDays(null)).toBeNull();
    expect(arrivalDateFromDays(undefined)).toBeNull();
    expect(arrivalDateFromDays(NaN)).toBeNull();
    expect(arrivalDateFromDays(-1)).toBeNull();
  });
});

describe("provenanceLine", () => {
  it("maps each provenance to a human sentence", () => {
    expect(provenanceLine("real")).toMatch(/live carrier rate/);
    expect(provenanceLine("seller")).toMatch(/seller/);
    expect(provenanceLine("flat")).toMatch(/flat rate/);
    expect(provenanceLine("unknown")).toMatch(/checkout/);
  });
  it("stays silent on absent/unrecognized values", () => {
    expect(provenanceLine(null)).toBeNull();
    expect(provenanceLine(undefined)).toBeNull();
    expect(provenanceLine("something-else")).toBeNull();
  });
});
