/**
 * MCP Community-Market coverage.
 *
 * Validates the agent-side contract for community/listing-driven buying:
 * - firestarter_execute forwards pinned listing_id (cleaned from escaped text)
 * - pinned-listing failures surface clearly from API errors
 * - firestarter_listings detail path returns share-link rich text
 * - listing not found returns the guidance hint to list all IDs first
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function textOf(res: any): string {
  return (res?.content || []).map((b: any) => b.text || "").join("\n");
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP community-market flows", () => {
  it("firestarter_execute passes a cleaned pinned listing_id to /v1/executions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ method, url: String(url), body });

        if (method === "POST" && String(url).endsWith("/v1/executions")) {
          return jsonResponse(201, { id: "exec_cm_1", status: "finding" });
        }
        if (method === "GET" && String(url).endsWith("/v1/executions/exec_cm_1/poll")) {
          return jsonResponse(200, { status: "awaiting_approval", has_options: true });
        }
        if (method === "GET" && String(url).endsWith("/v1/executions/exec_cm_1")) {
          return jsonResponse(200, {
            id: "exec_cm_1",
            status: "awaiting_approval",
            request_text: "Buy pinned listing",
            options: [
              {
                id: "opt_1",
                product_title: "Pinned Item",
                supplier: "Firestarter Store",
                total: "12.00",
                match_score: 95,
                purchasable: true,
                metadata: { source: "firestarter_seller" },
              },
            ],
            steps: [],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );

    const tools = captureTools();
    const res = await tools.firestarter_execute({
      request: "Buy this exact listing",
      listing_id: "lst_qLcYasBq\\", // escaped slash from some chat surfaces
    });

    const create = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));
    expect(create?.body?.listing_id).toBe("lst_qLcYasBq");
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("Action needed");
  });

  it("firestarter_execute surfaces pinned listing errors as actionable failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "POST") {
          return jsonResponse(404, {
            error: "Pinned listing not found or no longer available",
            code: "NOT_FOUND",
          });
        }
        throw new Error("unexpected fetch in failure test");
      })
    );

    const tools = captureTools();
    const res = await tools.firestarter_execute({
      request: "Buy listing",
      listing_id: "lst_missing1",
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Pinned listing not found or no longer available");
  });

  it("firestarter_listings detail includes listing fields and share link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        fetchCalls.push({ method, url: String(url), body: undefined });
        if (method === "GET" && String(url).endsWith("/v1/listings/lst_market01")) {
          return jsonResponse(200, {
            id: "lst_market01",
            product_name: "Community Bottle",
            status: "active",
            current_price: "22.00",
            inventory_qty: 7,
            images: ["https://cdn.example.com/bottle.jpg"],
            created_at: "2026-06-30T10:00:00.000Z",
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );

    const tools = captureTools();
    const res = await tools.firestarter_listings({ listing_id: "lst_market01" });
    const text = textOf(res);

    expect(res.isError).toBeFalsy();
    expect(text).toContain("Community Bottle");
    expect(text).toContain("Share link: https://firestarter.network/l/lst_market01");
    expect(text).toContain("Image: https://cdn.example.com/bottle.jpg");
  });

  it("firestarter_listings not-found includes the list-all guidance hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, _init?: any) =>
        jsonResponse(404, {
          error: "listing not found",
          code: "NOT_FOUND",
        })
      )
    );

    const tools = captureTools();
    const res = await tools.firestarter_listings({ listing_id: "lst_nope999" });
    const text = textOf(res);

    expect(res.isError).toBe(true);
    expect(text).toContain("Error fetching listings: listing not found");
    expect(text).toContain("Call `firestarter_listings` with no arguments");
  });
});
