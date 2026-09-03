/**
 * firestarter_disputes (the BUYER-side MCP dispute tool).
 *
 * This tool is the fix for the reported bug: a buyer asking "is there a dispute
 * on my order?" used to hit the seller-only firestarter_seller_disputes tool,
 * which returns an empty list for a non-seller org and reported "No disputes.
 * All orders are in good standing" — a false negative. firestarter_disputes is
 * buyer-scoped and execution-centric, so it answers truthfully and lets a buyer
 * open, track, and resolve their own disputes.
 *
 * Same harness as mcp-seller-disputes.test.ts: real registered tool handlers via
 * a fake McpServer, mocked global fetch routed by method+url.
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

/** Route mocked fetch by (method, url). Unmatched routes return {} 200 so the
 *  image-fetch path (inlineImageBlocks) never throws. */
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
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

const EXEC = "exec_catfood01";
const DID = "disp_abc123";

describe("firestarter_disputes (buyer)", () => {
  it("lists the buyer's disputes buyer-scoped, not the seller's", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (method === "GET" && url === "http://api.test/buyer/disputes") {
        return { status: 200, json: { disputes: [
          { id: DID, execution_id: EXEC, product: "Cat Food Can", status: "open", is_open: true },
        ] } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({});
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    // Buyer endpoint — NOT the seller one.
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://api.test/buyer/disputes" });
    expect(text).toContain(DID);
    expect(text).toContain("Cat Food Can");
    expect(text).toContain("1 open");
  });

  it("says 'no disputes' truthfully (buyer-scoped) when the buyer has none", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { disputes: [] } }));

    const res = await tools.firestarter_disputes({});
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    // Points the buyer at how to open one — the wording is buyer-scoped.
    expect(text).toMatch(/no disputes/i);
    expect(text).toMatch(/open/i);
  });

  it("checking a specific order with no dispute does NOT claim a false negative", async () => {
    const tools = captureTools();
    installFetch((method, url) => {
      if (url === "http://api.test/buyer/disputes") return { status: 200, json: { disputes: [] } };
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({ execution_id: EXEC });
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    expect(text).toContain(EXEC);
    // It should say THIS order has no dispute and offer to open one — never the
    // seller tool's global "all orders in good standing".
    expect(text).not.toMatch(/all orders/i);
    expect(text).toMatch(/open/i);
  });

  it("views a dispute by execution_id: resolves the id, then renders the thread + offer", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (method === "GET" && url === "http://api.test/buyer/disputes") {
        return { status: 200, json: { disputes: [{ id: DID, execution_id: EXEC, status: "seller_responded", is_open: true }] } };
      }
      if (method === "GET" && url === `http://api.test/buyer/disputes/${DID}`) {
        return { status: 200, json: { dispute: {
          id: DID, execution_id: EXEC, status: "seller_responded", dispute_type: "not_received",
          reason: "Never arrived", seller_deadline_at: new Date().toISOString(),
          offers: [{ id: "off_1", offered_by: "seller", buyer_pct: 60, seller_pct: 40, reasoning: "sorry", accepted_at: null, rejected_at: null }],
          messages: [{ sender_role: "seller", message: "Looking into it", attachment_urls: [] }],
        } } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({ execution_id: EXEC });
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    expect(calls.some((c) => c.url === `http://api.test/buyer/disputes/${DID}`)).toBe(true);
    expect(text).toContain(DID);
    expect(text).toMatch(/60% refund to you/);
    expect(text).toMatch(/Seller:/);
    // A pending seller offer must prompt accept/reject/counter.
    expect(text).toMatch(/accept/i);
  });

  it("opens a dispute via the execution-keyed route (freezes escrow + starts the timer)", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (method === "GET" && url === "http://api.test/buyer/disputes") return { status: 200, json: { disputes: [] } };
      if (method === "POST" && url === `http://api.test/v1/executions/${EXEC}/dispute`) {
        return { status: 200, json: { dispute_id: DID, status: "disputed", escrow_frozen: true, message: "Funds frozen." } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({ action: "open", execution_id: EXEC, reason: "Never arrived", type: "not_received" });
    const text = textOf(res);

    const openCall = calls.find((c) => c.method === "POST" && c.url.endsWith(`/v1/executions/${EXEC}/dispute`));
    expect(openCall).toBeDefined();
    expect(openCall!.body).toMatchObject({ reason: "Never arrived", type: "not_received" });
    expect(text).toMatch(/Dispute opened/i);
    expect(text).toContain(DID);
  });

  it("refuses to open a SECOND dispute when the order already has an open one", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (url === "http://api.test/buyer/disputes") {
        return { status: 200, json: { disputes: [{ id: DID, execution_id: EXEC, status: "open", is_open: true }] } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({ action: "open", execution_id: EXEC, reason: "again" });
    const text = textOf(res);

    // Must NOT hit the open endpoint a second time.
    expect(calls.some((c) => c.url.includes("/dispute") && c.method === "POST")).toBe(false);
    expect(text).toContain(DID);
    expect(text).toMatch(/already has an open dispute/i);
  });

  it("posts a message with a photo: uploads to /attachments then attaches the minted url", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (method === "POST" && url === `http://api.test/buyer/disputes/${DID}/attachments`) {
        return { status: 200, json: { url: "http://api.test/v1/img/abc" } };
      }
      if (method === "POST" && url === `http://api.test/buyer/disputes/${DID}/messages`) {
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({ action: "message", dispute_id: DID, message: "here's the photo", image_base64: "data:image/jpeg;base64,/9j/4AAQ" });

    expect(res.isError).toBeUndefined();
    const upload = calls.find((c) => c.url.endsWith(`/${DID}/attachments`));
    const post = calls.find((c) => c.url.endsWith(`/${DID}/messages`));
    expect(upload).toBeDefined();
    expect(post!.body.attachment_urls).toEqual(["http://api.test/v1/img/abc"]);
    expect(post!.body.message).toBe("here's the photo");
  });

  it("accept defaults to the latest pending SELLER offer and posts to its accept route", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (method === "GET" && url === `http://api.test/buyer/disputes/${DID}`) {
        return { status: 200, json: { dispute: { id: DID, status: "negotiating", offers: [
          { id: "off_new", offered_by: "seller", buyer_pct: 70, seller_pct: 30, accepted_at: null, rejected_at: null },
        ] } } };
      }
      if (method === "POST" && url === `http://api.test/buyer/disputes/${DID}/offers/off_new/accept`) {
        return { status: 200, json: { ok: true } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_disputes({ action: "accept", dispute_id: DID });
    const text = textOf(res);

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/offers/off_new/accept"))).toBe(true);
    expect(text).toMatch(/accepted/i);
  });

  it("counter validates that the split sums to 100 before calling the API", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { ok: true } }));

    const bad = await tools.firestarter_disputes({ action: "counter", dispute_id: DID, buyer_pct: 70, seller_pct: 40 });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(0); // never hit the API with an invalid split
    expect(textOf(bad)).toMatch(/equal 100/);

    const ok = await tools.firestarter_disputes({ action: "counter", dispute_id: DID, buyer_pct: 70, seller_pct: 30 });
    const counter = calls.find((c) => c.url.endsWith(`/${DID}/counter`));
    expect(counter!.body).toMatchObject({ buyer_pct: 70, seller_pct: 30 });
    expect(textOf(ok)).toMatch(/Counter-offer sent/i);
  });

  it("withdraw and escalate hit their buyer routes", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { ok: true } }));

    await tools.firestarter_disputes({ action: "withdraw", dispute_id: DID });
    await tools.firestarter_disputes({ action: "escalate", dispute_id: DID, reason: "no response" });

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`/${DID}/withdraw`))).toBe(true);
    const esc = calls.find((c) => c.url.endsWith(`/${DID}/escalate`));
    expect(esc).toBeDefined();
    expect(esc!.body).toMatchObject({ reason: "no response" });
  });

  // commerce#1030 — the copy after a withdrawal repeats what the API says it
  // did to the hold, instead of asserting "unfrozen" on faith.
  it("withdraw says the hold is unfrozen only when the API says so", async () => {
    const tools = captureTools();
    installFetch((method, url) =>
      method === "POST" && url.endsWith(`/${DID}/withdraw`)
        ? { status: 200, json: { ok: true, dispute: { id: DID, status: "closed" }, escrow_unfrozen: true } }
        : { status: 200, json: {} }
    );
    const res = await tools.firestarter_disputes({ action: "withdraw", dispute_id: DID });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/hold is unfrozen/i);
    expect(textOf(res)).toMatch(/new dispute can be opened/i);
  });

  it("withdraw does not claim the hold was thawed when the API says it was not", async () => {
    const tools = captureTools();
    installFetch((method, url) =>
      method === "POST" && url.endsWith(`/${DID}/withdraw`)
        ? { status: 200, json: { ok: true, dispute: { id: DID, status: "closed" }, escrow_unfrozen: false } }
        : { status: 200, json: {} }
    );
    const res = await tools.firestarter_disputes({ action: "withdraw", dispute_id: DID });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/NOT thawed/);
    expect(textOf(res)).not.toMatch(/hold is unfrozen/i);
  });

  it("withdraw stays neutral against an API that does not report the hold (pre-#1030 deploy)", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { ok: true } }));
    const res = await tools.firestarter_disputes({ action: "withdraw", dispute_id: DID });
    expect(textOf(res)).toMatch(/withdrawn/i);
    expect(textOf(res)).not.toMatch(/hold is unfrozen/i);
    expect(textOf(res)).not.toMatch(/NOT thawed/);
  });

  // commerce#1030 — a frozen hold is the OPPOSITE of a released one. The old
  // 409 listed both states in one sentence and an agent relayed "released".
  it("open on an already-frozen hold points at the existing dispute, not at an error", async () => {
    const tools = captureTools();
    installFetch((method, url) => {
      if (method === "GET" && url === "http://api.test/buyer/disputes") return { status: 200, json: { disputes: [] } };
      if (method === "POST" && url.endsWith(`/v1/executions/${EXEC}/dispute`)) {
        return {
          status: 409,
          json: {
            code: "HOLD_FROZEN",
            error: "This order's funds are already frozen for dispute disp_prior — view or respond to that dispute instead of opening a new one",
            status: 409,
            freeze_reason: "dispute:disp_prior",
            dispute_id: "disp_prior",
          },
        };
      }
      return { status: 200, json: {} };
    });
    const res = await tools.firestarter_disputes({ action: "open", execution_id: EXEC, reason: "never arrived" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/disp_prior/);
    expect(textOf(res)).toMatch(/already has a dispute/i);
    expect(textOf(res)).not.toMatch(/Error with disputes/);
    expect(textOf(res)).not.toMatch(/released/i);
  });

  it("surfaces an API error instead of claiming success", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 409, json: { code: "NOT_DISPUTABLE", error: "Execution is not in a disputable state" } }));

    const res = await tools.firestarter_disputes({ action: "open", execution_id: EXEC, reason: "x" });
    // open first calls GET /buyer/disputes (returns the 409 here too) — the point
    // is the tool never fabricates a success on a non-2xx.
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Error with disputes/i);
  });
});

describe("firestarter_status surfaces an active dispute", () => {
  it("renders a dispute banner (with the pending seller offer) instead of a plain status", async () => {
    const tools = captureTools();
    installFetch((method, url) => {
      if (method === "GET" && url === `http://api.test/v1/executions/${EXEC}`) {
        return { status: 200, json: {
          id: EXEC, status: "shipping", request_text: "Cat Food Can", options: [],
          active_dispute: {
            id: DID, status: "seller_responded", dispute_type: "not_received", reason: "Never arrived",
            pending_offer: { id: "off_1", offered_by: "seller", buyer_pct: 50, seller_pct: 50 },
          },
        } };
      }
      return { status: 200, json: {} };
    });

    const res = await tools.firestarter_status({ execution_id: EXEC });
    const text = textOf(res);

    // The whole point of the fix: a disputed order no longer reads as a plain
    // "shipping" — the dispute is impossible to miss and points at the buyer tool.
    expect(text).toMatch(/Dispute open/i);
    expect(text).toContain(DID);
    expect(text).toMatch(/50% refund to you/);
    expect(text).toMatch(/firestarter_disputes/);
  });
});
