/**
 * firestarter_seller_disputes (the seller-side MCP dispute tool).
 *
 * Pins the tool <-> API contract that previously drifted: the tool used to POST
 * a bare { resolution } string, but PUT /v1/sellers/disputes/:id/resolve requires
 * an explicit engine action (voluntary_refund | propose_split | contest) and
 * returns 400 MISSING_ACTION otherwise. This locks that the tool now:
 *   - lists disputes (surfacing each dispute_id so the agent can act on one)
 *   - translates the seller's friendly action (refund/contest/split) into the
 *     engine action the API expects, with the right body shape.
 *
 * Same harness as mcp-request-escrow.test.ts: real registered tool handlers via
 * a fake McpServer, mocked global fetch.
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

const DISPUTE_ID = "disp_abc123def456";
const RESOLVE_URL = `http://api.test/v1/sellers/disputes/${DISPUTE_ID}/resolve`;

describe("firestarter_seller_disputes", () => {
  it("lists disputes and surfaces each dispute_id for follow-up actions", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({
      status: 200,
      json: {
        disputes: [
          { id: DISPUTE_ID, product: "Coffee Beans", reason: "not_received", status: "open" },
        ],
      },
    }));

    const res = await tools.firestarter_seller_disputes({});
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://api.test/v1/sellers/disputes");
    // The dispute_id MUST appear so the agent can act on it next.
    expect(text).toContain(DISPUTE_ID);
    expect(text).toContain("Coffee Beans");
    expect(text).toMatch(/refund \/ contest \/ split/);
  });

  it("'refund' maps to the voluntary_refund engine action", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { ok: true, dispute: { id: DISPUTE_ID, status: "resolved_agreed" } } }));

    const res = await tools.firestarter_seller_disputes({
      dispute_id: DISPUTE_ID,
      action: "refund",
      reasoning: "Item never arrived, refunding the buyer.",
    });

    expect(res.isError).toBeUndefined();
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(RESOLVE_URL);
    expect(calls[0].body.action).toBe("voluntary_refund");
    expect(calls[0].body.reasoning).toContain("never arrived");
    expect(textOf(res)).toMatch(/full refund/i);
  });

  it("'contest' maps to the contest engine action", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { ok: true, dispute: { id: DISPUTE_ID, status: "seller_responded" } } }));

    await tools.firestarter_seller_disputes({ dispute_id: DISPUTE_ID, action: "contest" });

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body.action).toBe("contest");
    // A contest carries no split percentages.
    expect(calls[0].body.buyer_pct).toBeUndefined();
    expect(calls[0].body.seller_pct).toBeUndefined();
  });

  it("'split' maps to propose_split and forwards the percentages", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { ok: true, dispute: { id: DISPUTE_ID, status: "negotiating" } } }));

    await tools.firestarter_seller_disputes({
      dispute_id: DISPUTE_ID,
      action: "split",
      buyer_pct: 60,
      seller_pct: 40,
    });

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body.action).toBe("propose_split");
    expect(calls[0].body.buyer_pct).toBe(60);
    expect(calls[0].body.seller_pct).toBe(40);
  });

  it("a dispute_id with no action asks for one WITHOUT calling the API", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: {} }));

    const res = await tools.firestarter_seller_disputes({ dispute_id: DISPUTE_ID });

    expect(calls).toHaveLength(0); // never hit the API with an ambiguous request
    expect(textOf(res)).toMatch(/refund/);
    expect(textOf(res)).toMatch(/contest/);
    expect(textOf(res)).toMatch(/split/);
  });

  it("surfaces an API error (e.g. wrong seller) instead of claiming success", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 404, json: { code: "NOT_FOUND", error: "Dispute not found or you are not the seller" } }));

    const res = await tools.firestarter_seller_disputes({ dispute_id: DISPUTE_ID, action: "refund" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Error with disputes/i);
  });

  // The empty-list copy is the exact text that mislabeled a BUYER's dispute
  // question. It must never claim a global "all orders in good standing", and a
  // non-seller must be told to use the buyer tool — not that there are no disputes.
  it("empty list for a NON-seller points to the buyer tool, never 'good standing'", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { disputes: [], is_seller: false } }));

    const res = await tools.firestarter_seller_disputes({});
    const text = textOf(res);

    expect(text).not.toMatch(/good standing/i);
    expect(text).toMatch(/not registered as a seller/i);
    expect(text).toMatch(/firestarter_disputes/);
  });

  it("empty list for an ACTIVE seller says so seller-scoped, never 'good standing'", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { disputes: [], is_seller: true } }));

    const text = textOf(await tools.firestarter_seller_disputes({}));

    expect(text).not.toMatch(/good standing/i);
    expect(text).toMatch(/your sales/i);
    expect(text).toMatch(/firestarter_disputes/);
  });
});
