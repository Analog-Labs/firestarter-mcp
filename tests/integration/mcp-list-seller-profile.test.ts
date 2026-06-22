/**
 * firestarter_list / firestarter_import - NO_SELLER_PROFILE handling (issue #213).
 *
 * When a seller with no profile tries to list, the REST API returns 403 with
 * code NO_SELLER_PROFILE but a plain-sentence message. firestarter_list used to
 * match only the code token in the message, so it never fired its hint - the
 * agent got a bare "No active seller profile found." and looped (re-asking for
 * details / "ran into an issue"). The error must instead surface the
 * NO_SELLER_PROFILE token + route the agent to firestarter.network/sell.
 *
 * Same harness as mcp-import.test.ts: drive the REAL registered tool handlers
 * (captured via a fake McpServer) against a mocked global fetch.
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

/** Stub global fetch to return one fixed response. */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

// Mirrors errorResponse(c, 403, "NO_SELLER_PROFILE", "...") -> { error, code, status }.
const NO_SELLER_BODY = {
  error: "No active seller profile found. Register as a seller first.",
  code: "NO_SELLER_PROFILE",
  status: 403,
};

describe("firestarter_list NO_SELLER_PROFILE (issue #213)", () => {
  it("surfaces the code and routes to firestarter.network/sell instead of looping", async () => {
    installFetch(403, NO_SELLER_BODY);
    const tools = captureTools();

    const res = await tools.firestarter_list({ product_name: "Basketball", base_price: 5.29, inventory_qty: 5 });
    const text = textOf(res);

    expect(res.isError).toBe(true);
    // Machine-recognizable so the agent's skill can branch.
    expect(text).toContain("NO_SELLER_PROFILE");
    // Routed to the registration page, not the old "POST /v1/sellers".
    expect(text).toContain("firestarter.network/sell");
    expect(text).not.toContain("POST /v1/sellers");
    // Tells the agent it already has the details (kills the re-ask loop).
    expect(text.toLowerCase()).toContain("do not ask for them again");
  });

  it("does NOT add the seller hint on unrelated create errors", async () => {
    installFetch(400, { error: "base_price must be positive", code: "VALIDATION_ERROR", status: 400 });
    const tools = captureTools();

    const res = await tools.firestarter_list({ product_name: "Basketball", base_price: -1 });
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("base_price must be positive");
    expect(text).not.toContain("NO_SELLER_PROFILE");
    expect(text).not.toContain("firestarter_sell_link");
  });

  it("firestarter_import also routes NO_SELLER_PROFILE to firestarter.network/sell", async () => {
    installFetch(403, NO_SELLER_BODY);
    const tools = captureTools();

    const res = await tools.firestarter_import({ raw_text: "Basketball, $5.29, ships from Mumbai" });
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("NO_SELLER_PROFILE");
    expect(text).toContain("firestarter.network/sell");
  });
});
