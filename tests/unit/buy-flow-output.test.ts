/**
 * Output defects from the #599 buy-side audit that live in what the tools SAY,
 * not in what they do.
 */
import { describe, it, expect } from "vitest";
import { vi, afterEach } from "vitest";
import { renderDeliveryOptions, arrivalDateFromDays, formatBuyerDate, capEnforcementLine, registerTools } from "../../src/mcp/tools.js";

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


/**
 * Round two of the same audit, after QA re-ran the plan against the sandbox.
 * Every item below is a line that was fixed in one place and left in another.
 */

describe("post-approval calls to action (F12, remainder)", () => {
  /** Drive formatExecution through firestarter_status at a given order status. */
  async function statusText(status: string): Promise<string> {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "exec_1", status, request_text: "candle",
      options: [{
        id: "opt_t37_Ib", product_title: "Soy candle", total: 28.65, currency: "usd",
        purchasable: true, subtotal: 22,
        shipping_options: [
          { label: "UPSDAP Ground", price_cents: 791, delivery_days: 3 },
          { label: "USPS GroundAdvantage", price_cents: 665, delivery_days: 2 },
        ],
        metadata: {
          drop_available_cents: 500,
          drop_available_id: "drop_8370b786eed3",
          drop_available_community: "Sunset District Makers Market",
        },
      }],
      steps: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    let handler: ((a: any) => Promise<any>) | null = null;
    const stub = { tool: (n: string, ...rest: any[]) => {
      if (n === "firestarter_status") handler = rest.filter((a) => typeof a === "function").pop() ?? null;
    } } as any;
    registerTools(stub, "fs_test_status", "http://127.0.0.1:1");
    const out = await handler!({ execution_id: "exec_1" });
    return out.content.map((c: any) => c.text).join("\n");
  }

  it("offers the approve handle and the drop claim while approval is still open", async () => {
    const text = await statusText("awaiting_approval");
    expect(text).toContain("option_id: `opt_t37_Ib`");
    expect(text).toContain("Claim it before approving");
  });

  it("withdraws both once the order is delivered", async () => {
    // QA read all of this on a DELIVERED order: an approve handle for a paid
    // purchase, and a drop banner telling them to claim "before approving".
    const text = await statusText("delivered");
    expect(text, "handed an agent an approve handle for a paid order").not.toContain("option_id:");
    expect(text, "told the buyer to claim a discount on a delivered order").not.toContain("Claim it before approving");
    // Still a record of what was bought.
    expect(text).toContain("Soy candle");
  });

  it("withdraws them at charging too, not only at delivered", async () => {
    const text = await statusText("charging");
    expect(text).not.toContain("option_id:");
    expect(text).not.toContain("Claim it before approving");
  });
});

describe("formatBuyerDate (F15, remainder)", () => {
  it("renders a receipt timestamp as a date a buyer can read", () => {
    // Was: "Date: 2026-08-17T08:31:35.292Z"
    const out = formatBuyerDate("2026-08-17T08:31:35.292Z")!;
    expect(out).not.toMatch(/T\d{2}:\d{2}/);
    expect(out).toContain("Aug 17, 2026");
  });

  it("keeps a date-only value date-only, without inventing midnight", () => {
    expect(formatBuyerDate("2026-08-18")).toBe("Tue, Aug 18, 2026");
    expect(formatBuyerDate("2026-08-18T00:00:00.000Z")).toBe("Tue, Aug 18, 2026");
  });

  it("holds the UTC date west of UTC, like the quote side already does", () => {
    const realTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(formatBuyerDate("2026-08-18")).toContain("Aug 18");
    } finally {
      if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz;
    }
  });

  it("passes an unparseable value through rather than erasing a date", () => {
    expect(formatBuyerDate("sometime next week")).toBe("sometime next week");
    expect(formatBuyerDate(null)).toBeNull();
    expect(formatBuyerDate("")).toBeNull();
  });
});

describe("spend-cap enforcement copy (P0-1, re-scoped)", () => {
  it("promises rejection on a live key", () => {
    expect(capEnforcementLine(5000, false)).toBe(
      "Purchases that would exceed $50.00 in a calendar month are automatically rejected.",
    );
  });

  it("says plainly on a test key that the cap does not apply", () => {
    // The gate skips test-mode purchases by design, so the unqualified promise
    // was false in exactly the environment QA was testing in — which is how a
    // sandbox purchase over a $1 cap got filed as a P0 enforcement failure.
    const line = capEnforcementLine(100, true);
    expect(line).toContain("TEST key");
    expect(line.toLowerCase()).toContain("not applied");
  });
});

describe("spend-cap read shows the buyer's position (P0-1, re-scoped)", () => {
  it("states month-to-date spend against the cap", async () => {
    stubBalance({ spend_cap_cents: 5000, alert_threshold_pct: 80, month_to_date_spend_cents: 2865 });
    const text = (await captureTool("firestarter_spend_cap")({})).content[0].text as string;
    expect(text).toContain("$28.65 of $50.00");
    expect(text).toContain("57%");
  });

  it("omits the position rather than printing $0.00 when the API does not send it", async () => {
    // An older API build has no such field; "used $0.00 of $50" would be a
    // wrong number on a spend limit, which is worse than a missing one.
    stubBalance({ spend_cap_cents: 5000, alert_threshold_pct: 80 });
    const text = (await captureTool("firestarter_spend_cap")({})).content[0].text as string;
    expect(text).not.toContain("Used this month");
    expect(text).toContain("Monthly spend cap: $50.00");
  });
});
