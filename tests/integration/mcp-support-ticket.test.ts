/**
 * firestarter_support_ticket (commerce#1110): the agent can open a ticket a
 * human at Firestarter reads, instead of drafting an email for the person to
 * send. Same fake-McpServer + mocked-fetch harness as the other tool tests.
 *
 * Pinned:
 *  - create posts the person's message (+ subject / order_id when given) to
 *    /v1/support/tickets and reports the ticket id back;
 *  - create without a message is refused BEFORE any request;
 *  - ORDER_NOT_FOUND from the API is turned into a usable next step;
 *  - list and get read the account's tickets / one thread, and say plainly
 *    when support has not replied yet;
 *  - the description routes delivered-order problems to firestarter_disputes
 *    first and forbids the "draft an email" fallback — the two behaviours the
 *    ticket was filed about.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): { tools: Record<string, ToolHandler>; descriptions: Record<string, string> } {
  const tools: Record<string, ToolHandler> = {};
  const descriptions: Record<string, string> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
      const desc = rest.find((r) => typeof r === "string");
      if (typeof desc === "string") descriptions[name] = desc;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return { tools, descriptions };
}

function installFetch(status: number, json: any) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): { url: string; method: string; body: any } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: String(url), method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : null };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_support_ticket", () => {
  it("is registered, routes delivered-order problems to disputes first, and forbids the email fallback", () => {
    const { tools, descriptions } = captureTools();
    expect(tools.firestarter_support_ticket).toBeTypeOf("function");
    const d = descriptions.firestarter_support_ticket;
    expect(d).toMatch(/firestarter_disputes FIRST/);
    expect(d).toMatch(/Never draft an email/i);
    expect(d).toMatch(/order_id/);
  });

  it("create: posts the person's words, subject and order to /v1/support/tickets and reports the id", async () => {
    const fetchMock = installFetch(201, { id: "tkt_abc12345", status: "open", subject: "Wrong item delivered", order_id: "exec_p1yXbCjL" });
    const res = await captureTools().tools.firestarter_support_ticket({
      message: "I ordered a bow and arrow toy and received socks.",
      subject: "Wrong item delivered",
      order_id: "exec_p1yXbCjL",
    });
    expect(res.isError).toBeFalsy();
    const req = lastRequest(fetchMock);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://api.test/v1/support/tickets");
    expect(req.body).toEqual({
      message: "I ordered a bow and arrow toy and received socks.",
      subject: "Wrong item delivered",
      order_id: "exec_p1yXbCjL",
    });
    const text = textOf(res);
    expect(text).toContain("tkt_abc12345");
    expect(text).toContain("exec_p1yXbCjL");
    expect(text).toMatch(/action 'get'/);
  });

  it("create: refuses an empty message before making any request", async () => {
    const fetchMock = installFetch(201, { id: "tkt_never" });
    const res = await captureTools().tools.firestarter_support_ticket({ message: "   " });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/message is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create: turns ORDER_NOT_FOUND into a next step instead of a bare error", async () => {
    installFetch(404, { error: "Order exec_nope was not found on this account.", code: "ORDER_NOT_FOUND", status: 404 });
    const res = await captureTools().tools.firestarter_support_ticket({ message: "Where is my order?", order_id: "exec_nope" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("exec_nope");
    expect(text).toMatch(/firestarter_purchases|without order_id/);
  });

  it("list: reads this account's tickets and says whether support has replied", async () => {
    const fetchMock = installFetch(200, {
      tickets: [
        { id: "tkt_a1", status: "open", subject: "Payout pending", tags: ["agent"], created_at: "2026-09-08T00:00:00Z", last_support_reply_at: null },
        { id: "tkt_b2", status: "open", subject: "Wrong item", tags: ["agent", "order:exec_p1yXbCjL"], created_at: "2026-09-07T00:00:00Z", last_support_reply_at: "2026-09-07T05:00:00Z" },
      ],
    });
    const res = await captureTools().tools.firestarter_support_ticket({ action: "list" });
    expect(res.isError).toBeFalsy();
    expect(lastRequest(fetchMock).url).toBe("http://api.test/v1/support/tickets");
    const text = textOf(res);
    expect(text).toContain("tkt_a1");
    expect(text).toMatch(/no reply from support yet/);
    expect(text).toContain("exec_p1yXbCjL");
    expect(text).toMatch(/support replied 2026-09-07T05:00:00Z/);
  });

  it("list: an empty account points at create", async () => {
    installFetch(200, { tickets: [] });
    const text = textOf(await captureTools().tools.firestarter_support_ticket({ action: "list" }));
    expect(text).toMatch(/No support tickets/);
    expect(text).toMatch(/action 'create'/);
  });

  it("get: renders the thread and flags a ticket support has not answered", async () => {
    const fetchMock = installFetch(200, {
      id: "tkt_a1", status: "open", subject: "Payout pending",
      messages: [{ id: "m1", sender_type: "user", content: "Payout pending two weeks", attachment_url: null, created_at: "2026-09-08T00:00:00Z" }],
    });
    const res = await captureTools().tools.firestarter_support_ticket({ action: "get", ticket_id: "tkt_a1" });
    expect(res.isError).toBeFalsy();
    expect(lastRequest(fetchMock).url).toBe("http://api.test/v1/support/tickets/tkt_a1");
    const text = textOf(res);
    expect(text).toContain("Payout pending two weeks");
    expect(text).toMatch(/Support has not replied yet/);
  });

  it("get: shows support's reply as such and drops the not-answered note", async () => {
    installFetch(200, {
      id: "tkt_a1", status: "open", subject: "Payout pending",
      messages: [
        { id: "m1", sender_type: "user", content: "Payout pending", attachment_url: null, created_at: "2026-09-08T00:00:00Z" },
        { id: "m2", sender_type: "support", content: "We have released it.", attachment_url: null, created_at: "2026-09-08T01:00:00Z" },
      ],
    });
    const text = textOf(await captureTools().tools.firestarter_support_ticket({ action: "get", ticket_id: "tkt_a1" }));
    expect(text).toMatch(/Firestarter support: We have released it\./);
    expect(text).not.toMatch(/Support has not replied yet/);
  });

  it("get: requires a ticket_id and makes no request without one", async () => {
    const fetchMock = installFetch(200, {});
    const res = await captureTools().tools.firestarter_support_ticket({ action: "get" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/ticket_id is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
