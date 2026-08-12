/**
 * Safety-annotation contract for the MCP tool surface.
 *
 * Hosts use `readOnlyHint` to decide what may run WITHOUT asking the user, and
 * `destructiveHint` to decide what to warn about. On a commerce server that is a
 * money question: `firestarter_approve` charges a card, `withdraw_wallet` moves
 * money out, `payouts` changes where every future payout is SENT, `assist_book`
 * dispatches a courier and bills it.
 *
 * The rule that generates them: a tool is read-only only if it changes no state.
 * Anything that writes is a write, and the subset that moves money or destroys a
 * record is destructive.
 *
 * The previous version of this file STATED that rule but only enforced it
 * against a hand-maintained list of 15 tools out of 83 — everything else was
 * checked merely for the PRESENCE of an annotation. That is how eight
 * money-moving tools came to be annotated `destructiveHint: false`, in direct
 * contradiction of the safety model the README advertises. It also read the
 * annotations by grepping source text, so it could not see what a client
 * actually receives, and its `server.tool(` regex missed `firestarter_preview`
 * (registered through `registerToolCompat`) entirely.
 *
 * This version reads the REAL annotations off a connected client's
 * `tools/list`, and enforces three layers:
 *   1. a mechanical rule no new tool can dodge (writes are not read-only);
 *   2. a curated money list that must stay destructive;
 *   3. a full snapshot, so ANY new or reclassified tool fails until a human
 *      deliberately updates it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/mcp/tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(__dirname, "..", "..", "src", "mcp", "tools.ts");
const SNAPSHOT_PATH = resolve(__dirname, "tool-annotations.snapshot.json");
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

interface Annotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

let tools: { name: string; annotations: Annotations }[] = [];
let byName = new Map<string, Annotations>();

beforeAll(async () => {
  const server = new McpServer({ name: "annotation-probe", version: "0.0.0" });
  registerTools(server, "fs_test_annotation_probe", "http://127.0.0.1:1");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  tools = listed.tools.map((t) => ({ name: t.name, annotations: (t.annotations ?? {}) as Annotations }));
  byName = new Map(tools.map((t) => [t.name, t.annotations]));
  await client.close();
});

/**
 * Source block for one tool's registration: from its name line up to the next
 * tool's. Used only for the mechanical write-detection below — the annotations
 * themselves come from the live tools/list, never from source.
 */
function toolSourceBlocks(): Map<string, string> {
  const lines = SOURCE.split("\n");
  const starts: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(server\.tool|registerToolCompat)\(\s*$/.test(lines[i])) continue;
    // `server.tool(` puts the name on the next line; `registerToolCompat(`
    // passes `server,` first, so scan a short window.
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const m = lines[j].match(/"(firestarter_[a-z0-9_]+)"/);
      if (m) {
        starts.push({ name: m[1], line: i });
        break;
      }
    }
  }
  const blocks = new Map<string, string>();
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
    blocks.set(s.name, lines.slice(s.line, end).join("\n"));
  });
  return blocks;
}

/** Tools whose handler issues at least one state-changing upstream request. */
function writingTools(): string[] {
  const out: string[] = [];
  for (const [name, block] of toolSourceBlocks()) {
    if (/apiRequest\(\s*"(POST|PUT|PATCH|DELETE)"/.test(block)) out.push(name);
  }
  return out;
}

/**
 * Tools that use a non-GET verb but change no state, so they are legitimately
 * read-only. Every entry needs a reason, because each one is a hole punched in
 * the mechanical rule below. Keep this list as close to empty as possible.
 */
const READ_ONLY_DESPITE_WRITE_VERB: Record<string, string> = {
  // POSTs only because the destination is a request body rather than a query
  // string. Creates no execution, no approval, no record — it is the estimator a
  // buyer uses while still browsing.
  firestarter_shipping_estimate: "POST /v1/shipping/estimate is a pure calculation",
};

// Tools that spend, move, redirect, forgive, or destroy. Never read-only, always
// destructive. Several of these multiplex read and write on one tool (bare call
// lists, call-with-arguments moves money); MCP annotations are per-tool, so the
// classification covers the worst the tool can do.
const DESTRUCTIVE = [
  "firestarter_approve",           // charges the card
  "firestarter_cancel",            // voids/refunds
  "firestarter_return",            // refunds
  "firestarter_confirm_delivery",  // releases escrow, irreversibly
  "firestarter_fund_wallet",       // takes a deposit
  "firestarter_withdraw_wallet",   // pays out
  "firestarter_payouts",           // sets where ALL seller earnings are sent
  "firestarter_connect_payouts",   // ditto, market owners
  "firestarter_assist_book",       // dispatches a crew, bills the order
  "firestarter_create_voucher",    // seller funds the discount from proceeds
  "firestarter_create_drop",       // commits wallet/margin to a discount pot
  "firestarter_cancel_drop",
  "firestarter_seller_disputes",   // action "refund" refunds in full
  "firestarter_disputes",          // accept/withdraw settle or abandon escrow
  "firestarter_join_market",       // redirects fee attribution, replaces prior
  "firestarter_leave_market",
  "firestarter_set_spend_cap",     // loosens a spending guard
  "firestarter_set_auto_approve_limit",
  "firestarter_delist",
  "firestarter_delete_ship_from",
  "firestarter_unwatch",
];

// Pure queries — safe for a host to run unattended.
const READ_ONLY = [
  "firestarter_status",
  "firestarter_preview",
  "firestarter_wallet_balance",
  "firestarter_catalog_search",
  "firestarter_seller_orders",
  "firestarter_listings",
  "firestarter_addresses",
  "firestarter_receipt",
  "firestarter_track_order",
  "firestarter_shipping_options",
  "firestarter_shipping_estimate", // POSTs, but creates nothing and changes nothing
  "firestarter_market_preview",
  "firestarter_discover_markets",
];

describe("MCP tool safety annotations", () => {
  it("exposes the full tool surface to a connected client", () => {
    expect(tools.length).toBeGreaterThan(70);
    // registerToolCompat-registered tools are included; the old source-regex
    // approach silently skipped this one.
    expect(byName.has("firestarter_preview")).toBe(true);
  });

  it("annotates every registered tool with a human-readable title", () => {
    const bad = tools.filter((t) => !t.annotations.title || t.annotations.title.length <= 2);
    expect(bad.map((t) => t.name), "tools missing an annotations title").toEqual([]);
    for (const t of tools) {
      expect(t.annotations.title, `${t.name} title looks like a raw identifier`).not.toMatch(/firestarter_|_/);
    }
  });

  // ── Layer 1: mechanical. No new tool can dodge this one. ────────────────────
  it("never marks a state-changing tool read-only", () => {
    const offenders = writingTools().filter(
      (name) => byName.get(name)?.readOnlyHint === true && !(name in READ_ONLY_DESPITE_WRITE_VERB),
    );
    expect(
      offenders,
      `these tools issue a POST/PUT/PATCH/DELETE but claim readOnlyHint: true, ` +
      `so a host may run them unattended: ${offenders.join(", ")}. If one genuinely ` +
      `changes no state, add it to READ_ONLY_DESPITE_WRITE_VERB with a reason.`,
    ).toEqual([]);
  });

  it("keeps every write-verb exemption justified and genuinely read-only", () => {
    for (const [name, reason] of Object.entries(READ_ONLY_DESPITE_WRITE_VERB)) {
      expect(byName.has(name), `exempted tool no longer exists: ${name}`).toBe(true);
      expect(reason.length, `${name}'s exemption needs a real reason`).toBeGreaterThan(20);
      // An exemption only makes sense for a tool actually claiming read-only.
      expect(byName.get(name)?.readOnlyHint, `${name} is exempted but is not read-only`).toBe(true);
      expect(READ_ONLY, `${name} is exempted, so pin it in READ_ONLY too`).toContain(name);
    }
  });

  it("never marks a tool both read-only and destructive", () => {
    const contradictory = tools
      .filter((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  // ── Layer 2: curated money list. ────────────────────────────────────────────
  it.each(DESTRUCTIVE)("marks %s destructive and never read-only", (tool) => {
    const ann = byName.get(tool);
    expect(ann, `tool not registered: ${tool}`).toBeDefined();
    expect(ann!.destructiveHint, `${tool} moves money or destroys a record`).toBe(true);
    // The load-bearing half: readOnly would let a host skip the confirmation.
    expect(ann!.readOnlyHint).toBe(false);
  });

  it.each(READ_ONLY)("marks %s read-only and non-destructive", (tool) => {
    const ann = byName.get(tool);
    expect(ann, `tool not registered: ${tool}`).toBeDefined();
    expect(ann!.readOnlyHint).toBe(true);
    expect(ann!.destructiveHint ?? false).toBe(false);
  });

  it("declares payment tools non-idempotent, so a retry is never silently repeated", () => {
    for (const tool of ["firestarter_approve", "firestarter_fund_wallet", "firestarter_withdraw_wallet"]) {
      expect(byName.get(tool)?.idempotentHint, `${tool} must not claim idempotency`).toBe(false);
    }
  });

  // ── Layer 3: full snapshot. Any new or reclassified tool fails here. ────────
  it("matches the committed annotation snapshot", () => {
    const current: Record<string, Annotations> = {};
    for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      current[t.name] = {
        readOnlyHint: t.annotations.readOnlyHint,
        destructiveHint: t.annotations.destructiveHint,
        idempotentHint: t.annotations.idempotentHint,
      };
    }
    if (process.env.UPDATE_ANNOTATION_SNAPSHOT === "1") {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    expect(
      current,
      "Tool annotations changed. If deliberate, re-run with " +
      "UPDATE_ANNOTATION_SNAPSHOT=1 and review the diff — every entry here is a " +
      "decision about what a host may run without asking the user.",
    ).toEqual(expected);
  });
});
