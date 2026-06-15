/**
 * firestarter_import + firestarter_payouts (A2: Cole-chat seller claim funnel).
 *
 * Sellers paste a marketplace URL (or, for fetch-blocked platforms, the
 * listing text) in chat; firestarter_import wraps POST /v1/listings/import and
 * tells the agent to walk the seller through draft review -> payouts ->
 * activation. firestarter_payouts wraps the Stripe Connect status/onboarding
 * endpoints so the agent can unblock activation (PATCH draft->active rejects
 * with SELLER_PAYOUTS_REQUIRED until charges are enabled).
 *
 * Same harness as mcp-execute-attribution.test.ts: drive the REAL registered
 * tool handlers (captured via a fake McpServer) against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

type RecordedCall = { method: string; url: string; body: any };

/** Stub global fetch; route every request through `respond`, recording calls. */
function installFetch(
  respond: (method: string, url: string, body: any) => { status: number; json: any }
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(url), body });
      const { status, json } = respond(method, String(url), body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

// 201 shape from POST /v1/listings/import (pg numerics arrive as strings).
const DRAFT = {
  id: "lst_draft1",
  seller_id: "sel_1",
  org_id: "org_1",
  product_name: "Trek Marlin 7 Mountain Bike",
  category: "sporting-goods/bikes",
  description: "Great condition, barely used. Size M frame, 29in wheels.",
  images: ["https://images.craigslist.org/a.jpg", "https://images.craigslist.org/b.jpg"],
  base_price: "450.00",
  currency: "USD",
  condition: "used_good",
  status: "draft",
  import_source: "craigslist",
  import_url: "https://austin.craigslist.org/bik/d/trek-marlin/123.html",
  import_confidence: 0.91,
  needs_review: [],
  next_step: "Review the draft, set pricing, then activate.",
};

describe("firestarter_import — draft import flow", () => {
  it("imports from a URL: posts source_url only and renders the draft summary", async () => {
    const calls = installFetch(() => ({ status: 201, json: DRAFT }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: DRAFT.import_url });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://api.test/v1/listings/import");
    expect(calls[0].body).toEqual({ source_url: DRAFT.import_url });

    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("Draft imported: Trek Marlin 7 Mountain Bike");
    expect(text).toContain("NOT live");
    expect(text).toContain("$450.00 USD");
    expect(text).toContain("Photos: 2");
    // The walk-through the agent relays: review -> payouts -> activate.
    expect(text).toContain("firestarter_payouts");
    expect(text).toMatch(/firestarter_update_listing with status "active"/);
  });

  it("imports from pasted text: posts raw_text + photo_urls, no source_url", async () => {
    const calls = installFetch(() => ({ status: 201, json: DRAFT }));
    const tools = captureTools();

    await tools.firestarter_import({
      raw_text: "Trek Marlin 7 mountain bike, size M, $450. Barely used.",
      photo_urls: ["https://example.com/bike.jpg"],
    });

    expect(calls[0].body).toEqual({
      raw_text: "Trek Marlin 7 mountain bike, size M, $450. Barely used.",
      photo_urls: ["https://example.com/bike.jpg"],
    });
    expect(calls[0].body.source_url).toBeUndefined();
  });

  it("drops an empty photo_urls array instead of sending []", async () => {
    const calls = installFetch(() => ({ status: 201, json: DRAFT }));
    const tools = captureTools();

    await tools.firestarter_import({ source_url: DRAFT.import_url, photo_urls: [] });

    expect(calls[0].body).toEqual({ source_url: DRAFT.import_url });
  });

  it("renders the no-price draft with a reprice prompt and the needs_review list", async () => {
    const noPriceDraft = {
      ...DRAFT,
      base_price: "0.00",
      needs_review: ["base_price", "condition"],
    };
    installFetch(() => ({ status: 201, json: noPriceDraft }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: DRAFT.import_url });

    const text = textOf(res);
    expect(text).toContain("none found - set one with firestarter_reprice");
    expect(text).not.toContain("$0.00");
    expect(text).toContain("Needs review");
    expect(text).toContain("base_price, condition");
  });

  it("PLATFORM_BLOCKED becomes a copy-paste instruction for the agent", async () => {
    installFetch(() => ({
      status: 422,
      json: {
        error:
          "ebay blocks server-side fetches. Paste the listing text (and photo URLs) as raw_text / photo_urls instead.",
        code: "PLATFORM_BLOCKED",
        status: 422,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: "https://www.ebay.com/itm/12345" });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/copy-paste the listing text/i);
    expect(text).toContain("raw_text + photo_urls");
  });

  it("NO_SELLER_PROFILE routes the seller to firestarter_sell_link (issue #213)", async () => {
    installFetch(() => ({
      status: 403,
      json: {
        error: "No active seller profile found. Register as a seller first.",
        code: "NO_SELLER_PROFILE",
        status: 403,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: DRAFT.import_url });

    const text = textOf(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("NO_SELLER_PROFILE");
    expect(text).toContain("firestarter_sell_link");
  });

  it("FETCH_FAILED suggests retrying with pasted text", async () => {
    installFetch(() => ({
      status: 422,
      json: {
        error: "Could not fetch the listing from that URL. The site may be down or blocking requests.",
        code: "FETCH_FAILED",
        status: 422,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: "https://example.com/gone" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/paste the listing text directly/i);
  });
});

describe("firestarter_payouts — Stripe Connect status + onboarding", () => {
  const STATUS_URL = "http://api.test/v1/sellers/stripe-connect/status";
  const CONNECT_URL = "http://api.test/v1/sellers/stripe-connect";

  it("connected: reports payable and does NOT create an onboarding link", async () => {
    const calls = installFetch(() => ({
      status: 200,
      json: {
        connected: true,
        account_id: "acct_1",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_payouts({});

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: STATUS_URL });
    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("Payouts connected");
    expect(text).not.toContain("pending verification");
  });

  it("charges enabled but bank payouts pending: connected, with a non-blocking note", async () => {
    installFetch(() => ({
      status: 200,
      json: {
        connected: true,
        account_id: "acct_1",
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_payouts({});

    const text = textOf(res);
    expect(text).toContain("Payouts connected");
    expect(text).toContain("pending verification");
    expect(text).toContain("does not block activating");
  });

  it("not connected: fetches an onboarding link and tells the agent to re-verify", async () => {
    const calls = installFetch((method, url) => {
      if (method === "GET" && url === STATUS_URL) {
        return {
          status: 200,
          json: { connected: false, charges_enabled: false, payouts_enabled: false, details_submitted: false },
        };
      }
      if (method === "POST" && url === CONNECT_URL) {
        return {
          status: 201,
          json: { account_id: "acct_new", onboarding_url: "https://connect.stripe.com/setup/s/abc123", existing: false },
        };
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const tools = captureTools();

    const res = await tools.firestarter_payouts({});

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${STATUS_URL}`,
      `POST ${CONNECT_URL}`,
    ]);
    const text = textOf(res);
    expect(text).toContain("Payouts not connected");
    expect(text).toContain("https://connect.stripe.com/setup/s/abc123");
    expect(text).toContain("run firestarter_payouts again");
  });

  it("started but unfinished onboarding: refreshes the link with 'not finished' framing", async () => {
    installFetch((method, url) => {
      if (method === "GET" && url === STATUS_URL) {
        return {
          status: 200,
          json: { connected: true, account_id: "acct_1", charges_enabled: false, payouts_enabled: false, details_submitted: false },
        };
      }
      return {
        status: 200,
        json: { account_id: "acct_1", onboarding_url: "https://connect.stripe.com/setup/s/resume", existing: true },
      };
    });
    const tools = captureTools();

    const res = await tools.firestarter_payouts({});

    const text = textOf(res);
    expect(text).toContain("Payouts not finished");
    expect(text).toContain("https://connect.stripe.com/setup/s/resume");
  });

  it("no seller profile: errors with the registration pointer", async () => {
    installFetch(() => ({
      status: 404,
      json: { error: "No active seller profile", code: "NOT_FOUND", status: 404 },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_payouts({});

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("firestarter.network/sell");
  });
});
