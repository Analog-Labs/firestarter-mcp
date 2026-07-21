/**
 * Agent-facing community-market shelf.
 *
 * The buyer-facing web page (/m/<handle>) shows a community's curated shelf, but
 * the MCP tools returned only a flat "Joined." with no next step. These tests
 * drive the REAL registered tool handlers (captured via a fake McpServer) against
 * a mocked global fetch, and lock:
 *   - firestarter_market_preview: a read-only, pre-join view with the shelf.
 *   - firestarter_join_market: the shelf appended to the join confirmation.
 *   - firestarter_my_market: the shelf appended to the status.
 *   - graceful degradation when the public community view can't be fetched.
 *   - the framing guardrail: never promise the buyer a discount/cashback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

function textOf(res: any): string {
  return (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

function json(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const COMMUNITY_WITH_PICKS = {
  code: "TANIACODE1",
  name: "Tania Saleem",
  tagline: "Sticker picks for makers",
  active: true,
  program_status: "active",
  picks: [
    { listing_id: "lst_abc", product_name: "Might-Not-Make-It Sticker", price: 3, note: "my favorite", image: null },
    { listing_id: "lst_def", product_name: "Send Help Sticker", price: 4.5, note: null, image: null },
  ],
};

// Per-test fetch behavior, keyed by endpoint.
let routes: {
  community?: (code: string) => Response;
  redeem?: () => Response;
  me?: () => Response;
};

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/marketplace/community/")) {
        const code = decodeURIComponent(u.split("/marketplace/community/")[1]);
        return routes.community ? routes.community(code) : json(404, { error: "not found", code: "COMMUNITY_NOT_FOUND" });
      }
      if (method === "POST" && u.endsWith("/v1/attribution/redeem")) {
        return routes.redeem ? routes.redeem() : json(200, {});
      }
      if (method === "GET" && u.endsWith("/v1/attribution/me")) {
        return routes.me ? routes.me() : json(200, { community: null });
      }
      return json(404, { error: `unhandled ${method} ${u}` });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_market_preview", () => {
  it("renders name, tagline, the shelf (with listing_ids), and the join instruction", async () => {
    routes.community = () => json(200, { community: COMMUNITY_WITH_PICKS });
    const t = textOf(await captureTools()["firestarter_market_preview"]({ code: "TANIACODE1" }));
    expect(t).toContain("Tania Saleem");
    expect(t).toContain("Sticker picks for makers");
    expect(t).toContain("Might-Not-Make-It Sticker");
    expect(t).toContain("$3.00");
    expect(t).toContain("$4.50");
    expect(t).toContain("my favorite");
    expect(t).toContain("lst_abc");
    expect(t).toContain("firestarter_join_market");
    expect(t).toContain("firestarter_execute");
  });

  it("never promises the buyer a discount or cashback (framing guardrail)", async () => {
    routes.community = () => json(200, { community: COMMUNITY_WITH_PICKS });
    const t = textOf(await captureTools()["firestarter_market_preview"]({ code: "TANIACODE1" })).toLowerCase();
    expect(t).toContain("at no extra cost");
    expect(t).not.toContain("discount");
    expect(t).not.toContain("cashback");
  });

  it("truncates a long shelf and notes the remainder", async () => {
    const picks = Array.from({ length: 8 }, (_, i) => ({
      listing_id: `lst_${i}`, product_name: `Sticker ${i}`, price: i + 1, note: null, image: null,
    }));
    routes.community = () => json(200, { community: { ...COMMUNITY_WITH_PICKS, picks } });
    const t = textOf(await captureTools()["firestarter_market_preview"]({ code: "X" }));
    expect(t).toContain("Sticker 0");
    expect(t).toContain("Sticker 5");
    expect(t).not.toContain("Sticker 6"); // capped at SHELF_RENDER_LIMIT (6)
    expect(t).toContain("and 2 more");
  });

  it("handles a community with no curated shelf", async () => {
    routes.community = () => json(200, { community: { ...COMMUNITY_WITH_PICKS, picks: [] } });
    const t = textOf(await captureTools()["firestarter_market_preview"]({ code: "X" }));
    expect(t).toContain("hasn't curated a shelf yet");
  });

  it("errors clearly when the code resolves to no community", async () => {
    routes.community = () => json(404, { error: "Community market not found", code: "COMMUNITY_NOT_FOUND" });
    const res = await captureTools()["firestarter_market_preview"]({ code: "NOPE" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Couldn't find");
  });
});

describe("firestarter_join_market", () => {
  it("appends the community's shelf to the join confirmation", async () => {
    routes.redeem = () => json(200, {});
    routes.community = () => json(200, { community: COMMUNITY_WITH_PICKS });
    const t = textOf(await captureTools()["firestarter_join_market"]({ code: "TANIACODE1" }));
    expect(t).toContain("Joined the market");
    expect(t).toContain("What Tania Saleem recommends");
    expect(t).toContain("lst_abc");
  });

  it("still confirms the join when the shelf fetch fails (best-effort)", async () => {
    routes.redeem = () => json(200, {});
    routes.community = () => json(500, { error: "boom" });
    const res = await captureTools()["firestarter_join_market"]({ code: "TANIACODE1" });
    const t = textOf(res);
    expect(t).toContain("Joined the market");
    expect(t).not.toContain("recommends");
    expect(res.isError).toBeFalsy();
  });
});

describe("firestarter_my_market", () => {
  it("appends the shelf so status doubles as re-discovery", async () => {
    routes.me = () => json(200, {
      community: {
        connected: true, name: "Tania Saleem", code: "TANIACODE1",
        program_status: "active", locked_until: "2026-10-01T00:00:00Z", attributed_at: "2026-07-01T00:00:00Z",
      },
    });
    routes.community = () => json(200, { community: COMMUNITY_WITH_PICKS });
    const t = textOf(await captureTools()["firestarter_my_market"]({}));
    expect(t).toContain("Connected to:");
    expect(t).toContain("What Tania Saleem recommends");
    expect(t).toContain("lst_abc");
  });

  it("reports not-connected without a shelf", async () => {
    routes.me = () => json(200, { community: null });
    const t = textOf(await captureTools()["firestarter_my_market"]({}));
    expect(t).toContain("not connected");
    expect(t).not.toContain("recommends");
  });
});
