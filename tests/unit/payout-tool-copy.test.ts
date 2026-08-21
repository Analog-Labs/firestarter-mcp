/**
 * The payout tool must not resurrect the browse-only story.
 *
 * PR #727 (firestarter-commerce) made payout connection gate RECEIVING, not
 * SELLING: a seller with no rail lists and sells normally, and selling pauses
 * only once deferred escrow reaches $1,000 or 30 days. The tool description
 * still said listings "show as browse-only" and that buyers "cannot checkout",
 * so every agent reading it told sellers something false.
 *
 * Asserted against the source text because that string IS the product here —
 * it is what the model reads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/mcp/tools.ts", import.meta.url)),
  "utf8",
);

/**
 * Scoped to one tool's own registration block (from its `// Tool: <name>`
 * comment to the next one), not the whole file.
 *
 * "browse-only" is a true, unrelated concept elsewhere in this file (catalog
 * / execute results that genuinely cannot be checked out right now, e.g. an
 * external listing or an unclaimed store) — an unscoped `not.toMatch` would
 * fail forever regardless of this fix. Symmetrically, an unscoped
 * `toMatch(/escrow/i)` would pass vacuously, since the word appears in ~20
 * places that have nothing to do with this tool.
 */
function toolBlock(startMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = SOURCE.indexOf("// Tool:", start + startMarker.length);
  return end === -1 ? SOURCE.slice(start) : SOURCE.slice(start, end);
}

describe("firestarter_payouts copy", () => {
  const BLOCK = toolBlock("// Tool: firestarter_payouts");

  it("does not claim a payout method is required to sell", () => {
    expect(BLOCK).not.toMatch(/browse-only/i);
    expect(BLOCK).not.toMatch(/buyers cannot checkout/i);
    expect(BLOCK).not.toMatch(/REQUIRED for listings to be purchasable/i);
  });

  it("does not repeat PayPal's 200+ countries marketing number", () => {
    // PayPal's own payouts country list omits PK, BD, NG and EG — the exact
    // countries on #839. Quoting the marketing number promises coverage we do
    // not have.
    expect(BLOCK).not.toMatch(/200\+\s*countries/i);
  });

  it("says what a missing payout method actually costs the seller", () => {
    expect(BLOCK).toMatch(/escrow/i);
  });

  it("points sellers at firestarter_payout_eligibility to check a country up front", () => {
    expect(BLOCK).toMatch(/firestarter_payout_eligibility/);
  });
});

describe("firestarter_register_seller success copy", () => {
  // Adjacent defect found while investigating the same falsehood: this
  // tool's own DESCRIPTION already said payouts "can be set up later", but
  // its success response contradicted that by repeating the exact
  // browse-only / checkout-blocked claim being fixed above — telling a
  // brand-new seller the opposite of what registering them just enabled.
  const BLOCK = toolBlock("// Tool: firestarter_register_seller");

  it("does not tell a new seller buyers can't check out without payouts", () => {
    expect(BLOCK).not.toMatch(/browse-only/i);
    expect(BLOCK).not.toMatch(/checkout blocked/i);
  });

  it("agrees with its own description that payouts can be set up later", () => {
    expect(BLOCK).toMatch(/escrow/i);
  });
});
