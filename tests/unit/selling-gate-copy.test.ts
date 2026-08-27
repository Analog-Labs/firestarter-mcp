/**
 * commerce#949: no agent-facing copy in this package may quote a
 * selling-gate threshold as a literal.
 *
 * The gate's numbers live in commerce (`apps/api/src/services/selling-gate.ts`)
 * and they move: commerce#942 took the age from 30 days to 90 and added a $100
 * floor below which the age rule never fires at all. This package went on
 * saying "30 days" in six places, so from the moment #942 promoted, every agent
 * was telling sellers a threshold the gate had stopped enforcing.
 *
 * Correcting the literals would not have fixed it. Remote MCP serves a PINNED
 * version, so a hard-coded figure is wrong for every deploy between a constant
 * moving and the pin moving — and commerce/apps/web's own guard for this drift
 * (check-selling-gate-claims.mjs) scans apps/web and cannot see another repo.
 *
 * So the rule is stronger than "keep the number right": don't state the number
 * unless the API just told you it. `sellingGateSentence` renders from
 * GET /v1/sellers/payout-method's `selling_gate`, and says the rule without
 * figures when there is nothing to render from — vague and true beats precise
 * and wrong.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sellingGateSentence } from "../../src/mcp/tools.js";

const TOOLS = readFileSync(join(__dirname, "../../src/mcp/tools.ts"), "utf8");
/** Everything except the helper itself, which is allowed to format numbers. */
const OUTSIDE_HELPER = (() => {
  const start = TOOLS.indexOf("export function sellingGateSentence");
  const end = TOOLS.indexOf("export function toErrorMessage");
  return TOOLS.slice(0, start) + TOOLS.slice(end);
})();

describe("commerce#949 — selling-gate copy is rendered, not written", () => {
  it("quotes no hold-age threshold anywhere", () => {
    const hits = OUTSIDE_HELPER.match(/\b\d+\s*days?\s+old\b/gi) || [];
    expect(hits, "a hold-age threshold is hard-coded — render it from the API instead").toEqual([]);
  });

  it("quotes no hold cap next to the pause rule", () => {
    const hits = OUTSIDE_HELPER.match(/held earnings reach \$[\d,]+/gi) || [];
    expect(hits, "a hold cap is hard-coded — render it from the API instead").toEqual([]);
  });

  it("renders both thresholds when the API supplies them", () => {
    const s = sellingGateSentence({ hold_cap_cents: 100_000, max_age_days: 90, age_min_cents: 10_000 });
    expect(s).toContain("$1,000");
    expect(s).toContain("90 days");
    expect(s).toContain("$100"); // the floor #942 added, which no copy ever mentioned
  });

  it("follows the API rather than any number of its own", () => {
    // The proof that nothing is baked in: change the inputs, the sentence follows.
    const s = sellingGateSentence({ hold_cap_cents: 250_000, max_age_days: 45, age_min_cents: 5_000 });
    expect(s).toContain("$2,500");
    expect(s).toContain("45 days");
    expect(s).not.toContain("1,000");
    expect(s).not.toContain("90");
  });

  it("states the rule without figures when the API supplies none", () => {
    for (const gate of [null, undefined, {}, { hold_cap_cents: 100_000 }, { max_age_days: 90 }]) {
      const s = sellingGateSentence(gate as never);
      expect(s).toMatch(/selling pauses/i);
      expect(s, "invented a threshold from a partial payload").not.toMatch(/\$[\d,]+|\d+ days/);
    }
  });
});
