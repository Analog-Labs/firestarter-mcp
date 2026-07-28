/**
 * Agentic self-serve "markets" via MCP (community attribution).
 *
 * Any AI agent (Cole, Claude, Cursor, a community's own bot) can stand up an
 * attribution program, mint a share code, read earnings, and join a market —
 * by calling these tools, no dashboard. Gated behind ATTRIBUTION_SELF_SERVE_ENABLED.
 *
 * Mirrors the mcp-buyer-confirmation harness: drive the REAL registered tool
 * handlers (captured via a fake McpServer) against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function staticManifestTool(name: string): any {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "src", "mcp", "mcp.json"), "utf8"));
  const tool = manifest.tools.find((t: any) => t.name === name);
  expect(tool, `missing static MCP manifest tool ${name}`).toBeTruthy();
  return tool;
}

let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  process.env.ATTRIBUTION_SELF_SERVE_ENABLED = "true";
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ATTRIBUTION_SELF_SERVE_ENABLED;
  else process.env.ATTRIBUTION_SELF_SERVE_ENABLED = savedFlag;
  vi.unstubAllGlobals();
});

describe("agentic attribution MCP tools (self-serve markets)", () => {
  it("are registered even when ATTRIBUTION_SELF_SERVE_ENABLED is off (community markets are always on)", () => {
    // "feat(mcp): enable community markets" un-gated these tools: they now
    // register regardless of the flag and are advertised in the manifest.
    // (Payouts still stage behind ATTRIBUTION_PROGRAMS_ENABLED.)
    process.env.ATTRIBUTION_SELF_SERVE_ENABLED = "false";
    const tools = captureTools();
    expect(typeof tools.firestarter_create_market).toBe("function");
    expect(typeof tools.firestarter_market_link).toBe("function");
    expect(typeof tools.firestarter_join_market).toBe("function");
  });

  it("are registered when the flag is on", () => {
    const tools = captureTools();
    expect(typeof tools.firestarter_create_market).toBe("function");
    expect(typeof tools.firestarter_market_link).toBe("function");
    expect(typeof tools.firestarter_market_earnings).toBe("function");
    expect(typeof tools.firestarter_join_market).toBe("function");
  });

  it("static MCP manifest advertises community display names", () => {
    const createProps = staticManifestTool("firestarter_create_market").inputSchema.properties;
    expect(createProps.display_name).toMatchObject({ type: "string", maxLength: 60 });

    const joinProps = staticManifestTool("firestarter_join_market").inputSchema.properties;
    expect(joinProps.force).toBeUndefined();
  });

  it("firestarter_create_market POSTs the program and surfaces the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/attribution/programs");
      const body = JSON.parse(init.body);
      expect(body.override_bps).toBe(5000);
      expect(body.type).toBe("community");
      expect(body.display_name).toBe("Analog");
      return new Response(
        JSON.stringify({ program: { id: "apg_x", override_bps: 2000, display_name: "Analog" }, max_self_serve_bps: 2000, override_bps_capped: true }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }));
    const text = textOf(await captureTools().firestarter_create_market({ share_bps: 5000, display_name: "Analog" }));
    expect(text).toContain("apg_x");
    expect(text).toContain("Analog");
    expect(text).toContain("20.00%"); // effective 2000 bps after the cap
    expect(text).toContain("capped");
    expect(text).toContain("firestarter_market_link"); // points the agent to the next step
  });

  it("firestarter_market_link returns the share code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/attribution/links");
      expect(JSON.parse(init.body).program_id).toBe("apg_x");
      return new Response(JSON.stringify({ link: { code: "ABCD1234" } }), { status: 201, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_market_link({ program_id: "apg_x", channel: "discord" }));
    expect(text).toContain("ABCD1234");
  });

  it("static MCP manifest advertises the vanity handle on create + the set-handle tool", () => {
    const createProps = staticManifestTool("firestarter_create_market").inputSchema.properties;
    expect(createProps.handle).toMatchObject({ type: "string" });

    const setHandle = staticManifestTool("firestarter_set_market_handle");
    expect(setHandle.inputSchema.required.sort()).toEqual(["handle", "program_id"]);
  });

  it("firestarter_create_market claims a handle and surfaces the vanity URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/attribution/programs");
      expect(JSON.parse(init.body).slug).toBe("analog");
      return new Response(
        JSON.stringify({ program: { id: "apg_x", override_bps: 1000, slug: "analog" }, override_bps_capped: false }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }));
    const text = textOf(await captureTools().firestarter_create_market({ share_bps: 1000, handle: "analog" }));
    expect(text).toContain("firestarter.network/m/analog");
  });

  it("firestarter_create_market accepts a mixed-case handle and normalizes it to lowercase (matches the server)", async () => {
    // The server lowercases before validating, so 'Analog' is valid there; the
    // tool must not reject it client-side. It is sent as 'analog'.
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(JSON.parse(init.body).slug).toBe("analog");
      return new Response(
        JSON.stringify({ program: { id: "apg_x", override_bps: 1000, slug: "analog" }, override_bps_capped: false }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }));
    const text = textOf(await captureTools().firestarter_create_market({ share_bps: 1000, handle: "Analog" }));
    expect(text).toContain("firestarter.network/m/analog");
  });

  it("firestarter_create_market reports a taken handle without creating the market", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "That handle is already in use", code: "SLUG_TAKEN" }), { status: 409, headers: { "Content-Type": "application/json" } }),
    ));
    const res = await captureTools().firestarter_create_market({ share_bps: 1000, handle: "analog" });
    expect(textOf(res)).toContain("already taken");
    expect(textOf(res)).toContain("not created");
    expect(res.isError).toBe(true);
  });

  it("firestarter_set_market_handle PATCHes the slug and surfaces the vanity URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/attribution/programs/apg_x");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body).slug).toBe("analog");
      return new Response(JSON.stringify({ program: { id: "apg_x", slug: "analog" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_set_market_handle({ program_id: "apg_x", handle: "analog" }));
    expect(text).toContain("firestarter.network/m/analog");
  });

  it("firestarter_set_market_handle reports a taken handle as a clear, actionable error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "That handle is already in use", code: "SLUG_TAKEN" }), { status: 409, headers: { "Content-Type": "application/json" } }),
    ));
    const res = await captureTools().firestarter_set_market_handle({ program_id: "apg_x", handle: "analog" });
    expect(textOf(res)).toContain("already taken");
    expect(res.isError).toBe(true);
  });

  it("firestarter_join_market redeems a code (first-touch)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        expect(JSON.parse(init.body)).toMatchObject({ code: "ABCD1234" });
        return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(String(url)).toContain("/marketplace/community/ABCD1234");
      return new Response(JSON.stringify({
        community: {
          name: "Analog Builders",
          tagline: "Tools chosen by people building agent commerce.",
          top_categories: ["Developer tools"],
          picks: [{ listing_id: "lst_builder_1", product_name: "Agent Toolkit", price: 49, image: null, note: null }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_join_market({ code: "ABCD1234" }));
    expect(text).toContain("Joined the market");
    expect(text).toContain("Welcome to Analog Builders");
    expect(text).toContain("lst_builder_1");
    expect(text).toContain("firestarter_execute");
  });

  it("firestarter_join_market suggests categories when the community has no curated picks", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        community: { name: "Analog Builders", top_categories: ["Developer tools", "Office"], picks: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const text = textOf(await captureTools().firestarter_join_market({ code: "ABCD1234" }));
    expect(text).toContain("Joined the market");
    expect(text).toContain("Popular here: Developer tools, Office");
    expect(text).toMatch(/search this market/i);
  });

  it("firestarter_join_market keeps a completed join successful when onboarding enrichment fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("community page unavailable");
    }));

    const result = await captureTools().firestarter_join_market({ code: "ABCD1234" });
    expect(textOf(result)).toContain("Joined the market");
    expect(result.isError).toBeUndefined();
  });

  it("firestarter_join_market reports a switch when it replaces an existing binding", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        expect(JSON.parse(init.body)).toMatchObject({ code: "WXYZ" });
        return new Response(JSON.stringify({ ok: true, replaced: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ community: { name: "New Market", top_categories: [], picks: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_join_market({ code: "WXYZ" }));
    expect(text).toContain("Switched");
    expect(text).not.toMatch(/lock/i);
  });

  it("firestarter_my_market shows the current connection (GET /me)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      expect(String(url)).toContain("/v1/attribution/me");
      return new Response(JSON.stringify({
        community: { connected: true, name: "Dom's Discord", code: "ABCD1234", program_status: "active", attributed_at: "2026-07-03T00:00:00Z" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_my_market({}));
    expect(text).toContain("Dom's Discord");
    expect(text).toContain("ABCD1234");
    expect(text).not.toMatch(/lock/i);
  });

  it("firestarter_my_market reports when not connected to any market", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ community: null }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    const text = textOf(await captureTools().firestarter_my_market({}));
    expect(text).toContain("not connected to any community market");
  });

  it("firestarter_leave_market disconnects the active binding (POST /disconnect)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      expect(String(url)).toContain("/v1/attribution/disconnect");
      return new Response(JSON.stringify({ ok: true, disconnected: true, program_id: "prog_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_leave_market({}));
    expect(text).toContain("Left the market");
  });

  it("firestarter_leave_market is a no-op when nothing was connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, disconnected: false, program_id: null }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    const text = textOf(await captureTools().firestarter_leave_market({}));
    expect(text).toContain("weren't connected");
  });

  it("firestarter_join_market annotates a pick that has a live drop", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        community: {
          name: "Analog Builders",
          tiers: { enabled: true, meaningful: false, ladder: [] },
          picks: [
            { listing_id: "lst_open", product_name: "Aeropress Go", price: 39.99, image: null, note: "daily driver", min_tier: 0,
              drops: [{ id: "d1", listing_id: "lst_open", discount_cents: 1000, remaining: 3, min_tier: 0, in_priority_window: false, priority_until: null }] },
            { listing_id: "lst_gated", product_name: "Timemore grinder", price: 68, image: null, note: null, min_tier: 0,
              drops: [{ id: "d2", listing_id: "lst_gated", discount_cents: 1500, remaining: 8, min_tier: 2, in_priority_window: true, priority_until: "2026-08-01T00:00:00Z" }] },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_join_market({ code: "ABCD1234" }));
    expect(text).toContain("🔥 $10.00 off · 3 slots left — claim before checkout");
    expect(text).toContain("🔥 $15.00 off · early access for tier 2+");
  });

  it("firestarter_join_market renders tiers + social proof when meaningful", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        community: {
          name: "Analog Builders", tagline: "Tools for builders.",
          picks: [{ listing_id: "lst_1", product_name: "Toolkit", price: 49, image: null, note: null, min_tier: 0 }],
          tiers: { enabled: true, meaningful: true, ladder: [{ name: "Member", min_orders: 0 }, { name: "Insider", min_orders: 5 }] },
          member_count_bucket: "50+", order_count_bucket: "10-49", active_since: "2025-11",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_join_market({ code: "ABCD1234" }));
    expect(text).toContain("Member tiers — earn early access:");
    expect(text).toContain("Insider (5 orders)");
    expect(text).toContain("50+ members · 10-49 orders driven · active since 2025-11");
    expect(text).not.toContain("you're here"); // pre-membership: no rung marker
  });

  it("firestarter_join_market hides the tier ladder when tiers are disabled and skips 0 buckets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/v1/attribution/redeem")) {
        return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        community: {
          name: "Quiet Co", picks: [{ listing_id: "lst_1", product_name: "P", price: 9, image: null, note: null, min_tier: 0 }],
          tiers: { enabled: false, meaningful: false, ladder: [{ name: "Member", min_orders: 0 }, { name: "Regular", min_orders: 2 }] },
          member_count_bucket: "0", order_count_bucket: "0", active_since: null,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_join_market({ code: "ABCD1234" }));
    expect(text).not.toContain("Member tiers");
    expect(text).not.toContain("0 members");
  });

  it("firestarter_market_preview shows the offers block before joining", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        community: {
          name: "Analog Builders", tagline: "Tools for builders.", active: true,
          picks: [{ listing_id: "lst_1", product_name: "Toolkit", price: 49, image: null, note: null, min_tier: 0,
            drops: [{ id: "d1", listing_id: "lst_1", discount_cents: 1000, remaining: 3, min_tier: 0, in_priority_window: false, priority_until: null }] }],
          tiers: { enabled: true, meaningful: true, ladder: [{ name: "Member", min_orders: 0 }, { name: "Insider", min_orders: 5 }] },
          member_count_bucket: "50+", order_count_bucket: "10-49", active_since: "2025-11",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    const text = textOf(await captureTools().firestarter_market_preview({ code: "ABCD1234" }));
    expect(text).toContain("Member tiers — earn early access:");
    expect(text).toContain("🔥 $10.00 off · 3 slots left — claim before checkout");
    expect(text).toContain("50+ members");
    expect(text).not.toContain("you're here");
  });

  it("firestarter_my_market marks the member's current rung on the ladder", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      const s = String(url);
      const json = (data: any) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (s.includes("/v1/attribution/me")) {
        return json({ community: { connected: true, name: "Analog", code: "ABCD1234", program_status: "active", attributed_at: "2026-07-03T00:00:00Z" } });
      }
      if (s.includes("/v1/attribution/tier")) {
        return json({ tier: { index: 1, name: "Insider", qualifying_orders: 6, referral_progress: 0, next: null, ladder: [{ name: "Member", min_orders: 0 }, { name: "Insider", min_orders: 5 }] } });
      }
      if (s.includes("/marketplace/community/ABCD1234")) {
        return json({ community: {
          name: "Analog", code: "ABCD1234", picks: [],
          tiers: { enabled: true, meaningful: true, ladder: [{ name: "Member", min_orders: 0 }, { name: "Insider", min_orders: 5 }] },
          member_count_bucket: "50+", order_count_bucket: "10-49", active_since: "2025-11",
        } });
      }
      throw new Error(`unexpected fetch: ${s}`);
    }));
    const text = textOf(await captureTools().firestarter_my_market({}));
    expect(text).toContain("Insider (5 orders) — you're here");
    expect(text).toContain("50+ members");
  });
});
