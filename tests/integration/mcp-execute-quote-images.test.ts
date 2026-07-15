/**
 * firestarter_execute (the QUOTE step) now embeds product images inline.
 *
 * The quote is the buyer's decision moment, but the tool used to pass
 * skipImages:true to formatExecution — shaving latency off the already-slow 45s
 * poll — so the product photo only appeared on the later approve/status calls.
 * The image pipeline, MCP transport and client rendering were all fine; the
 * quote simply omitted the base64 image block, so there was nothing to render.
 *
 * This pins the fix: the quote response now carries the same inline image block
 * approve/status already produced (bounded + parallel: <= MAX_EMBED_IMAGES,
 * IMAGE_FETCH_TIMEOUT_MS each).
 *
 * Harness mirrors mcp-inline-preview-images: real registered handlers via a fake
 * McpServer, global fetch mocked so image URLs return PNG bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    { tool: (n: string, _d: string, _s: any, h: ToolHandler) => { tools[n] = h; } } as any,
    "fs_test_key",
    "http://api.test",
  );
  return tools;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function imgResponse(): Response {
  return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
}
function json(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const imageBlocks = (res: any) => res.content.filter((b: any) => b.type === "image");
const textOf = (res: any) => res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

/** An execution in awaiting_approval with one purchasable, image-bearing option. */
function approvalExec() {
  return {
    id: "exec_qimg1",
    status: "awaiting_approval",
    request: "blue t-shirt by dom",
    options: [{
      id: "opt_1",
      product_title: "Blue T Shirt By Dom",
      product_url: "https://firestarter.network/l/lst_blue",
      total: 15.49, subtotal: 5.5, shipping_cost: 9.99, tax: 0,
      match_score: 100, purchasable: true,
      image_url: "https://img.test/blue-shirt.jpg",
      metadata: { source: "firestarter_seller", seller_id: "sel_1" },
    }],
  };
}

// firestarter_execute: POST /v1/executions -> {finding}, poll GET -> exec,
// and any image URL -> PNG bytes (this is the call the quote used to skip).
function installExecuteFetch(exec: any) {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method || "GET";
    if (method === "POST" && u.endsWith("/v1/executions")) return json(201, { id: exec.id, status: "finding" });
    if (method === "GET" && u.includes("/v1/executions/")) return json(200, exec);
    if (/^https:\/\/img\.test\//.test(u)) return imgResponse();
    throw new Error(`unexpected fetch: ${u}`);
  }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_execute — inline quote images", () => {
  it("returns a base64 image block for an option with a product image", async () => {
    installExecuteFetch(approvalExec());
    const res = await captureTools().firestarter_execute({ request: "blue t-shirt by dom" });

    const imgs = imageBlocks(res);
    expect(imgs.length).toBe(1);
    expect(imgs[0].mimeType).toBe("image/png");
    expect(typeof imgs[0].data).toBe("string");
    expect(imgs[0].data.length).toBeGreaterThan(0);
  });

  it("still carries the text/pricing block alongside the image (no markdown image)", async () => {
    installExecuteFetch(approvalExec());
    const res = await captureTools().firestarter_execute({ request: "blue t-shirt by dom" });

    const text = textOf(res);
    expect(text).toContain("Blue T Shirt By Dom");
    expect(text).not.toContain("!["); // image is a real block, not markdown in text
    expect(res.content.filter((b: any) => b.type === "text").length).toBeGreaterThan(0);
  });

  it("degrades gracefully when the image fetch fails — text still returns, no image block", async () => {
    const exec = approvalExec();
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (method === "POST" && u.endsWith("/v1/executions")) return json(201, { id: exec.id, status: "finding" });
      if (method === "GET" && u.includes("/v1/executions/")) return json(200, exec);
      if (/^https:\/\/img\.test\//.test(u)) return new Response("nope", { status: 404 });
      throw new Error(`unexpected fetch: ${u}`);
    }));

    const res = await captureTools().firestarter_execute({ request: "blue t-shirt by dom" });
    expect(imageBlocks(res).length).toBe(0);
    expect(textOf(res)).toContain("Blue T Shirt By Dom");
  });
});
