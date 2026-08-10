/**
 * firestarter_payouts — two bugs found in the 2026-08-10 QA pass:
 *
 * 1) Stripe test-mode onboarding: POST /v1/sellers/stripe-connect deliberately
 *    returns `onboarding_url: null` in test mode (routes/sellers.ts) — Stripe
 *    test mode auto-approves the account, so there's nothing to send the seller
 *    to. The tool interpolated that null straight into the reply text, so the
 *    agent told the seller to open the link "null".
 *
 * 2) PayPal connect: #478 (apps/api/src/routes/seller-payouts.ts) made PayPal
 *    connect a two-step, ownership-proven flow — POST /payout-method/paypal now
 *    returns status:"pending_confirmation", confirmed:false until the seller
 *    clicks the emailed link. The MCP tool text was never updated for that PR
 *    and always said "**PayPal payouts connected!** ... Status: connected —
 *    verified on your first payout", directly contradicting the confirmation
 *    instructions in the same reply's `result.message`.
 *
 * Same harness as mcp-listing-images.test.ts: real registered handlers via a
 * fake McpServer against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_payouts — stripe test-mode (no onboarding_url)", () => {
  it("does not print a literal 'null' onboarding link when the API returns onboarding_url: null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "POST" && String(url).endsWith("/v1/sellers/stripe-connect")) {
          return jsonResponse(200, {
            account_id: "acct_test_mock_sel1",
            onboarding_url: null,
            existing: true,
            test_mode: true,
            message: "Test mode: Stripe Connect auto-approved",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();

    const res = await tools.firestarter_payouts({ provider: "stripe" });
    const text = res.content[0].text as string;

    expect(res.isError).toBeFalsy();
    expect(text).not.toContain("null");
    expect(text.toLowerCase()).toContain("test mode");
    expect(text.toLowerCase()).toContain("auto-approved");
  });

  it("still sends the real onboarding link when the API returns one (live mode)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "POST" && String(url).endsWith("/v1/sellers/stripe-connect")) {
          return jsonResponse(201, {
            account_id: "acct_live1",
            onboarding_url: "https://connect.stripe.com/setup/acct_live1",
            existing: false,
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();

    const res = await tools.firestarter_payouts({ provider: "stripe" });
    const text = res.content[0].text as string;

    expect(res.isError).toBeFalsy();
    expect(text).toContain("https://connect.stripe.com/setup/acct_live1");
  });
});

describe("firestarter_payouts — paypal pending confirmation (#478 honesty)", () => {
  it("does NOT claim 'connected' when the API reports pending_confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "POST" && String(url).endsWith("/v1/sellers/payout-method/paypal")) {
          return jsonResponse(200, {
            ok: true,
            provider: "paypal",
            email: "seller@realmail.com",
            status: "pending_confirmation",
            confirmed: false,
            verified: false,
            confirmation_sent: true,
            message: "Check seller@realmail.com for a confirmation link. Your listings can sell right away — earnings wait safely in escrow until you confirm, and we never send money to an unconfirmed address.",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();

    const res = await tools.firestarter_payouts({ provider: "paypal", paypal_email: "seller@realmail.com" });
    const text = res.content[0].text as string;

    expect(res.isError).toBeFalsy();
    expect(text).not.toMatch(/connected!/i);
    expect(text).not.toMatch(/Status: connected/i);
    expect(text.toLowerCase()).toContain("pending");
    expect(text).toContain("Check seller@realmail.com for a confirmation link");
  });

  it("reports success when the API confirms an already-proven address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "POST" && String(url).endsWith("/v1/sellers/payout-method/paypal")) {
          return jsonResponse(200, {
            ok: true,
            provider: "paypal",
            email: "seller@realmail.com",
            status: "confirmed",
            confirmed: true,
            message: "This PayPal address is already confirmed for payouts.",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();

    const res = await tools.firestarter_payouts({ provider: "paypal", paypal_email: "seller@realmail.com" });
    const text = res.content[0].text as string;

    expect(res.isError).toBeFalsy();
    expect(text.toLowerCase()).toContain("confirmed");
  });
});
