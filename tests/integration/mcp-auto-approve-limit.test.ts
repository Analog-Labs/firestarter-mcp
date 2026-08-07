/**
 * firestarter_auto_approve_limit (read) and firestarter_set_auto_approve_limit
 * (write) MCP tools.
 *
 * Split into a reader and a setter because Anthropic's directory review rejects
 * a single tool that both reads and mutates; the reader keeps the original name.
 *
 * Exposes the PERSISTENT account-level auto-approval limit
 * (organizations.auto_approve_threshold_cents) as a real tool, so an agent can
 * read and set it instead of fabricating a confirmation (poco-agent#208).
 *
 * Drives the REAL registered tool handler (captured via a fake McpServer)
 * against a mocked global fetch — same harness style as the other mcp-*.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    {
      // Tools may be registered with or without the optional annotations arg,
      // so the handler is always the LAST function argument.
      tool: (...args: any[]) => {
        const name = args[0] as string;
        const handler = args[args.length - 1] as ToolHandler;
        tools[name] = handler;
      },
    } as any,
    "fsk_test",
    "http://api.test",
  );
  return tools;
}

function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_auto_approve_limit MCP tool", () => {
  it("is registered", () => {
    expect(typeof captureTools().firestarter_auto_approve_limit).toBe("function");
  });

  it("with no args reads the current persisted limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/billing/balance");
      expect(init.method).toBe("GET");
      return new Response(
        JSON.stringify({ auto_approve_threshold_cents: 5000 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }));
    const text = textOf(await captureTools().firestarter_auto_approve_limit({}));
    expect(text).toContain("$50.00 per order");
  });

  it("reports OFF when the threshold is null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ auto_approve_threshold_cents: null }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    ));
    const text = textOf(await captureTools().firestarter_auto_approve_limit({}));
    expect(text).toContain("OFF");
  });

  it("distinguishes a configured $0 limit from OFF on read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ auto_approve_threshold_cents: 0 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    ));
    const text = textOf(await captureTools().firestarter_auto_approve_limit({}));
    expect(text).toContain("$0.00 per order");
    expect(text).not.toContain("OFF");
  });

  it("set_limit_usd=50 PATCHes settings with 5000 cents and confirms", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/billing/settings");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ auto_approve_threshold_cents: 5000 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = textOf(await captureTools().firestarter_set_auto_approve_limit({ set_limit_usd: 50 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toContain("$50.00 per order");
    expect(text).toContain("all future orders");
  });

  it("disable=true PATCHes a null threshold and confirms auto-approval is OFF", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/billing/settings");
      expect(JSON.parse(init.body)).toEqual({ auto_approve_threshold_cents: null });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = textOf(await captureTools().firestarter_set_auto_approve_limit({ disable: true }));
    expect(text).toContain("OFF");
  });

  it("rejects passing both set_limit_usd and disable without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await captureTools().firestarter_set_auto_approve_limit({ set_limit_usd: 50, disable: true });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a sub-cent set_limit_usd instead of silently rounding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await captureTools().firestarter_set_auto_approve_limit({ set_limit_usd: 49.999 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("whole-cent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid two-decimal set_limit_usd (49.99 -> 4999 cents)", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/billing/settings");
      expect(JSON.parse(init.body)).toEqual({ auto_approve_threshold_cents: 4999 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = textOf(await captureTools().firestarter_set_auto_approve_limit({ set_limit_usd: 49.99 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toContain("$49.99 per order");
  });
});
