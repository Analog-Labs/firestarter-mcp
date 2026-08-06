/**
 * firestarter_preview / firestarter_catalog_search — inline product images.
 *
 * These buyer-facing browse tools returned image URLs only, so MCP clients
 * (Claude/Cursor/Copilot) couldn't render product photos inline. They now embed
 * up to MAX_EMBED_IMAGES base64 image blocks alongside the text (via the shared
 * fetchImageAsBase64 path), while keeping the URLs in text/structuredContent so
 * chat clients that unfurl links still work.
 *
 * Harness mirrors mcp-listing-images / mcp-buyer-confirmation: drive the REAL
 * registered handlers (captured via a fake McpServer) against a mocked global
 * fetch, where image URLs return valid PNG bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    { tool: (n: string, ...rest: any[]) => { tools[n] = rest[rest.length - 1] as ToolHandler; } } as any,
    "fs_test_key",
    "http://api.test",
  );
  return tools;
}

// 8-byte PNG signature — enough for fetchImageAsBase64's magic-byte sniff.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function imgResponse(): Response {
  return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
}
function json(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function imageBlocks(res: any) {
  return res.content.filter((b: any) => b.type === "image");
}
function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes("/commerce/preview")) {
      return json(200, {
        query: "clock",
        options: [
          { title: "Wall Clock A", price: 20, purchasable: true, eligible: true, image_url: "https://img.test/a.jpg" },
          { title: "Wall Clock B", price: 30, purchasable: true, eligible: true, image_url: "https://img.test/b.jpg" },
          { title: "Wall Clock C", price: 40, purchasable: true, eligible: true, image_url: "https://img.test/c.jpg" },
          { title: "Wall Clock D", price: 50, purchasable: true, eligible: true, image_url: "https://img.test/d.jpg" },
        ],
        page: { limit: 10, next_cursor: null, has_more: false },
        context: {},
      });
    }
    if (u.includes("/v1/listings/catalog")) {
      return json(200, {
        listings: [
          { id: "lst_1", product_name: "Wall Clock", current_price: 20, currency: "USD", buyable: true, images: ["https://img.test/w1.jpg"], share_url: "https://firestarter.network/l/lst_1" },
          { id: "lst_2", product_name: "Desk Clock", current_price: 30, currency: "USD", buyable: true, images: ["https://img.test/w2.jpg"], share_url: "https://firestarter.network/l/lst_2" },
        ],
        query: { environment: "test" },
      });
    }
    if (/^https:\/\/img\.test\//.test(u)) return imgResponse();
    throw new Error(`unexpected fetch: ${u}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_preview — inline images", () => {
  it("embeds up to MAX_EMBED_IMAGES (3) base64 image blocks plus the text block", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_preview({ query: "clock" });

    const imgs = imageBlocks(res);
    // 4 options but capped at 3 inline images.
    expect(imgs.length).toBe(3);
    for (const b of imgs) {
      expect(b.mimeType).toBe("image/png");
      expect(typeof b.data).toBe("string");
      expect(b.data.length).toBeGreaterThan(0);
    }
    // Text block still present, structured output untouched.
    expect(textOf(res)).toContain("Wall Clock A");
    expect(res.structuredContent).toBeTruthy();
  });

  it("returns text-only when options have no images (back-compat)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/commerce/preview")) {
        return json(200, {
          query: "x",
          options: [{ title: "No Photo", price: 5, purchasable: true, eligible: true, image_url: null }],
          page: { limit: 10, next_cursor: null, has_more: false },
          context: {},
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }));
    const tools = captureTools();
    const res = await tools.firestarter_preview({ query: "x" });

    expect(imageBlocks(res).length).toBe(0);
    expect(res.content.every((b: any) => b.type === "text")).toBe(true);
  });

  it("does not fail the response when an image fetch errors (silently drops it)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/commerce/preview")) {
        return json(200, {
          query: "clock",
          options: [{ title: "Broken Img", price: 9, purchasable: true, eligible: true, image_url: "https://img.test/broken.jpg" }],
          page: { limit: 10, next_cursor: null, has_more: false },
          context: {},
        });
      }
      if (/^https:\/\/img\.test\//.test(u)) return new Response("not an image", { status: 500 });
      throw new Error(`unexpected fetch: ${u}`);
    }));
    const tools = captureTools();
    const res = await tools.firestarter_preview({ query: "clock" });

    expect(res.isError).toBeFalsy();
    expect(imageBlocks(res).length).toBe(0);
    expect(textOf(res)).toContain("Broken Img");
  });
});

describe("firestarter_catalog_search — inline images", () => {
  it("embeds a base64 image block per listing's first photo, keeping URLs in text", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ q: "clock" });

    const imgs = imageBlocks(res);
    expect(imgs.length).toBe(2);
    expect(imgs[0].mimeType).toBe("image/png");

    const text = textOf(res);
    expect(text).toContain("Wall Clock");
    // URL stays in the text so chat clients still auto-unfurl.
    expect(text).toContain("https://img.test/w1.jpg");
  });
});
