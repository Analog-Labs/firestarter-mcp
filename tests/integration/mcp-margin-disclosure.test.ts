/**
 * D3.5: developer-margin disclosure in the rendered chat option list. When an
 * execution carries a developer_margin block (org charges a margin), the
 * firestarter_status render must (a) warn at the options header and (b) show
 * each purchasable option's TRUE margin-inclusive total - so a human's
 * "approve option 1" is approval of the real number, not one that grows at pay.
 * Zero margin -> render unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;
function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools({ tool: (n: string, _d: string, _s: any, h: ToolHandler) => { tools[n] = h; } } as any, "fsk_test", "http://api.test");
  return tools;
}
function installFetch(json: any) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } })));
}
afterEach(() => vi.unstubAllGlobals());
function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

const execWith = (developer_margin: any) => ({
  id: "exec_d35",
  status: "awaiting_approval",
  request_text: "wireless headphones",
  options: [
    { product_title: "Sony WH-1000XM5", total: "100.00", subtotal: "92.00", shipping: "8.00", supplier: "AudioCo", purchasable: true },
    { product_title: "External pick", total: "80.00", supplier: "eBay", purchasable: false, product_url: "https://ebay.com/x" },
  ],
  ...(developer_margin ? { developer_margin } : {}),
});

describe("firestarter_status margin disclosure (D3.5)", () => {
  it("discloses the margin and each purchasable option's true total", async () => {
    const tools = captureTools();
    installFetch(execWith({ margin_bps: 200, per_transaction_cap_cents: 5000 }));
    const text = textOf(await tools.firestarter_status({ execution_id: "exec_d35" }));
    // Header caveat
    expect(text).toMatch(/2\.00% integration margin/);
    expect(text).toMatch(/capped at \$50/);
    expect(text).toMatch(/state it to the buyer before they confirm/i);
    // Purchasable option: $100 + 2% = $102.00 (+$2.00)
    expect(text).toContain("Total with app margin: $102.00 (+$2.00)");
  });

  it("applies the per-transaction cap to the shown total", async () => {
    const tools = captureTools();
    // 10% of $100 = $10, but cap is $1 -> total $101.00
    installFetch(execWith({ margin_bps: 1000, per_transaction_cap_cents: 100 }));
    const text = textOf(await tools.firestarter_status({ execution_id: "exec_d35" }));
    expect(text).toContain("Total with app margin: $101.00 (+$1.00)");
  });

  it("does NOT add a margin total to a browse-only external option", async () => {
    const tools = captureTools();
    installFetch(execWith({ margin_bps: 200, per_transaction_cap_cents: 5000 }));
    const text = textOf(await tools.firestarter_status({ execution_id: "exec_d35" }));
    // Only one inclusive-total line (the purchasable Sony), not the eBay pick.
    expect(text.match(/Total with app margin/g)?.length).toBe(1);
  });

  it("zero / absent margin leaves the render unchanged", async () => {
    const tools = captureTools();
    installFetch(execWith(null));
    const text = textOf(await tools.firestarter_status({ execution_id: "exec_d35" }));
    expect(text).not.toMatch(/integration margin/);
    expect(text).not.toContain("Total with app margin");
  });
});
