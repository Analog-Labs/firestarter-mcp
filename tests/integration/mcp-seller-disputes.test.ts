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

  it("a dispute_id with no action READS the thread and moves no money (#786)", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({
      status: 200,
      json: {
        dispute: {
          id: DISPUTE_ID, status: "open", reason: "arrived damaged",
          messages: [{ sender_role: "buyer", message: "The box was crushed.", attachment_urls: ["u"] }],
        },
      },
    }));

    const res = await tools.firestarter_seller_disputes({ dispute_id: DISPUTE_ID });

    // Previously this asked the seller to pick refund/contest/split without
    // showing them what the buyer had claimed — deciding blind on a money call.
    const text = textOf(res);
    expect(text).toContain("arrived damaged");
    expect(text).toContain("The box was crushed");
    expect(text).toMatch(/1 photo/);
    // Reading is a GET; nothing that moves money is called.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => /\/resolve$/.test(c.url))).toBe(false);
    // Still names the ways forward, now including the new reply path.
    expect(text).toMatch(/message/);
    expect(text).toMatch(/refund/);
    expect(text).toMatch(/contest/);
    expect(text).toMatch(/split/);
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

/**
 * #786 review: the seller read view was a hand-copy of the buyer renderer and
 * had lost five behaviours in the copy. Both views now share one renderer.
 */
describe("firestarter_seller_disputes — the read view tells the whole truth (#786 review)", () => {
  const THREAD = (over: Record<string, unknown> = {}) => ({
    dispute: {
      id: DISPUTE_ID, execution_id: "exec_1", status: "seller_responded", reason: "arrived damaged",
      seller_deadline_at: "2026-08-20T00:00:00.000Z",
      offers: [{ id: "off_1", offered_by: "buyer", buyer_pct: 80, seller_pct: 20, created_at: "x" }],
      messages: [
        { sender_role: "buyer", message: "The box was crushed.", attachment_urls: [] },
        { sender_role: "admin", message: "Firestarter is reviewing this.", attachment_urls: [] },
      ],
      ...over,
    },
  });

  it("labels Firestarter's own messages as Firestarter, not as the buyer", async () => {
    installFetch(() => ({ status: 200, json: THREAD() }));
    const text = textOf(await captureTools().firestarter_seller_disputes({ dispute_id: DISPUTE_ID }));

    // A two-way ternary attributed platform arbitration to the adversary.
    expect(text).toMatch(/\*\*Firestarter:\*\* Firestarter is reviewing this/);
    expect(text).toMatch(/\*\*Buyer:\*\* The box was crushed/);
  });

  it("shows the pending buyer offer and the response deadline", async () => {
    installFetch(() => ({ status: 200, json: THREAD() }));
    const text = textOf(await captureTools().firestarter_seller_disputes({ dispute_id: DISPUTE_ID }));

    // These are the two facts the seller's decision actually turns on; the
    // hand-copied view dropped both while claiming to prevent deciding blind.
    expect(text).toMatch(/80% refund to buyer/);
    expect(text).toMatch(/You must respond by/);
  });

  it("does not advertise refund/contest/split on a closed dispute", async () => {
    installFetch(() => ({ status: 200, json: THREAD({ status: "resolved_agreed", offers: [], seller_deadline_at: null }) }));
    const text = textOf(await captureTools().firestarter_seller_disputes({ dispute_id: DISPUTE_ID }));

    // /resolve answers 409 INVALID_STATUS for these, so offering it sends the
    // agent into a guaranteed error.
    expect(text).toMatch(/closed/i);
    expect(text).not.toMatch(/resolve with "refund"/);
  });

  it("an action with no dispute_id reports the miss instead of listing", async () => {
    const calls = installFetch(() => ({ status: 200, json: { disputes: [] } }));
    const res = await captureTools().firestarter_seller_disputes({ action: "message", message: "packing photo note" });

    // This used to fall through to the list and discard the note silently.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Nothing was sent/);
    expect(calls).toHaveLength(0);
  });

  it("uses the cleaned id for the money move, not the raw one", async () => {
    const calls = installFetch(() => ({ status: 200, json: { ok: true } }));
    await captureTools().firestarter_seller_disputes({ dispute_id: "disp\\_abc", action: "refund" });

    // Reading accepted a markdown-escaped id while resolving 404'd on it.
    expect(calls[0].url).toContain("/disputes/disp_abc/resolve");
  });
});
