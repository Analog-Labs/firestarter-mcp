/**
 * firestarter_register_seller — MCP tool for seller self-registration.
 *
 * Validates:
 * - Successful registration returns seller profile with ID and status
 * - Idempotent: already-registered sellers get their existing profile (no error)
 * - Error surfacing for unexpected failures
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

function installFetch(status: number, json: any) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(json), {
          status,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
}

/** Multi-response fetch: returns responses in sequence. */
function installFetchSequence(responses: Array<{ status: number; json: any }>) {
  let callIdx = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const r = responses[callIdx] || responses[responses.length - 1];
      callIdx++;
      return new Response(JSON.stringify(r.json), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

describe("firestarter_register_seller", () => {
  it("registers a new seller and returns profile details", async () => {
    installFetch(201, {
      id: "sel_abc12345",
      org_id: "org_test123",
      business_name: "Tania's Art Studio",
      type: "retailer",
      fulfillment: {},
      status: "active",
      created_at: "2026-07-02T10:00:00.000Z",
    });
    const tools = captureTools();

    const res = await tools.firestarter_register_seller({ business_name: "Tania's Art Studio" });
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    expect(text).toContain("Seller profile created");
    expect(text).toContain("sel_abc12345");
    expect(text).toContain("Tania's Art Studio");
    expect(text).toContain("retailer");
    expect(text).toContain("active");
    expect(text).toContain("firestarter_list");
    expect(text).toContain("firestarter_import");
    expect(text).toContain("firestarter_connect_shopify");
  });

  it("passes seller type when specified", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        id: "sel_xyz99999",
        org_id: "org_test123",
        business_name: "Bulk Supplies Co",
        type: "wholesaler",
        fulfillment: {},
        status: "active",
        created_at: "2026-07-02T10:00:00.000Z",
      }), { status: 201, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const tools = captureTools();

    const res = await tools.firestarter_register_seller({ business_name: "Bulk Supplies Co", type: "wholesaler" });
    const text = textOf(res);

    expect(res.isError).toBeUndefined();
    expect(text).toContain("wholesaler");
    // Verify the API was called with the type in the body
    const callBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(callBody.type).toBe("wholesaler");
  });

  it("handles SELLER_EXISTS idempotently (returns existing profile)", async () => {
    // First call returns 409 SELLER_EXISTS, second call fetches existing profile
    installFetchSequence([
      { status: 409, json: { error: "Seller profile already exists for this organization", code: "SELLER_EXISTS", status: 409 } },
      { status: 200, json: { id: "sel_existing1", org_id: "org_test123", business_name: "Already Here Store", type: "retailer", status: "active" } },
    ]);
    const tools = captureTools();

    const res = await tools.firestarter_register_seller({ business_name: "Already Here Store" });
    const text = textOf(res);

    // Should NOT be an error - idempotent success
    expect(res.isError).toBeUndefined();
    expect(text).toContain("Already registered as a seller");
    expect(text).toContain("sel_existing1");
    expect(text).toContain("firestarter_list");
  });

  it("surfaces unexpected errors without crashing", async () => {
    installFetch(500, { error: "Internal server error", code: "INTERNAL_ERROR", status: 500 });
    const tools = captureTools();

    const res = await tools.firestarter_register_seller({ business_name: "Failing Store" });
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("Error registering seller");
    expect(text).toContain("Internal server error");
  });
});
