/**
 * firestarter_assist_quote + firestarter_assist_book (B4 Phase 3 chat seam).
 *
 * Pins the renders that keep money safe in chat:
 *   - quote: cheapest-first list with quote_refs + the explicit
 *     get-a-human-YES-before-booking instruction; disabled and no-coverage
 *     renders never look like errors
 *   - book: success render carries the inspection-window next step; the
 *     expired-quote failure hints to re-quote and re-confirm
 *
 * Same harness as mcp-request-escrow.test.ts: real registered handlers via a
 * fake McpServer, mocked global fetch.
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

const QUOTE_ARGS = {
  pickup_address: "Siam Paragon, Bangkok",
  dropoff_address: "Central Ladprao, Bangkok",
  pickup_lat: 13.7462,
  pickup_lng: 100.5347,
  dropoff_lat: 13.7878,
  dropoff_lng: 100.6114,
  weight_kg: 60,
  bulky: true,
  two_person: true,
};

const TWO_QUOTES = {
  status: 200,
  json: {
    enabled: true,
    count: 2,
    quotes: [
      { provider: "lalamove", quote_ref: "llm_q1", fee_cents: 125500, currency: "THB", vehicle_class: "TRUCK175", includes_helper: true, eta_minutes: 38, insurance_available: false, liability_cap_cents: null, expires_at: "2099-01-01T00:05:00Z" },
      { provider: "nash", quote_ref: "ord_1:qot_1", fee_cents: 430000, currency: "THB", vehicle_class: "van", includes_helper: false, eta_minutes: 55, insurance_available: true, liability_cap_cents: null, expires_at: "2099-01-01T00:05:00Z" },
    ],
  },
};

describe("firestarter_assist_quote", () => {
  it("renders quotes cheapest-first with refs, crew label, and the human-confirm rule", async () => {
    const tools = captureTools();
    const calls = installFetch(() => TWO_QUOTES);

    const res = await tools.firestarter_assist_quote(QUOTE_ARGS);
    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    // Cheapest first, with the crew called out and refs usable for booking.
    expect(text.indexOf("lalamove")).toBeLessThan(text.indexOf("nash"));
    expect(text).toContain("1255.00 THB");
    expect(text).toContain("loading crew");
    expect(text).toContain("quote_ref: llm_q1");
    // The money rule: a human must say yes to the price before booking.
    expect(text).toMatch(/explicit YES before booking/i);
    expect(text).toContain("firestarter_assist_book");
    // Handling reached the API.
    expect(calls[0].url).toBe("http://api.test/v1/assist/quote");
    expect(calls[0].body.handling.two_person).toBe(true);
    expect(calls[0].body.pickup.lat).toBe(13.7462);
  });

  it("disabled workspace renders as a plain explanation, not an error", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { enabled: false, quotes: [] } }));
    const res = await tools.firestarter_assist_quote(QUOTE_ARGS);
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toMatch(/not enabled/i);
  });

  it("no coverage renders the arrange-it-themselves fallback", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { enabled: true, count: 0, quotes: [] } }));
    const res = await tools.firestarter_assist_quote(QUOTE_ARGS);
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toMatch(/no courier could quote|arrange the handoff themselves/i);
  });
});

describe("firestarter_assist_book", () => {
  const BOOK_ARGS = {
    provider: "lalamove",
    quote_ref: "llm_q1",
    pickup_address: "Siam Paragon, Bangkok",
    dropoff_address: "Central Ladprao, Bangkok",
    pickup_contact_phone: "+6611",
    dropoff_contact_phone: "+6622",
    execution_id: "exec_buy1",
    fee_cents: 125500,
  };

  it("renders the booking with tracking and the inspection-window next step", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({
      status: 201,
      json: {
        id: "asb_1",
        provider: "lalamove",
        provider_ref: "llm_order_9",
        status: "booked",
        tracking_url: "https://track/x",
        next_step: "The courier's proof of delivery will start the escrow inspection window automatically.",
      },
    }));
    const res = await tools.firestarter_assist_book(BOOK_ARGS);
    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    expect(text).toContain("asb_1");
    expect(text).toContain("https://track/x");
    expect(text).toMatch(/inspection window/i);
    expect(calls[0].body.execution_id).toBe("exec_buy1");
    expect(calls[0].body.fee_cents).toBe(125500);
  });

  it("an expired quote hints to re-quote and re-confirm with the human", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 502,
      json: { error: "The courier could not book this job: quotation expired", code: "BOOKING_FAILED", status: 502 },
    }));
    const res = await tools.firestarter_assist_book(BOOK_ARGS);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/quote may have expired/i);
    expect(text).toMatch(/re-confirm with the human/i);
  });
});
