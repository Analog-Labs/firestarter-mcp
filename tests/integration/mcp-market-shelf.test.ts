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
  programs?: () => Response;
  getPicks?: (id: string) => Response;
  putPicks?: (id: string, body: any) => Response;
  patchProgram?: (id: string, body: any) => Response;
  connectStatus?: () => Response;
  connectStart?: (body: any) => Response;
  communities?: () => Response;
  earnings?: () => Response;
};

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/marketplace/communities")) {
        return routes.communities ? routes.communities() : json(200, { communities: [] });
      }
      if (u.includes("/marketplace/community/")) {
        const code = decodeURIComponent(u.split("/marketplace/community/")[1]);
        return routes.community ? routes.community(code) : json(404, { error: "not found", code: "COMMUNITY_NOT_FOUND" });
      }
      if (method === "GET" && u.endsWith("/v1/attribution/connect/status")) {
        return routes.connectStatus ? routes.connectStatus() : json(200, { connected: false, payouts_enabled: false, details_submitted: false });
      }
      if (method === "POST" && u.endsWith("/v1/attribution/connect")) {
        return routes.connectStart ? routes.connectStart(init?.body ? JSON.parse(init.body) : {}) : json(201, { account_id: "acct_x", onboarding_url: "https://connect.stripe.test/x", existing: false });
      }
      if (method === "PATCH" && u.includes("/v1/attribution/programs/")) {
        const id = decodeURIComponent(u.split("/v1/attribution/programs/")[1]);
        return routes.patchProgram ? routes.patchProgram(id, init?.body ? JSON.parse(init.body) : undefined) : json(200, { program: { id } });
      }
      if (method === "POST" && u.endsWith("/v1/attribution/redeem")) {
        return routes.redeem ? routes.redeem() : json(200, {});
      }
      if (method === "GET" && u.endsWith("/v1/attribution/me")) {
        return routes.me ? routes.me() : json(200, { community: null });
      }
      // Owner shelf: /v1/attribution/programs/:id/picks — checked before the plain
      // programs list because the list path is a prefix of it.
      if (u.includes("/v1/attribution/programs/") && u.endsWith("/picks")) {
        const id = decodeURIComponent(u.split("/v1/attribution/programs/")[1].replace(/\/picks$/, ""));
        if (method === "PUT") {
          const body = init?.body ? JSON.parse(init.body) : undefined;
          return routes.putPicks ? routes.putPicks(id, body) : json(200, { picks: [], count: 0 });
        }
        return routes.getPicks ? routes.getPicks(id) : json(200, { picks: [], max_picks: 15 });
      }
      if (method === "GET" && u.endsWith("/v1/attribution/earnings")) {
        return routes.earnings ? routes.earnings() : json(200, {});
      }
      if (method === "GET" && u.endsWith("/v1/attribution/programs")) {
        return routes.programs ? routes.programs() : json(200, { programs: [] });
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
        program_status: "active", attributed_at: "2026-07-01T00:00:00Z",
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

describe("firestarter_my_markets (owner list)", () => {
  it("lists owned markets with id, url, share code, share % and members", async () => {
    routes.programs = () => json(200, {
      programs: [
        { id: "apg_1", display_name: "Analog", slug: "analog", status: "active", override_bps: 1500, type: "community", member_count: 12, links: [{ code: "ABCD123456" }] },
        { id: "apg_2", display_name: null, slug: null, status: "paused", override_bps: 0, type: "community", member_count: 0, links: [] },
      ],
    });
    const t = textOf(await captureTools()["firestarter_my_markets"]({}));
    expect(t).toContain("apg_1");
    expect(t).toContain("/m/analog");
    expect(t).toContain("ABCD123456");
    expect(t).toContain("15.00%");
    expect(t).toContain("Members: 12");
    expect(t).toContain("(unnamed market)"); // apg_2 has no display_name
  });

  it("says so when the owner has no markets", async () => {
    routes.programs = () => json(200, { programs: [] });
    const t = textOf(await captureTools()["firestarter_my_markets"]({}));
    expect(t).toContain("don't own any markets");
  });
});

describe("firestarter_set_market_picks (owner curation)", () => {
  it("replace: sends the exact picks and shows the resulting shelf", async () => {
    let putBody: any = null;
    routes.putPicks = (_id, body) => {
      putBody = body;
      return json(200, {
        count: 2,
        picks: [
          { listing_id: "lst_a", product_name: "Cool Sticker", price: 3, note: "love it" },
          { listing_id: "lst_b", product_name: "Neat Mug", price: 12.5, note: null },
        ],
      });
    };
    const t = textOf(await captureTools()["firestarter_set_market_picks"]({
      program_id: "apg_1",
      picks: [{ listing_id: "lst_a", note: "love it" }, { listing_id: "lst_b" }],
    }));
    expect(putBody.picks).toEqual([
      { listing_id: "lst_a", note: "love it" },
      { listing_id: "lst_b", note: null },
    ]);
    expect(t).toContain("Shelf updated");
    expect(t).toContain("Cool Sticker");
    expect(t).toContain("$12.50");
  });

  it("add: merges the new picks onto the current shelf before replacing", async () => {
    routes.getPicks = () => json(200, { picks: [{ listing_id: "lst_existing", note: "keep" }], max_picks: 15 });
    let putBody: any = null;
    routes.putPicks = (_id, body) => {
      putBody = body;
      return json(200, { count: body.picks.length, picks: body.picks.map((p: any, i: number) => ({ listing_id: p.listing_id, product_name: `P${i}`, price: 1, note: p.note })) });
    };
    await captureTools()["firestarter_set_market_picks"]({ program_id: "apg_1", action: "add", picks: [{ listing_id: "lst_new", note: "new" }] });
    expect(putBody.picks).toEqual([
      { listing_id: "lst_existing", note: "keep" },
      { listing_id: "lst_new", note: "new" },
    ]);
  });

  it("remove: drops the given ids from the current shelf", async () => {
    routes.getPicks = () => json(200, { picks: [{ listing_id: "lst_a", note: "a" }, { listing_id: "lst_b", note: "b" }], max_picks: 15 });
    let putBody: any = null;
    routes.putPicks = (_id, body) => {
      putBody = body;
      return json(200, { count: body.picks.length, picks: body.picks.map((p: any) => ({ listing_id: p.listing_id, product_name: "X", price: 1, note: p.note })) });
    };
    await captureTools()["firestarter_set_market_picks"]({ program_id: "apg_1", action: "remove", picks: [{ listing_id: "lst_a" }] });
    expect(putBody.picks).toEqual([{ listing_id: "lst_b", note: "b" }]);
  });

  it("reports a cleared shelf when the last pick is removed", async () => {
    routes.getPicks = () => json(200, { picks: [{ listing_id: "lst_a", note: null }], max_picks: 15 });
    routes.putPicks = () => json(200, { count: 0, picks: [] });
    const t = textOf(await captureTools()["firestarter_set_market_picks"]({ program_id: "apg_1", action: "remove", picks: [{ listing_id: "lst_a" }] }));
    expect(t).toContain("Shelf cleared");
  });

  it("explains clearly when a pick is the owner's own listing", async () => {
    routes.putPicks = () => json(400, { error: "Your own listings already appear under what you sell: lst_x", code: "OWN_LISTING_PICK" });
    const res = await captureTools()["firestarter_set_market_picks"]({ program_id: "apg_1", picks: [{ listing_id: "lst_x" }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("your OWN listings");
  });
});

describe("firestarter_update_market (owner identity)", () => {
  it("updates display_name/tagline/discoverable and reflects the result", async () => {
    let patchBody: any = null;
    routes.patchProgram = (_id, body) => { patchBody = body; return json(200, { program: { id: "apg_1", display_name: "Analog", tagline: "makers", discoverable: false } }); };
    const t = textOf(await captureTools()["firestarter_update_market"]({ program_id: "apg_1", display_name: "Analog", tagline: "makers", discoverable: false }));
    expect(patchBody).toEqual({ display_name: "Analog", tagline: "makers", discoverable: false });
    expect(t).toContain("Market updated");
    expect(t).toContain("Analog");
    expect(t).toContain("hidden from Discover");
  });

  it("clears a field when passed an empty string", async () => {
    let patchBody: any = null;
    routes.patchProgram = (_id, body) => { patchBody = body; return json(200, { program: { id: "apg_1", tagline: null } }); };
    const t = textOf(await captureTools()["firestarter_update_market"]({ program_id: "apg_1", tagline: "" }));
    expect(patchBody).toEqual({ tagline: null });
    expect(t).toContain("(cleared)");
  });

  it("errors when no field is provided", async () => {
    const res = await captureTools()["firestarter_update_market"]({ program_id: "apg_1" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Nothing to update");
  });
});

describe("firestarter_connect_payouts (owner Stripe)", () => {
  it("returns a Stripe onboarding link when not yet set up", async () => {
    routes.connectStatus = () => json(200, { connected: false, payouts_enabled: false, details_submitted: false });
    routes.connectStart = () => json(201, { account_id: "acct_1", onboarding_url: "https://connect.stripe.test/onboard", existing: false });
    const t = textOf(await captureTools()["firestarter_connect_payouts"]({}));
    expect(t).toContain("Set up payouts");
    expect(t).toContain("https://connect.stripe.test/onboard");
  });

  it("reports when payouts are already enabled and does NOT start onboarding", async () => {
    routes.connectStatus = () => json(200, { connected: true, payouts_enabled: true, details_submitted: true });
    let started = false;
    routes.connectStart = () => { started = true; return json(200, {}); };
    const t = textOf(await captureTools()["firestarter_connect_payouts"]({}));
    expect(t).toContain("already set up");
    expect(started).toBe(false);
  });

  it("forwards a normalized country code", async () => {
    routes.connectStatus = () => json(200, { connected: false, payouts_enabled: false });
    let body: any = null;
    routes.connectStart = (b) => { body = b; return json(201, { onboarding_url: "https://x", existing: false }); };
    await captureTools()["firestarter_connect_payouts"]({ country: "gb" });
    expect(body).toEqual({ country: "GB" });
  });
});

describe("firestarter_discover_markets (buyer discovery)", () => {
  it("lists public markets with URL, join code and proof", async () => {
    routes.communities = () => json(200, {
      communities: [
        { name: "Analog", slug: "analog", code: "ABCD123456", tagline: "makers", member_count_bucket: "10-49", order_count_bucket: "1-9" },
        { name: "Solo", slug: null, code: "WXYZ987654", tagline: null, member_count_bucket: "0", order_count_bucket: "0" },
      ],
    });
    const t = textOf(await captureTools()["firestarter_discover_markets"]({}));
    expect(t).toContain("Analog");
    expect(t).toContain("makers");
    expect(t).toContain("/m/analog");
    expect(t).toContain("ABCD123456");
    expect(t).toContain("10-49 members");
    expect(t).toContain("firestarter_join_market");
  });

  it("handles an empty discover list", async () => {
    routes.communities = () => json(200, { communities: [] });
    const t = textOf(await captureTools()["firestarter_discover_markets"]({}));
    expect(t).toContain("No public community markets");
  });
});

describe("firestarter_market_earnings (formatted, not raw JSON)", () => {
  it("formats cents fields into a readable summary", async () => {
    routes.earnings = () => json(200, {
      programs: 2, transactions: 7,
      pending_cents: 1234, released_cents: 5000,
      available_cents: 4200, in_clearing_cents: 800,
      awaiting_connect_cents: 1234, reversed_cents: 300,
    });
    const t = textOf(await captureTools()["firestarter_market_earnings"]({}));
    expect(t).not.toContain("```json"); // no raw dump
    expect(t).toContain("across 2 markets");
    expect(t).toContain("$62.34"); // lifetime = pending 12.34 + released 50.00
    expect(t).toContain("7 orders");
    expect(t).toContain("$42.00"); // available
    expect(t).toContain("firestarter_connect_payouts"); // prompted because awaiting_connect > 0
  });
});
