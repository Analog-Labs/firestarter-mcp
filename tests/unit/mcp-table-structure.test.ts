/**
 * GFM table structural integrity under hostile/overflow content.
 *
 * Two defects shipped in 2.6.0 and were caught by a deep e2e audit:
 *  1. mdTable's pipe-escaper used "\|" — which in a JS string literal is just
 *     "|" — so escaping was a NO-OP: a | inside a cell (a buyer's request text
 *     "A | B") split its row into extra columns. Cells passing through
 *     sanitizeUntrusted were shielded by accident; raw cells were not.
 *  2. firestarter_status pre-sliced executions to the cap before calling
 *     mdTable, so the "…and N more" hint was unreachable dead code.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fs_test_table_structure", "http://api.test");
  return tools;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function text(res: any): string {
  return (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

/** Split a table line into cells on UNESCAPED pipes only. */
function cells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

/** All body rows of the first GFM table in the text. */
function tableRows(t: string): string[][] {
  const lines = t.split("\n");
  const hi = lines.findIndex((l, i) => l.trim().startsWith("|") && /^\|[-\s|]+\|$/.test((lines[i + 1] || "").trim()));
  if (hi < 0) return [];
  const rows: string[][] = [];
  for (let i = hi + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
  return rows;
}

afterEach(() => vi.unstubAllGlobals());

describe("pipes inside cells never break row structure", () => {
  it("a | in the buyer's own request text stays one cell", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      environment: "live",
      executions: [
        { id: "exec_1", status: "cancelled", request_text: "Nasty | pipe | laden request", created_at: "2026-08-01T10:00:00.000Z" },
        { id: "exec_2", status: "completed", request_text: "Plain", created_at: "2026-08-01T10:00:00.000Z", total: 42.5, currency: "USD" },
      ],
    })));
    const t = text(await captureTools().firestarter_status({}));
    const rows = tableRows(t);

    expect(rows.length).toBe(2);
    // The defect: the hostile row split into 8 cells instead of 5.
    expect(rows.every((r) => r.length === 5)).toBe(true);
    expect(t).toContain("Nasty \\| pipe \\| laden");
  });

  it("a | in a listing name stays one cell in the listings table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ listings: [
      { id: "lst_1", product_name: "Pipe | Bomb | Name", current_price: 5, currency: "USD",
        status: "active", inventory_qty: 1, created_at: "2026-06-15T08:35:51.000Z",
        share_url: "https://firestarter.network/l/lst_1", images: [] },
    ]})));
    const t = text(await captureTools().firestarter_listings({}));
    const rows = tableRows(t);

    expect(rows.length).toBe(1);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });
});

describe("order-history overflow is announced, not silently dropped", () => {
  it("15 executions → 10 rows plus an '…and 5 more' hint", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `exec_${i}`, status: "completed", request_text: `Item ${i}`, created_at: "2026-08-01T10:00:00.000Z",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => json({ environment: "live", executions: many, total: 166 })));
    const t = text(await captureTools().firestarter_status({}));

    expect(tableRows(t).length).toBe(10);
    expect(t).toContain("…and 5 more");
    expect(t).toContain("pass status_filter or an execution_id to narrow");
  });

  it("10 or fewer executions → no phantom hint", async () => {
    const few = Array.from({ length: 3 }, (_, i) => ({
      id: `exec_${i}`, status: "completed", request_text: `Item ${i}`, created_at: "2026-08-01T10:00:00.000Z",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => json({ environment: "live", executions: few, total: 3 })));
    const t = text(await captureTools().firestarter_status({}));

    expect(t).not.toContain("more");
    expect(tableRows(t).length).toBe(3);
  });
});
