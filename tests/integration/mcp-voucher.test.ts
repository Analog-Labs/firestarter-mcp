/**
 * firestarter_create_voucher — a community-market owner who isn't a seller has
 * nothing of their own to discount, so the API rejects with NO_SELLER. The tool
 * must turn that into an actionable next step rather than a bare error an agent
 * can misreport as an outage. Drives the REAL registered handler against a
 * mocked global fetch (mirrors the other MCP harnesses).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    { tool: (n: string, ...rest: any[]) => { tools[n] = rest[rest.length - 1] as ToolHandler; } } as any,
    "fsk_test",
    "http://api.test",
  );
  return tools;
}

function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_create_voucher — non-seller guidance", () => {
  it("turns a NO_SELLER rejection into an actionable next step", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Register as a seller first", code: "NO_SELLER" }), { status: 403, headers: { "Content-Type": "application/json" } }),
    ));
    const res = await captureTools().firestarter_create_voucher({ code: "CREW10", discount_percent: 10 });
    expect(res.isError).toBe(true);
    const t = textOf(res);
    // Names why (not a seller) and the concrete next step.
    expect(t).toMatch(/seller/i);
    expect(t).toMatch(/firestarter_create_listing/);
    // Must NOT read as a transient outage or bury the reason behind a generic prefix.
    expect(t).not.toMatch(/could not create the voucher: register as a seller/i);
  });

  it("relays other failures generically", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Code already exists", code: "DUPLICATE_CODE" }), { status: 409, headers: { "Content-Type": "application/json" } }),
    ));
    const res = await captureTools().firestarter_create_voucher({ code: "DUP", discount_percent: 10 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Could not create the voucher");
  });

  // firestarter_update_voucher requires a voucher_id (promo_...), and its schema
  // tells the agent to get that id "from firestarter_vouchers". If neither the
  // create nor the list tool surfaces the id, the update/pause/resume flow is
  // unreachable — the agent has only the code, which the PATCH route rejects.
  it("surfaces the promo_ id so the voucher can be managed afterwards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({ voucher: { id: "promo_abc12345", code: "QATEST10", discount_type: "percent", discount_percent: 10, discoverable: true } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    ));
    const res = await captureTools().firestarter_create_voucher({ code: "QATEST10", discount_percent: 10 });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("promo_abc12345");
  });
});

describe("firestarter_vouchers — listing", () => {
  it("surfaces each voucher's promo_ id for the update flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          vouchers: [
            {
              id: "promo_abc12345",
              code: "QATEST10",
              discount_type: "percent",
              discount_percent: 10,
              state: "active",
              max_uses: 5,
              redemption_count: 0,
              total_discount_funded_cents: 0,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    const res = await captureTools().firestarter_vouchers({});
    const t = textOf(res);
    // The code stays human-facing; the id is what firestarter_update_voucher needs.
    expect(t).toContain("QATEST10");
    expect(t).toContain("promo_abc12345");
  });
});
