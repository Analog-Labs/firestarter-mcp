import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer as any, "fs_test_share_contract", "http://api.test");
  return tools;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("listing share-link output (#231/#232)", () => {
  it("does not invent a live URL for a newly-created sandbox listing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      id: "lst_sandbox_-",
      product_name: "Sandbox item",
      base_price: 12,
      current_price: 12,
      status: "active",
      test_mode: true,
      environment: "test",
      share_url: null,
      images: [],
    }, 201)));

    const result = await captureTools().firestarter_list({ product_name: "Sandbox item", base_price: 12 });
    const text = result.content[0].text as string;

    expect(text).toContain("Sandbox-only listing");
    expect(text).not.toContain("https://firestarter.network/l/");
  });

  it("emits an API-provided live URL bare and without Markdown escapes", async () => {
    const shareUrl = "https://firestarter.network/l/lst_8lKpBt_-";
    vi.stubGlobal("fetch", vi.fn(async () => json({
      id: "lst_8lKpBt_-",
      product_name: "Entrance gate",
      base_price: 99,
      current_price: 99,
      status: "active",
      test_mode: false,
      environment: "live",
      share_url: shareUrl,
      images: [],
    }, 201)));

    const result = await captureTools().firestarter_list({ product_name: "Entrance gate", base_price: 99 });
    const text = result.content[0].text as string;

    expect(text).toContain(`Share link: ${shareUrl}`);
    expect(text).not.toContain("\\\\_");
    expect(text).not.toContain("\\\\-");
  });

  it("labels sandbox owner detail without returning a dead public URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).includes("/v1/listings/lst_sandbox_-")) {
        return json({
          id: "lst_sandbox_-",
          product_name: "Sandbox detail",
          base_price: 8,
          current_price: 8,
          status: "active",
          test_mode: true,
          environment: "test",
          share_url: null,
          images: [],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const result = await captureTools().firestarter_listings({ listing_id: "lst_sandbox_-" });
    const text = result.content[0].text as string;

    expect(text).toContain("Environment: sandbox");
    expect(text).toContain("No public share link");
    expect(text).not.toContain("https://firestarter.network/l/");
  });
});
