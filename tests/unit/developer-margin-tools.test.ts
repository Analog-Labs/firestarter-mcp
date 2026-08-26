/**
 * commerce#977 — "Cannot set/update developer margin on existing Firestarter
 * account via Claude".
 *
 * The API has had the whole surface since D1: GET/PATCH /v1/developer/margin
 * (org-scoped, hard-capped at MAX_MARGIN_BPS = 1000 = 10%) plus
 * GET /v1/developer/earnings. No MCP tool ever reached any of it — 87 tools and
 * not one touching /v1/developer.
 *
 * So an agent asked to "set a developer margin of 10%" found nothing that fit
 * and reached for the nearest-looking thing, firestarter_create_market's
 * `share_bps`. That is a DIFFERENT mechanism — a share of Firestarter's platform
 * fee paid to a community/affiliate program — not a markup added on top of the
 * item total and paid to the integrating org. Reporting "not supported" was the
 * correct read of the tools available; the tools were the gap.
 *
 * These cover the agent-facing half: the percent -> bps conversion (the API
 * speaks bps, users say "10%"), the cap, and a read that does not lie about
 * money when the payout account is missing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatDeveloperMargin, registerTools } from "../../src/mcp/tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const cfg = (over: Record<string, unknown> = {}) => ({
  margin_bps: 0,
  max_margin_bps: 1000,
  max_margin_cents_per_transaction: 5000,
  payout_account_connected: false,
  ...over,
});

const earnings = (over: Record<string, unknown> = {}) => ({
  pending_cents: 0,
  released_cents: 0,
  refunded_cents: 0,
  transactions: 0,
  ...over,
});

describe("formatDeveloperMargin", () => {
  it("renders bps as the percentage the user actually asked for", () => {
    const text = formatDeveloperMargin(cfg({ margin_bps: 1000 }), earnings());
    expect(text).toContain("10%");
    // The raw unit too — the API and the issue both speak bps.
    expect(text).toContain("1000");
  });

  it("says a margin is OFF rather than printing a bare 0%", () => {
    const text = formatDeveloperMargin(cfg({ margin_bps: 0 }), earnings());
    expect(text).toMatch(/no (developer )?margin|not set|off/i);
  });

  it("names the ceiling, so a request for 25% has an answer before it is tried", () => {
    const text = formatDeveloperMargin(cfg({ margin_bps: 250 }), earnings());
    expect(text).toContain("2.5%");
    expect(text).toMatch(/10%/); // max_margin_bps
    expect(text).toMatch(/\$50/); // per-transaction cap
  });

  it("warns that earnings cannot move without a connected payout account", () => {
    const text = formatDeveloperMargin(
      cfg({ margin_bps: 500, payout_account_connected: false }),
      earnings({ pending_cents: 2500, transactions: 4 })
    );
    expect(text).toMatch(/payout|connect/i);
    expect(text).toContain("$25.00");
  });

  it("drops the warning once payouts are connected", () => {
    const text = formatDeveloperMargin(
      cfg({ margin_bps: 500, payout_account_connected: true }),
      earnings({ released_cents: 9900, transactions: 12 })
    );
    expect(text).not.toMatch(/cannot be (transferred|paid)/i);
    expect(text).toContain("$99.00");
  });

  it("survives an earnings call that failed, rather than reporting $0 earned", () => {
    // A wrong number is worse than a missing one on a money read — the same
    // rule the spend-cap tool follows for month-to-date spend.
    const text = formatDeveloperMargin(cfg({ margin_bps: 1000 }), null);
    expect(text).toContain("10%");
    expect(text).not.toContain("$0.00");
  });
});

describe("firestarter_developer_margin (read)", () => {
  function captureTool(name: string): (args: any) => Promise<any> {
    let handler: ((args: any) => Promise<any>) | null = null;
    const stub = {
      tool: (toolName: string, _desc: string, _schema: any, _ann: any, cb: any) => {
        if (toolName === name) handler = cb;
      },
    } as any;
    registerTools(stub, "fs_test_devmargin", "http://api.local");
    if (!handler) throw new Error(`tool ${name} was not registered`);
    return handler;
  }

  it("still reports the margin when the earnings call fails", async () => {
    // Two endpoints, one of them optional. A 500 on earnings must not sink the
    // read — and must not silently become "$0.00 earned".
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (String(url).includes("/earnings")) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ margin_bps: 1000, max_margin_bps: 1000, max_margin_cents_per_transaction: 5000, payout_account_connected: true }),
      };
    }));

    const res = await captureTool("firestarter_developer_margin")({});
    const text = res.content.map((b: any) => b.text ?? "").join("\n");
    expect(res.isError).toBeFalsy();
    expect(text).toContain("10%");
    expect(text).not.toContain("Earned so far");
  });

  it("never writes, even when handed the setter's argument", async () => {
    const spy = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ margin_bps: 0, max_margin_bps: 1000, max_margin_cents_per_transaction: 5000, payout_account_connected: false }),
    }));
    vi.stubGlobal("fetch", spy);

    const res = await captureTool("firestarter_developer_margin")({ margin_percent: 10 });
    expect(spy.mock.calls.every(([, init]: any) => (init?.method ?? "GET") === "GET")).toBe(true);
    // And it says so, rather than leaving the agent to believe it applied.
    const text = res.content.map((b: any) => b.text ?? "").join("\n");
    expect(text).toMatch(/firestarter_set_developer_margin/);
  });
});

describe("firestarter_set_developer_margin", () => {
  function captureTool(name: string): (args: any) => Promise<any> {
    let handler: ((args: any) => Promise<any>) | null = null;
    const stub = {
      tool: (toolName: string, _desc: string, _schema: any, _ann: any, cb: any) => {
        if (toolName === name) handler = cb;
      },
    } as any;
    registerTools(stub, "fs_test_devmargin", "http://api.local");
    if (!handler) throw new Error(`tool ${name} was not registered`);
    return handler;
  }

  function stubFetch(body: any, ok = true, status = 200) {
    const spy = vi.fn(async () => ({ ok, status, json: async () => body }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("converts the percentage a user says into the basis points the API takes", async () => {
    const spy = stubFetch({ margin_bps: 1000, per_transaction_cap_cents: 5000 });
    const res = await captureTool("firestarter_set_developer_margin")({ margin_percent: 10 });

    const patch = spy.mock.calls.find(([, init]: any) => init?.method === "PATCH");
    expect(patch, "expected a PATCH to the margin endpoint").toBeTruthy();
    expect(String(patch![0])).toContain("/v1/developer/margin");
    expect(JSON.parse((patch![1] as any).body)).toEqual({ margin_bps: 1000 });
    expect(res.isError).toBeFalsy();
  });

  it("handles a fractional percentage without emitting a non-integer bps", async () => {
    const spy = stubFetch({ margin_bps: 250 });
    await captureTool("firestarter_set_developer_margin")({ margin_percent: 2.5 });

    const patch = spy.mock.calls.find(([, init]: any) => init?.method === "PATCH");
    const sent = JSON.parse((patch![1] as any).body).margin_bps;
    expect(Number.isInteger(sent)).toBe(true);
    expect(sent).toBe(250);
  });

  it("refuses above the 10% ceiling without spending a request on it", async () => {
    const spy = stubFetch({});
    const res = await captureTool("firestarter_set_developer_margin")({ margin_percent: 25 });

    expect(res.isError).toBe(true);
    const text = res.content.map((b: any) => b.text ?? "").join("\n");
    expect(text).toContain("10%");
    // Nothing sent: the cap is knowable client-side, so a rejected request is
    // just a slower way to say the same thing.
    expect(spy.mock.calls.some(([, init]: any) => init?.method === "PATCH")).toBe(false);
  });

  it("refuses a negative margin", async () => {
    const spy = stubFetch({});
    const res = await captureTool("firestarter_set_developer_margin")({ margin_percent: -1 });
    expect(res.isError).toBe(true);
    expect(spy.mock.calls.some(([, init]: any) => init?.method === "PATCH")).toBe(false);
  });

  it("accepts 0 as a real value — that is how a margin is turned off", async () => {
    const spy = stubFetch({ margin_bps: 0 });
    const res = await captureTool("firestarter_set_developer_margin")({ margin_percent: 0 });

    expect(res.isError).toBeFalsy();
    const patch = spy.mock.calls.find(([, init]: any) => init?.method === "PATCH");
    expect(JSON.parse((patch![1] as any).body)).toEqual({ margin_bps: 0 });
    const text = res.content.map((b: any) => b.text ?? "").join("\n");
    expect(text).toMatch(/off|removed|no margin|0%/i);
  });

  it("says the margin applies to future purchases only", async () => {
    stubFetch({ margin_bps: 1000 });
    const res = await captureTool("firestarter_set_developer_margin")({ margin_percent: 10 });
    const text = res.content.map((b: any) => b.text ?? "").join("\n");
    // Existing escrow holds carry the margin frozen at pay time; a change here
    // cannot reach them, and an agent must not imply it does.
    expect(text).toMatch(/from now on|future|going forward|new purchase/i);
  });
});
