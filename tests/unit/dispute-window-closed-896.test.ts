/**
 * #896 — a closed dispute window is a business rule, not a failure.
 *
 * Reported via the Claude connector (Durga Singh): a buyer tried to dispute an
 * order whose escrow had already been released. The agent rendered a red
 * **Failed** — and then, underneath it, the correct advice (contact the seller,
 * chargeback through the bank, Firestarter support). So the tool already knew
 * the right answer; it just presented it as a system error.
 *
 * Two halves, and only the second is in this repo:
 *   1. commerce classified ALREADY_RELEASED as HTTP 400 ("your request was
 *      malformed") because disputeHttpStatus had no case for it. Fixed there.
 *   2. this tool catches every non-2xx into one `isError: true` block, so even
 *      a correct 409 would still have rendered red. Fixed here.
 *
 * The distinction matters to a buyer: "we couldn't process that" invites a
 * retry that can never work, while "the window closed, here is what to do
 * instead" is actionable.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; },
  };
  registerTools(fakeServer as any, "fs_test_896", "http://api.test");
  return tools;
}

const text = (res: any): string =>
  (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

/** No open dispute on the order, then the POST fails with `body`. */
function stubOpenAttempt(body: unknown, status: number) {
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    const href = String(url);
    if (href.includes("/buyer/disputes")) {
      return new Response(JSON.stringify({ disputes: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
}

const openDispute = () =>
  captureTools().firestarter_disputes({
    action: "open",
    execution_id: "exec_QjrzpvnW",
    reason: "wrong product delivered",
    type: "wrong_item",
  });

afterEach(() => vi.unstubAllGlobals());

describe("escrow already released", () => {
  const RELEASED = {
    error: "Escrow funds have already been released to the seller",
    code: "ALREADY_RELEASED",
  };

  it("is NOT reported as an error", async () => {
    stubOpenAttempt(RELEASED, 409);
    const res = await openDispute();
    expect(res.isError).toBeFalsy();
  });

  it("says the window closed, in words a buyer can act on", async () => {
    stubOpenAttempt(RELEASED, 409);
    const t = await openDispute().then(text);
    expect(t.toLowerCase()).toContain("window");
    expect(t).not.toMatch(/^Error with disputes/);
  });

  it("names the routes that still exist instead of dead-ending", async () => {
    stubOpenAttempt(RELEASED, 409);
    const t = (await openDispute().then(text)).toLowerCase();
    expect(t).toContain("seller");
    expect(t).toContain("bank");
    expect(t).toContain("support");
  });

  it("still relays the provider's own reason", async () => {
    stubOpenAttempt(RELEASED, 409);
    expect(await openDispute().then(text)).toContain("already been released");
  });
});

describe("the sibling terminal states behave the same way", () => {
  it.each([
    ["ALREADY_REFUNDED", "This order has already been refunded"],
    ["ALREADY_RESOLVED", "This dispute has already been resolved"],
  ])("%s is informational, not an error", async (code, message) => {
    stubOpenAttempt({ error: message, code }, 409);
    const res = await openDispute();
    expect(res.isError).toBeFalsy();
  });
});

describe("real failures still read as failures", () => {
  it("a 500 stays an error", async () => {
    stubOpenAttempt({ error: "upstream exploded", code: "INTERNAL" }, 500);
    const res = await openDispute();
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("upstream exploded");
  });

  it("a genuinely malformed request stays an error", async () => {
    // INVALID_SPLIT is still a 400 in commerce, deliberately: the caller can
    // fix it by sending something different. That must not be softened.
    stubOpenAttempt({ error: "buyer_pct + seller_pct must equal 100", code: "INVALID_SPLIT" }, 400);
    const res = await openDispute();
    expect(res.isError).toBe(true);
  });

  it("an unknown order stays an error", async () => {
    stubOpenAttempt({ error: "Execution not found or not owned by this organization", code: "EXECUTION_NOT_FOUND" }, 404);
    const res = await openDispute();
    expect(res.isError).toBe(true);
  });
});
