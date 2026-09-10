/**
 * commerce#1138 / commerce#1142 — say which environment the agent is really in.
 *
 * #1138: a Firestarter account connected through the Claude connector ran every
 * buy and sell in test mode while firestarter_status reported
 * "Environment: LIVE (real orders and charges)". apps/api resolves test-vs-live
 * from the api_keys ROW (routes/oauth.ts stamps it from the org's
 * default_environment); the MCP server resolved it by string-matching the
 * bearer for `fs_test_`. A connector bearer is `fs_oauth_…`, which matches
 * neither, so every OAuth sandbox session was reported LIVE.
 *
 * Three surfaces shared that signal — the status report, the receipt's
 * "TEST MODE — simulated order" banner, and the spend cap's enforcement claim —
 * so all three lied on the same sessions. The receipt is the sharp one: the
 * banner exists so a sandbox receipt cannot be screenshotted as proof of
 * payment, and it was absent on exactly the surface most buyers use.
 *
 * #1142: a sandbox listing's creation reply said `Status: active`, the agent
 * called it "listed and live", and the next turn correctly called the same
 * listing test-mode with no share link.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools, listingStatusLine } from "../../src/mcp/tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Register the tools under `bearer` and hand back one tool's handler. */
function captureTool(name: string, bearer: string): (args: any) => Promise<any> {
  let handler: ((args: any) => Promise<any>) | null = null;
  const stub = {
    tool: (toolName: string, _desc: string, _schema: any, _ann: any, cb: any) => {
      if (toolName === name) handler = cb;
    },
  } as any;
  registerTools(stub, bearer, "http://api.local");
  if (!handler) throw new Error(`tool ${name} was not registered`);
  return handler;
}

/**
 * Route by path, because these tools each make several calls and the whole
 * point of the fix is WHICH answer /v1/me gives. A path with no route throws,
 * so an unexpected call fails loudly instead of resolving to undefined.
 */
function stubRoutes(routes: Record<string, any>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace("http://api.local", "");
      const key = Object.keys(routes).find((r) => path === r || path.startsWith(`${r}?`));
      if (!key) throw new Error(`unrouted request: ${path}`);
      const body = routes[key];
      if (body instanceof Error) throw body;
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}

const text = (res: any) => res.content.map((b: any) => b.text ?? "").join("\n");

// Every test uses a distinct bearer: the resolved environment is cached per
// bearer for the life of the process, so sharing one would let an earlier
// test answer a later one.
describe("firestarter_status — environment comes from the API, not the key prefix", () => {
  it("reports TEST for a connector session the API says is test mode (#1138)", async () => {
    stubRoutes({
      "/v1/me": { org: { id: "org_1", name: "mjbjn", plan: "pro" }, user: null, environment: "test" },
      "/v1/executions": { executions: [] },
    });

    const out = text(await captureTool("firestarter_status", "fs_oauth_connector_test")({}));

    expect(out).toMatch(/Environment: TEST/);
    expect(out).not.toMatch(/Environment: LIVE/);
    // The reported string, verbatim from the screenshot in #1138.
    expect(out).not.toContain("LIVE (real orders, real charges)");
  });

  it("still reports LIVE for a connector session the API says is live", async () => {
    stubRoutes({
      "/v1/me": { org: { id: "org_2" }, environment: "live" },
      "/v1/executions": { executions: [] },
    });

    const out = text(await captureTool("firestarter_status", "fs_oauth_connector_live")({}));

    expect(out).toMatch(/Environment: LIVE/);
    expect(out).not.toMatch(/Environment: TEST/);
  });

  it("falls back to the key prefix when /v1/me cannot be reached", async () => {
    stubRoutes({
      "/v1/me": new Error("network down"),
      "/v1/executions": { executions: [] },
    });

    const out = text(await captureTool("firestarter_status", "fs_test_prefixfallback")({}));

    // No worse than the behaviour this replaced.
    expect(out).toMatch(/Environment: TEST/);
  });

  it("keeps rendering the account line alongside the environment", async () => {
    stubRoutes({
      "/v1/me": {
        org: { id: "org_3", name: "mjbjn", plan: "Pro" },
        user: { id: "usr_1", name: "MJ", email: "lolomi9593@hebase.com" },
        environment: "test",
      },
      "/v1/executions": { executions: [] },
    });

    const out = text(await captureTool("firestarter_status", "fs_oauth_accountline")({}));

    expect(out).toMatch(/Environment: TEST/);
    expect(out).toContain("lolomi9593@hebase.com");
    expect(out).toContain("org_3");
  });
});

describe("firestarter_receipt — the banner describes the ORDER, not the caller", () => {
  it("banners a sandbox receipt on an fs_oauth_ bearer (#1138)", async () => {
    stubRoutes({
      "/v1/me": { org: { id: "org_4" }, environment: "test" },
      "/v1/executions/exec_1/receipt": { total_cents: 4999, product_title: "Tennis racket", stripe_charge_id: "ch_fake", test_mode: true },
    });

    const out = text(await captureTool("firestarter_receipt", "fs_oauth_receipt_test")({ execution_id: "exec_1" }));

    expect(out).toMatch(/TEST MODE/);
    expect(out).toMatch(/No money moved/i);
  });

  it("leaves a live receipt unbannered", async () => {
    stubRoutes({
      "/v1/me": { org: { id: "org_5" }, environment: "live" },
      "/v1/executions/exec_2/receipt": { total_cents: 4999, product_title: "Tennis racket", test_mode: false },
    });

    const out = text(await captureTool("firestarter_receipt", "fs_oauth_receipt_live")({ execution_id: "exec_2" }));

    expect(out).not.toMatch(/TEST MODE/);
  });

  it("banners a SANDBOX order even when the credential is live", async () => {
    // The receipt route filters by org_id, not environment, so one org can
    // read across both. Keying the banner off the caller dropped it from a
    // simulated order whenever the key was live — the screenshot-as-proof
    // case this banner exists to prevent.
    stubRoutes({
      "/v1/me": { org: { id: "org_8" }, environment: "live" },
      "/v1/executions/exec_3/receipt": { total_cents: 4999, product_title: "Tennis racket", test_mode: true },
    });

    const out = text(await captureTool("firestarter_receipt", "fs_live_receipt_crossenv")({ execution_id: "exec_3" }));

    expect(out).toMatch(/TEST MODE/);
  });

  it("does not stamp a REAL charge as simulated on a test credential", async () => {
    // The other direction, and the worse one: telling a buyer that a card
    // charge that actually happened moved no money.
    stubRoutes({
      "/v1/me": { org: { id: "org_9" }, environment: "test" },
      "/v1/executions/exec_4/receipt": { total_cents: 4999, product_title: "Tennis racket", stripe_charge_id: "ch_real", test_mode: false },
    });

    const out = text(await captureTool("firestarter_receipt", "fs_test_receipt_crossenv")({ execution_id: "exec_4" }));

    expect(out).not.toMatch(/TEST MODE/);
    expect(out).not.toMatch(/No money moved/i);
  });

  it("falls back to the credential when the payload carries no test_mode", async () => {
    // An API old enough not to stamp the order still gets the old behaviour
    // rather than silently losing the banner.
    stubRoutes({
      "/v1/me": { org: { id: "org_10" }, environment: "test" },
      "/v1/executions/exec_5/receipt": { total_cents: 4999, product_title: "Tennis racket" },
    });

    const out = text(await captureTool("firestarter_receipt", "fs_oauth_receipt_nostamp")({ execution_id: "exec_5" }));

    expect(out).toMatch(/TEST MODE/);
  });
});

describe("resolveEnvironment — cheap and blip-proof", () => {
  it("answers a raw fs_test_ key without calling /v1/me at all", async () => {
    // /v1/me is per-IP rate limited and shared by every remote-MCP session.
    // A prefix that already spells the environment must not spend that budget.
    stubRoutes({ "/v1/executions/exec_9/receipt": { total_cents: 100, test_mode: true } });

    const out = text(await captureTool("firestarter_receipt", "fs_test_noround_trip")({ execution_id: "exec_9" }));

    expect(out).toMatch(/TEST MODE/);
    const called = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(called.some((u: string) => u.includes("/v1/me"))).toBe(false);
  });

  it("keeps reporting TEST from cache when a later /v1/me blips", async () => {
    // Without the cache in the fallback chain, one failed lookup mid-session
    // printed "LIVE (real orders, real charges)" again — #1138, resurrected.
    const BEARER = "fs_oauth_blip";
    stubRoutes({
      "/v1/me": { org: { id: "org_11" }, environment: "test" },
      "/v1/executions": { executions: [] },
    });
    const first = text(await captureTool("firestarter_status", BEARER)({}));
    expect(first).toMatch(/Environment: TEST/);

    // Same bearer, /v1/me now unreachable.
    stubRoutes({ "/v1/me": new Error("blip"), "/v1/executions": { executions: [] } });
    const second = text(await captureTool("firestarter_status", BEARER)({}));

    expect(second).toMatch(/Environment: TEST/);
    expect(second).not.toContain("LIVE (real orders, real charges)");
  });
});

describe("firestarter_spend_cap — the enforcement claim matches the environment", () => {
  it("says the cap is not applied to sandbox purchases on a connector test session", async () => {
    stubRoutes({
      "/v1/me": { org: { id: "org_6" }, environment: "test" },
      "/v1/billing/balance": { spend_cap_cents: 50000, alert_threshold_pct: 80, month_to_date_spend_cents: 1000 },
    });

    const out = text(await captureTool("firestarter_spend_cap", "fs_oauth_cap_test")({}));

    expect(out).toMatch(/TEST key|not applied/i);
  });

  it("claims plain enforcement on a live connector session", async () => {
    stubRoutes({
      "/v1/me": { org: { id: "org_7" }, environment: "live" },
      "/v1/billing/balance": { spend_cap_cents: 50000, alert_threshold_pct: 80, month_to_date_spend_cents: 1000 },
    });

    const out = text(await captureTool("firestarter_spend_cap", "fs_oauth_cap_live")({}));

    expect(out).toMatch(/automatically rejected\.$/m);
    expect(out).not.toMatch(/not applied/i);
  });
});

describe("listingStatusLine — a sandbox listing never reads as live (#1142)", () => {
  it("qualifies an active sandbox listing", () => {
    const line = listingStatusLine({ status: "active", test_mode: true });
    expect(line).toMatch(/TEST MODE/);
    expect(line).toMatch(/real buyers cannot/i);
  });

  it("qualifies on the `environment` field too", () => {
    expect(listingStatusLine({ status: "active", environment: "test" })).toMatch(/TEST MODE/);
  });

  it("leaves a live listing's status bare", () => {
    expect(listingStatusLine({ status: "active", test_mode: false })).toBe("active");
  });

  it("defaults a missing status to active without inventing an environment", () => {
    expect(listingStatusLine({})).toBe("active");
  });
});

describe("firestarter_list — the creation reply agrees with itself", () => {
  it("does not report a sandbox listing as plain active (#1142)", async () => {
    stubRoutes({
      "/v1/listings": {
        id: "lst_1",
        product_name: "Men's Woven Leather Slide Sandals",
        status: "active",
        base_price: 50,
        test_mode: true,
        share_url: null,
        images: ["https://img.local/a.jpg"],
      },
    });

    const out = text(await captureTool("firestarter_list", "fs_test_create_sandbox")({
      product_name: "Men's Woven Leather Slide Sandals",
      base_price: 50,
    }));

    expect(out).toMatch(/Status: active \(TEST MODE/);
    expect(out).toMatch(/Sandbox-only listing/);
    expect(out).not.toMatch(/Share link:/);
  });

  // Not a reproduced report: listing-create.ts derives status from
  // activationBlocks, so a live draft always carries blocks and takes the
  // draft branch. This pins the fallback's behaviour if that ever changes —
  // the old bare `else` would have called this listing test-mode.
  it("does not call a live, share-link-less listing a sandbox one", async () => {
    stubRoutes({
      "/v1/listings": {
        id: "lst_2",
        product_name: "Real Widget",
        status: "draft",
        base_price: 20,
        test_mode: false,
        share_url: null,
        activation_blocked: [],
        images: ["https://img.local/b.jpg"],
      },
    });

    const out = text(await captureTool("firestarter_list", "fs_live_create_draft")({
      product_name: "Real Widget",
      base_price: 20,
    }));

    expect(out).not.toMatch(/Sandbox-only/);
    expect(out).not.toMatch(/test mode/i);
    // Asserts the STATUS line, not the word "Activate" in the fallback
    // sentence below it — which is what a bare /active/ was matching.
    expect(out).toContain("Status: draft\n");
  });

  it("still prints the share link for a live active listing", async () => {
    stubRoutes({
      "/v1/listings": {
        id: "lst_3",
        product_name: "Real Widget",
        status: "active",
        base_price: 20,
        test_mode: false,
        share_url: "https://firestarter.network/l/lst_3",
        images: ["https://img.local/c.jpg"],
      },
    });

    const out = text(await captureTool("firestarter_list", "fs_live_create_active")({
      product_name: "Real Widget",
      base_price: 20,
    }));

    expect(out).toContain("Status: active\n");
    expect(out).toContain("https://firestarter.network/l/lst_3");
    expect(out).not.toMatch(/Sandbox-only/);
  });
});
