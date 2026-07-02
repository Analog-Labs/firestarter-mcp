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

  it("firestarter_create_market POSTs the program and surfaces the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/attribution/programs");
      const body = JSON.parse(init.body);
      expect(body.override_bps).toBe(5000);
      expect(body.type).toBe("community");
      return new Response(
        JSON.stringify({ program: { id: "apg_x", override_bps: 2000 }, max_self_serve_bps: 2000, override_bps_capped: true }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }));
    const text = textOf(await captureTools().firestarter_create_market({ share_bps: 5000 }));
    expect(text).toContain("apg_x");
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

  it("firestarter_join_market redeems a code (first-touch)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      expect(String(url)).toContain("/v1/attribution/redeem");
      return new Response(JSON.stringify({ ok: true, created: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const text = textOf(await captureTools().firestarter_join_market({ code: "ABCD1234" }));
    expect(text).toContain("Joined the market");
  });

  it("firestarter_join_market relays a lock conflict gracefully (not an error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Attribution is locked and cannot be replaced yet", code: "ATTRIBUTION_LOCKED" }), { status: 409, headers: { "Content-Type": "application/json" } }),
    ));
    const res = await captureTools().firestarter_join_market({ code: "WXYZ" });
    expect(textOf(res)).toContain("locked");
    expect(res.isError).toBeUndefined(); // a graceful explanation, not a tool error
  });
});
