/**
 * Safety-annotation contract for the MCP tool surface.
 *
 * Hosts use `readOnlyHint` to decide what may run WITHOUT asking the user.
 * On a commerce server that is a money question: `firestarter_approve` charges
 * a card, `withdraw_wallet` moves money out, `confirm_delivery` releases escrow
 * irreversibly. Mis-marking any of them read-only would let a host fire them
 * silently, so these classifications are pinned here rather than left to the
 * next person editing an 80-tool file.
 *
 * The rule that generated them: a tool is read-only only if every request it
 * issues is a GET. Anything that POSTs, PATCHes, PUTs, or DELETEs is a write,
 * and the subset that moves money or destroys a record is destructive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  resolve(__dirname, "..", "..", "src", "mcp", "tools.ts"),
  "utf8",
);
const LINES = SOURCE.split("\n");

/** Annotations attached to a tool, read from its registration block. */
function annotationsOf(tool: string): string {
  const start = LINES.findIndex((l) => l.includes(`"${tool}",`));
  expect(start, `tool not registered: ${tool}`).toBeGreaterThan(-1);
  for (let i = start; i < Math.min(start + 80, LINES.length); i++) {
    if (/readOnlyHint|destructiveHint/.test(LINES[i])) return LINES[i];
    // Stop at the next tool so we never read a neighbour's annotations.
    if (i > start && /server\.tool\(/.test(LINES[i])) break;
  }
  return "";
}

/** Every tool registered via the positional server.tool() form. */
function allTools(): string[] {
  const names: string[] = [];
  for (let i = 0; i < LINES.length; i++) {
    if (!/^\s*server\.tool\(\s*$/.test(LINES[i])) continue;
    const m = LINES[i + 1]?.match(/"([a-z0-9_]+)"/);
    if (m) names.push(m[1]);
  }
  return names;
}

// Tools that spend, move, release, or destroy. Never read-only.
const DESTRUCTIVE = [
  "firestarter_approve",
  "firestarter_cancel",
  "firestarter_fund_wallet",
  "firestarter_withdraw_wallet",
  "firestarter_confirm_delivery",
  "firestarter_cancel_drop",
  "firestarter_delist",
  "firestarter_delete_ship_from",
  "firestarter_unwatch",
];

// Pure queries — safe for a host to run unattended.
const READ_ONLY = [
  "firestarter_status",
  "firestarter_wallet_balance",
  "firestarter_catalog_search",
  "firestarter_seller_orders",
  "firestarter_listings",
  "firestarter_addresses",
];

describe("MCP tool safety annotations", () => {
  it("annotates every registered tool", () => {
    const tools = allTools();
    expect(tools.length).toBeGreaterThan(70);
    const bare = tools.filter((t) => annotationsOf(t) === "");
    expect(bare, `tools missing safety annotations: ${bare.join(", ")}`).toEqual([]);
  });

  it.each(DESTRUCTIVE)("marks %s destructive and never read-only", (tool) => {
    const ann = annotationsOf(tool);
    expect(ann).toContain("destructiveHint: true");
    // The load-bearing half: readOnly would let a host skip the confirmation.
    expect(ann).toContain("readOnlyHint: false");
  });

  it.each(READ_ONLY)("marks %s read-only and non-destructive", (tool) => {
    const ann = annotationsOf(tool);
    expect(ann).toContain("readOnlyHint: true");
    expect(ann).toContain("destructiveHint: false");
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const tool of allTools()) {
      const ann = annotationsOf(tool);
      if (!ann) continue;
      const contradictory =
        ann.includes("readOnlyHint: true") && ann.includes("destructiveHint: true");
      expect(contradictory, `${tool} claims to be both read-only and destructive`).toBe(false);
    }
  });

  it("declares payment tools non-idempotent, so a retry is never silently repeated", () => {
    // Repeating a charge is not a no-op; the hint tells hosts not to auto-retry.
    for (const tool of ["firestarter_approve", "firestarter_fund_wallet", "firestarter_withdraw_wallet"]) {
      expect(annotationsOf(tool)).toContain("idempotentHint: false");
    }
  });
});
