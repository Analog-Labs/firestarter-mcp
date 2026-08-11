/**
 * firestarter_catalog_search — query hygiene + zero-result broadened retry.
 *
 * Agents relay buyer phrasing verbatim ("wireless earbuds under 50"). The
 * catalog's q matches text only, so a price phrase in the query hurts recall
 * while the buyer's actual cap goes unenforced, and a too-specific multi-word
 * query that misses forces the agent into a whole extra round-trip through
 * the buyer. Pins:
 *  - "under/over/between $N" phrases are stripped from q and applied as
 *    min_price/max_price (explicit args always win);
 *  - a zero-result multi-word query is retried ONCE with its head noun, and
 *    the result says so;
 *  - a genuine zero-result search still returns the no-match guidance and
 *    a single-word query is never retried.
 *
 * Same harness as mcp-listing-images.test.ts: real registered handlers via a
 * fake McpServer against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

const LISTING = {
  id: "lst_w1",
  product_name: "Leather Wallet",
  category: "Accessories",
  current_price: 20,
  currency: "USD",
  buyable: true,
  images: [],
};

let fetchCalls: string[];
/** Per-URL responder: return listings for a given q, [] otherwise. */
let respond: (q: string | null) => any[];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = new URL(String(url));
      fetchCalls.push(String(url));
      const listings = respond(u.searchParams.get("q"));
      return new Response(
        JSON.stringify({ query: { environment: "test" }, count: listings.length, listings, has_more: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

function qs(call: string): URLSearchParams {
  return new URL(call).searchParams;
}

function text(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

beforeEach(() => {
  fetchCalls = [];
  respond = () => [LISTING];
  installFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("price-phrase extraction", () => {
  it("moves 'under $N' out of q and into max_price", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wireless earbuds under $50" });
    const p = qs(fetchCalls[0]);
    expect(p.get("q")).toBe("wireless earbuds");
    expect(p.get("max_price")).toBe("50");
    expect(text(res)).toContain("max $50");
  });

  it("handles a bare number ceiling and floor wordings", async () => {
    const tools = captureTools();
    await tools.firestarter_catalog_search({ query: "leather wallet under 50" });
    expect(qs(fetchCalls[0]).get("max_price")).toBe("50");

    await tools.firestarter_catalog_search({ query: "watch over $100" });
    expect(qs(fetchCalls[1]).get("min_price")).toBe("100");
    expect(qs(fetchCalls[1]).get("q")).toBe("watch");
  });

  it("handles 'between $A and $B' as a range", async () => {
    const tools = captureTools();
    await tools.firestarter_catalog_search({ query: "desk lamp between $20 and $60" });
    const p = qs(fetchCalls[0]);
    expect(p.get("q")).toBe("desk lamp");
    expect(p.get("min_price")).toBe("20");
    expect(p.get("max_price")).toBe("60");
  });

  it("never overrides an explicitly-passed price filter", async () => {
    const tools = captureTools();
    await tools.firestarter_catalog_search({ query: "earbuds under 50", max_price: 30 });
    const p = qs(fetchCalls[0]);
    expect(p.get("max_price")).toBe("30"); // explicit arg wins
    expect(p.get("q")).toBe("earbuds");    // phrase still leaves the text
  });

  it("leaves a price-free query untouched", async () => {
    const tools = captureTools();
    await tools.firestarter_catalog_search({ query: "leather conditioner" });
    const p = qs(fetchCalls[0]);
    expect(p.get("q")).toBe("leather conditioner");
    expect(p.get("min_price")).toBeNull();
    expect(p.get("max_price")).toBeNull();
  });
});

describe("zero-result broadened retry", () => {
  it("retries a missed multi-word query once with its head noun and says so", async () => {
    respond = (q) => (q === "wallet" ? [LISTING] : []);
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "red leather wallet" });

    expect(fetchCalls).toHaveLength(2);
    expect(qs(fetchCalls[0]).get("q")).toBe("red leather wallet");
    expect(qs(fetchCalls[1]).get("q")).toBe("wallet");
    const out = text(res);
    expect(out).toContain("Leather Wallet");
    expect(out).toContain('No exact matches for "red leather wallet"');
    expect(out).toContain("wallet");
  });

  it("keeps the other filters on the retry", async () => {
    respond = (q) => (q === "wallet" ? [LISTING] : []);
    const tools = captureTools();
    await tools.firestarter_catalog_search({ query: "red leather wallet", country: "US", buyable_only: true });
    const p = qs(fetchCalls[1]);
    expect(p.get("country")).toBe("US");
    expect(p.get("buyable_only")).toBe("true");
  });

  it("does not retry a single-word query, and reports no match", async () => {
    respond = () => [];
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(fetchCalls).toHaveLength(1);
    expect(text(res)).toContain("No catalog listings matched");
  });

  it("reports no match when even the broadened retry finds nothing", async () => {
    respond = () => [];
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "red leather wallet" });
    expect(fetchCalls).toHaveLength(2);
    expect(text(res)).toContain("No catalog listings matched");
  });
});
