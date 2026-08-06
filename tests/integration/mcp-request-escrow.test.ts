/**
 * firestarter_request_escrow (B1: the buyer-side MCP tool) + the buyer_invite
 * verification reason rendering.
 *
 * Pins the chat seam:
 *   - a minted invite renders the claim link + the suggested message + the
 *     HUMAN-SENDS instruction (never automate contact with external sellers)
 *   - already_listed short-circuits to the share link
 *   - blocked-platform manual fields (title/price) pass through to the API
 *   - error hints for bad email / bad URL
 *   - firestarter_update_listing renders the buyer_invite 409 reason
 *
 * Same harness as mcp-verify.test.ts: real registered tool handlers via a
 * fake McpServer, mocked global fetch.
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

type RecordedCall = { method: string; url: string; body: any };

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

const CL_URL = "https://sfbay.craigslist.org/d/weight-rack/1.html";
const FB_URL = "https://www.facebook.com/marketplace/item/1234567890";

const INVITE_201 = {
  status: 201,
  json: {
    id: "inv_mcp1",
    status: "pending",
    platform: "craigslist",
    claim_url: "https://firestarter.network/claim/tok_mcp_abcdef",
    suggested_message:
      "Hi! I'd like to buy your \"Power Rack\" listing and pay through Firestarter escrow so we're both protected - my payment is held until handoff, and there's nothing for you to pay up front (no listing fees, a 5% + 50¢ commission only when it sells). Claim the listing here and I can pay right away: https://firestarter.network/claim/tok_mcp_abcdef",
    item: { title: "Power Rack", price: 800, currency: "USD" },
    expires_at: "2099-01-01T00:00:00.000Z",
    reused: false,
    next_step: "Send the suggested_message to the seller yourself...",
  },
};

describe("firestarter_request_escrow", () => {
  it("renders the claim link, suggested message, and the human-sends rule", async () => {
    const tools = captureTools();
    const calls = installFetch(() => INVITE_201);

    const res = await tools.firestarter_request_escrow({
      source_url: CL_URL,
      buyer_email: "buyer@example.com",
      buyer_name: "Sam",
    });
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    expect(text).toContain("https://firestarter.network/claim/tok_mcp_abcdef");
    expect(text).toContain("5% + 50¢ commission");
    // The agent must hand the message to the BUYER to send - never automate.
    expect(text).toMatch(/send the seller this message themselves/i);
    expect(text).toMatch(/do not contact the seller/i);
    expect(text).toContain("buyer@example.com");
    // It hit the right endpoint with the right body.
    expect(calls[0].url).toBe("http://api.test/v1/escrow-invites");
    expect(calls[0].body.source_url).toBe(CL_URL);
    expect(calls[0].body.buyer_name).toBe("Sam");
  });

  it("short-circuits to the share link when the item is already live", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 200,
      json: {
        already_listed: true,
        listing_id: "lst_live9",
        share_url: "https://firestarter.network/l/lst_live9",
        title: "Power Rack",
      },
    }));

    const text = textOf(await tools.firestarter_request_escrow({
      source_url: CL_URL,
      buyer_email: "buyer@example.com",
    }));
    expect(text).toMatch(/already live on Firestarter/i);
    expect(text).toContain("https://firestarter.network/l/lst_live9");
    expect(text).toMatch(/no invite needed/i);
  });

  it("passes blocked-platform manual title/price through to the API", async () => {
    const tools = captureTools();
    const calls = installFetch(() => INVITE_201);

    await tools.firestarter_request_escrow({
      source_url: FB_URL,
      buyer_email: "buyer@example.com",
      title: "IKEA wardrobe",
      price: 250,
    });
    expect(calls[0].body.title).toBe("IKEA wardrobe");
    expect(calls[0].body.price).toBe(250);
  });

  it("hints to collect a valid email on INVALID_BUYER_EMAIL", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 400,
      json: { error: "buyer_email must be a valid email address", code: "INVALID_BUYER_EMAIL", status: 400 },
    }));

    const res = await tools.firestarter_request_escrow({
      source_url: CL_URL,
      buyer_email: "nope",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/ask the buyer for a valid email/i);
  });

  it("hints to re-copy the listing URL on INVALID_URL", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 400,
      json: { error: "source_url rejected: host is not a public domain name", code: "INVALID_URL", status: 400 },
    }));

    const res = await tools.firestarter_request_escrow({
      source_url: "http://localhost/x",
      buyer_email: "buyer@example.com",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/copy the full address bar url/i);
  });
});

describe("buyer_invite verification reason (R17)", () => {
  it("firestarter_update_listing renders the buyer-requested-escrow wording on the 409", async () => {
    const tools = captureTools();
    installFetch((method, url) => {
      if (method === "PATCH" && url.includes("/v1/listings/")) {
        return {
          status: 409,
          json: {
            error: "This listing needs possession verification before it can go live.",
            code: "VERIFICATION_REQUIRED",
            status: 409,
            verification: {
              status: "required",
              reason: "buyer_invite",
              code: "FS-9X4T",
              instructions: "Write the code FS-9X4T by hand...",
            },
          },
        };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_update_listing({ listing_id: "lst_bi1", status: "active" });
    const text = textOf(res);
    expect(text).toContain("FS-9X4T");
    expect(text).toMatch(/a buyer requested an escrow-protected purchase/i);
    expect(text).toContain("firestarter_verify");
    expect(text).not.toContain("Error updating listing");
  });
});
