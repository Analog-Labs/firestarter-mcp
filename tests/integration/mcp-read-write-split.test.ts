/**
 * Read and write must live in separate tools.
 *
 * Anthropic's directory review rejects "a single tool that accepts both safe
 * HTTP methods (GET, HEAD, OPTIONS) and unsafe methods (POST, PUT, PATCH,
 * DELETE)", and is explicit that documenting the split inside one description
 * does not satisfy it. Two tools were dual-mode: firestarter_spend_cap
 * ("Read, raise, lower, set, or remove...") and firestarter_auto_approve_limit
 * ("Read or set..."), each branching on whether optional params were supplied.
 *
 * The reader keeps the original name so existing callers that only read are
 * unaffected; mutation moves to an explicit firestarter_set_* tool.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    {
      tool: (...args: any[]) => {
        tools[args[0] as string] = args[args.length - 1] as ToolHandler;
      },
    } as any,
    "fsk_test",
    "http://api.test",
  );
  return tools;
}

function jsonResponse(data: any): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records every request the tool makes so we can assert on the verbs used. */
function mockFetch(data: any) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      return jsonResponse(data);
    }),
  );
  return calls;
}

const UNSAFE = ["POST", "PUT", "PATCH", "DELETE"];

afterEach(() => vi.unstubAllGlobals());

describe("read/write split — spend cap", () => {
  it("firestarter_spend_cap only reads, whatever it is passed", async () => {
    const calls = mockFetch({ spend_cap_cents: 50_000, alert_threshold_pct: 80 });
    const tools = captureTools();

    // Passing the old mutation arguments must not cause a write: the reader
    // does not accept them, so a stale caller reads instead of silently
    // changing the cap.
    await tools.firestarter_spend_cap({ spend_cap_dollars: 999, disable: true });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(UNSAFE, `reader issued an unsafe ${c.method}`).not.toContain(c.method);
    }
  });

  it("firestarter_spend_cap reports the current cap", async () => {
    mockFetch({ spend_cap_cents: 50_000, alert_threshold_pct: 80 });
    const res = await captureTools().firestarter_spend_cap({});
    const text = res.content.map((b: any) => b.text).join("\n");
    expect(text).toContain("500.00");
  });

  it("firestarter_set_spend_cap writes the new cap", async () => {
    const calls = mockFetch({ ok: true });
    await captureTools().firestarter_set_spend_cap({ spend_cap_dollars: 250 });

    const write = calls.find((c) => UNSAFE.includes(c.method));
    expect(write, "no write request was issued").toBeTruthy();
    expect(write!.body.spend_cap_cents).toBe(25_000);
  });

  it("firestarter_set_spend_cap can remove the cap entirely", async () => {
    const calls = mockFetch({ ok: true });
    await captureTools().firestarter_set_spend_cap({ disable: true });

    const write = calls.find((c) => UNSAFE.includes(c.method));
    expect(write).toBeTruthy();
    expect(write!.body.spend_cap_cents).toBeNull();
  });
});

describe("read/write split — auto-approve limit", () => {
  it("firestarter_auto_approve_limit only reads", async () => {
    const calls = mockFetch({ auto_approve_threshold_cents: 10_000 });
    const tools = captureTools();

    await tools.firestarter_auto_approve_limit({ set_limit_usd: 500, disable: true });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(UNSAFE, `reader issued an unsafe ${c.method}`).not.toContain(c.method);
    }
  });

  it("distinguishes an explicit $0 limit from auto-approval being off", async () => {
    mockFetch({ auto_approve_threshold_cents: 0 });
    const res = await captureTools().firestarter_auto_approve_limit({});
    const text = res.content.map((b: any) => b.text).join("\n");
    // A buyer who deliberately set $0 must not be told the feature is OFF.
    expect(text).toContain("$0.00");
    expect(text).not.toMatch(/is OFF/);
  });

  it("firestarter_set_auto_approve_limit writes the new limit", async () => {
    const calls = mockFetch({ ok: true });
    await captureTools().firestarter_set_auto_approve_limit({ set_limit_usd: 75 });

    const write = calls.find((c) => UNSAFE.includes(c.method));
    expect(write, "no write request was issued").toBeTruthy();
    expect(JSON.stringify(write!.body)).toContain("7500");
  });

  it("firestarter_set_auto_approve_limit rejects contradictory arguments", async () => {
    mockFetch({ ok: true });
    const res = await captureTools().firestarter_set_auto_approve_limit({
      set_limit_usd: 100,
      disable: true,
    });
    expect(res.isError).toBe(true);
  });
});
