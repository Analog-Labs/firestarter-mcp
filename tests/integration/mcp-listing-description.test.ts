/**
 * "Product descriptions not saving" (live report, 2026-08-27) — the e2e found
 * the API stores descriptions fine and update_listing persists them; the LOSS
 * happened at creation: firestarter_list declared NO description parameter, so
 * a description the agent wrote (the "create a description for me" flow) had
 * nowhere to go and silently vanished unless the agent remembered a separate
 * update call. These pin the closed loop: the param exists, it reaches the
 * API create body, the create response ECHOES it, and the structured owner
 * rows carry it so "did it save?" is answerable.
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
  registerTools(fakeServer as any, "fs_test_descriptions", "http://api.test");
  return tools;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function text(res: any): string {
  return (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

const DESC = "Wake up to the highlands of Thailand in every cup.";

describe("firestarter_list forwards and echoes the description", () => {
  it("sends description in the create body", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return json({ id: "lst_d1", product_name: "Thai Roast", base_price: 2.1, current_price: 2.1,
        status: "active", description: DESC, test_mode: false, environment: "live",
        share_url: "https://firestarter.network/l/lst_d1", images: [] }, 201);
    }));
    const res = await captureTools().firestarter_list({ product_name: "Thai Roast", base_price: 2.1, description: DESC });

    expect(bodies[0].description).toBe(DESC);
    // The response proves it stuck — a description living only in chat text
    // is exactly the bug this closes.
    expect(text(res)).toContain("Description: Wake up to the highlands");
  });

  it("a long description is echoed truncated, never dropped", async () => {
    const long = "A".repeat(400);
    vi.stubGlobal("fetch", vi.fn(async () => json({
      id: "lst_d2", product_name: "X", base_price: 1, current_price: 1, status: "active",
      description: long, test_mode: false, environment: "live",
      share_url: "https://firestarter.network/l/lst_d2", images: [] }, 201)));
    const out = text(await captureTools().firestarter_list({ product_name: "X", base_price: 1, description: long }));

    expect(out).toContain("Description: " + "A".repeat(160) + "…");
  });
});

describe("owner listings carry the description in structuredContent", () => {
  it("list rows expose description (null-safe)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ listings: [
      { id: "lst_a", product_name: "With Desc", description: DESC, current_price: 5, currency: "USD",
        status: "active", inventory_qty: 1, created_at: "2026-08-27T00:00:00.000Z", share_url: null, images: [] },
      { id: "lst_b", product_name: "Without", current_price: 3, currency: "USD",
        status: "draft", inventory_qty: 0, created_at: "2026-08-27T00:00:00.000Z", share_url: null, images: [] },
    ]})));
    const res = await captureTools().firestarter_listings({});

    expect(res.structuredContent.listings[0].description).toBe(DESC);
    expect(res.structuredContent.listings[1].description).toBeNull();
  });
});
