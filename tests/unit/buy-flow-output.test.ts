/**
 * Output defects from the #599 buy-side audit that live in what the tools SAY,
 * not in what they do.
 */
import { describe, it, expect } from "vitest";
import { vi, afterEach } from "vitest";
import { renderDeliveryOptions, arrivalDateFromDays, registerTools } from "../../src/mcp/tools.js";

const TWO_METHODS = {
  purchasable: true,
  subtotal: 58,
  shipping_options: [
    { label: "UPSDAP Ground", price_cents: 791, delivery_days: 3 },
    { label: "USPS GroundAdvantage", price_cents: 665, delivery_days: 2 },
  ],
};

describe("delivery menu (F12)", () => {
  it("offers the numbered menu while the buyer can still approve", () => {
    const lines = renderDeliveryOptions(TWO_METHODS, null, true).join("\n");
    expect(lines).toContain("pick a speed");
    expect(lines).toContain("shipping_option_index");
    expect(lines).toContain("[0]");
  });

  it("stops inviting a re-approval once the order is paid", () => {
    // QA saw the full "pick a speed … approve with shipping_option_index" menu
    // on an order at status charging, and again at delivered. Offering a choice
    // that can no longer be made invites an agent to re-approve a completed
    // purchase — on a money path.
    const lines = renderDeliveryOptions(TWO_METHODS, null, false).join("\n");
    expect(lines, "still telling the caller to approve a paid order").not.toContain("shipping_option_index");
    expect(lines).not.toContain("pick a speed");
    // The speeds themselves stay visible — the buyer should still see what they got.
    expect(lines).toContain("USPS GroundAdvantage");
  });

  it("defaults to choosable, so existing callers are unchanged", () => {
    expect(renderDeliveryOptions(TWO_METHODS, null).join("\n")).toContain("shipping_option_index");
  });
});

describe("arrival date formatting (F15)", () => {
  it("renders a human date, never a raw ISO timestamp", () => {
    const out = arrivalDateFromDays(2, new Date("2026-08-14T00:00:00.000Z"));
    expect(out).not.toMatch(/T\d{2}:\d{2}/);
    expect(out).toMatch(/[A-Z][a-z]{2}/);
  });

  /**
   * Second review: the replacement STILL did not test the change — it asserted
   * Date.prototype.toLocaleDateString in two zones, i.e. the ECMAScript library
   * and the tz database, not product code. Reverting the fix and running the
   * whole suite under TZ=America/Los_Angeles produced zero failures.
   *
   * This drives formatExecution through firestarter_status and asserts the
   * rendered line, which is the only form that can fail when the fix is absent.
   */
  it("renders the promised date and an agreeing countdown, west of UTC", async () => {
    const realTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    // 19:00 in Los Angeles on Aug 14 — the exact scenario reported: the UTC
    // date has already rolled to Aug 15 while the buyer's calendar says Aug 14.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-15T02:00:00.000Z"));
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        id: "exec_1", status: "awaiting_approval", request_text: "mug",
        options: [{ id: "opt_1", product_title: "Mug", total: 10, currency: "usd",
                    delivery_estimate: "2026-08-16T00:00:00.000Z" }],
        steps: [],
      }), { status: 200, headers: { "content-type": "application/json" } })));

      let handler: ((a: any) => Promise<any>) | null = null;
      const stub = { tool: (n: string, ...rest: any[]) => {
        if (n === "firestarter_status") handler = rest.filter((a) => typeof a === "function").pop() ?? null;
      } } as any;
      registerTools(stub, "fs_test_tz", "http://127.0.0.1:1");
      const out = await handler!({ execution_id: "exec_1" });
      const text = out.content.map((c: any) => c.text).join("\n");

      expect(text, "rendered the day before the promised date").toContain("Aug 16");
      expect(text).not.toContain("Aug 15");
      // The countdown must agree with the date AND with the buyer's calendar.
      // Round 2 fixed the date and left this; round 3's first attempt anchored
      // "today" to UTC, which is a no-op for a UTC-midnight DATE. Asserting
      // only the date is what let both ship green.
      expect(text, "countdown disagrees with the rendered date").toMatch(/~2 days/);
    } finally {
      // `process.env.TZ = undefined` stringifies to the literal "undefined",
      // which silently pins the rest of the worker to UTC. TZ is unset by
      // default on dev machines and CI runners, so this is the common path.
      vi.useRealTimers();
      if (realTz === undefined) delete process.env.TZ;
      else process.env.TZ = realTz;
    }
  });
});

/**
 * F20 — a read-only tool that silently swallows setter-shaped arguments.
 *
 * `firestarter_spend_cap` declared `{}` as its input schema, so
 * `{ spend_cap_dollars: 50 }` was stripped by validation before the handler and
 * the caller got an ordinary read back — indistinguishable from a successful
 * write. That is how a QA pass came to report two P0 "silent no-op" regressions
 * that did not exist: the setters (firestarter_set_spend_cap /
 * firestarter_set_auto_approve_limit) were simply never called. Saying so
 * costs one line and prevents the whole misdiagnosis.
 */

function captureTool(name: string): (args: any) => Promise<any> {
  let handler: ((args: any) => Promise<any>) | null = null;
  const stub = {
    tool: (toolName: string, _d: string, _s: any, _a: any, cb: any) => {
      if (toolName === name) handler = cb;
    },
  } as any;
  registerTools(stub, "fs_test_readonly", "http://127.0.0.1:1");
  if (!handler) throw new Error(`tool ${name} was not registered`);
  return handler;
}

function stubBalance(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  })));
}
afterEach(() => vi.unstubAllGlobals());

describe("read-only tools given setter arguments (F20)", () => {
  it("spend_cap names the setter instead of returning a bare read", async () => {
    stubBalance({ spend_cap_cents: null });
    const text = (await captureTool("firestarter_spend_cap")({ spend_cap_dollars: 50 }))
      .content[0].text as string;
    expect(text).toContain("firestarter_set_spend_cap");
    expect(text.toLowerCase()).toMatch(/only reads|did not|not set|no change/);
  });

  it("auto_approve_limit does the same", async () => {
    stubBalance({ auto_approve_threshold_cents: 2000 });
    const text = (await captureTool("firestarter_auto_approve_limit")({ set_limit_usd: 25 }))
      .content[0].text as string;
    expect(text).toContain("firestarter_set_auto_approve_limit");
  });
});
