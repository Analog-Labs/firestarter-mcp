/**
 * Idempotency on the money path (audit 2026-08 #12/#13).
 *
 * A timed-out POST /v1/executions whose error text says "please retry" is the
 * documented double-buy vector (commerce migration 0018): the server dedupes
 * per org on the Idempotency-Key header, but only if the client sends one —
 * and the key must be STABLE across the agent's retry of the same intent, or
 * it dedupes nothing. firestarter_approve needs no key: the server's atomic
 * awaiting_approval→paying claim already makes repeat approves a clean 409.
 *
 * Also pins that key generation uses node:crypto imports, not the `crypto`
 * global — the global does not exist on Node 18, which engines allows.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

function captureTool(name: string): (args: any) => Promise<any> {
  let handler: ((args: any) => Promise<any>) | null = null;
  const stub = {
    tool: (toolName: string, ...rest: any[]) => {
      if (toolName === name) handler = rest.filter((a) => typeof a === "function").pop() ?? null;
    },
  } as any;
  registerTools(stub, "fs_test_idem", "http://127.0.0.1:1");
  if (!handler) throw new Error(`tool ${name} was not registered`);
  return handler;
}

function stubFetch(body: Record<string, unknown>) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The Idempotency-Key header sent on the POST /v1/executions call, or null. */
function executeKeyFrom(mock: ReturnType<typeof vi.fn>): string | null {
  const call = mock.mock.calls.find(
    ([url, init]: any[]) => String(url).endsWith("/v1/executions") && init?.method === "POST",
  ) as any[] | undefined;
  if (!call) throw new Error("no POST /v1/executions was made");
  return call[1]?.headers?.["Idempotency-Key"] ?? null;
}

const EXEC_RESPONSE = {
  id: "exec_idem_1", status: "completed", request_text: "mug",
  options: [], steps: [], default_delivery: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("firestarter_execute idempotency", () => {
  it("sends an Idempotency-Key on execution creation, within the server's 255-char cap", async () => {
    const mock = stubFetch(EXEC_RESPONSE);
    await captureTool("firestarter_execute")({ request: "specialty coffee beans" });
    const key = executeKeyFrom(mock);
    expect(key).toBeTruthy();
    expect(key!.length).toBeLessThanOrEqual(255);
  });

  it("the key is stable across an immediate retry of the same intent", async () => {
    // Pin mid-bucket so the time-bucketed key cannot straddle a boundary.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-20T12:05:00.000Z"));
    const first = stubFetch(EXEC_RESPONSE);
    await captureTool("firestarter_execute")({ request: "specialty coffee beans" });
    const k1 = executeKeyFrom(first);

    const second = stubFetch(EXEC_RESPONSE);
    await captureTool("firestarter_execute")({ request: "specialty coffee beans" });
    const k2 = executeKeyFrom(second);

    expect(k1).toBe(k2);
  });

  it("a different intent mints a different key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-20T12:05:00.000Z"));
    const first = stubFetch(EXEC_RESPONSE);
    await captureTool("firestarter_execute")({ request: "specialty coffee beans" });
    const k1 = executeKeyFrom(first);

    const second = stubFetch(EXEC_RESPONSE);
    await captureTool("firestarter_execute")({ request: "a red stand mixer" });
    const k2 = executeKeyFrom(second);

    expect(k1).not.toBe(k2);
  });
});

describe("withdraw_wallet key generation (audit #13)", () => {
  it("works without the `crypto` global (absent on Node 18)", async () => {
    const mock = stubFetch({ balance_cents: 400 });
    vi.stubGlobal("crypto", undefined);
    const out = await captureTool("firestarter_withdraw_wallet")({ amount_cents: 100 });
    const text = out.content.map((c: any) => c.text).join("\n");
    expect(text).toContain("Withdrew");
    const call = mock.mock.calls.find(([u]: any[]) => String(u).endsWith("/v1/drops/wallet/withdraw")) as any[];
    expect(call[1].headers["Idempotency-Key"]).toBeTruthy();
  });
});
