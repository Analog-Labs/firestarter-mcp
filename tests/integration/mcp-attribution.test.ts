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
});
