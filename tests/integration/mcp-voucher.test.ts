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
    { tool: (n: string, _d: string, _s: any, h: ToolHandler) => { tools[n] = h; } } as any,
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
});
