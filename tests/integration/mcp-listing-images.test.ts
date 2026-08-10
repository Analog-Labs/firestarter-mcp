/**
 * firestarter_list / firestarter_update_listing image_urls support.
 *
 * Bug: a seller sends a photo in chat ("sell this for me"), the gateway hosts
 * it and hands the agent an [image attached: <url>] marker — but the MCP tools
 * had NO way to put that URL on the listing, so every chat-created listing went
 * up imageless and the agent fell back to "re-send the photo" (which also
 * couldn't work). The POST/PATCH /v1/listings routes already accept `images`;
 * these tests pin that the tools now forward image_urls -> body.images.
 *
 * Same harness as mcp-approve-option.test.ts: real registered handlers via a
 * fake McpServer against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

let fetchCalls: Array<{ method: string; url: string; body: any }>;

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ method, url: String(url), body });
      if (method === "POST" && String(url).endsWith("/v1/listings")) {
        return jsonResponse(201, { id: "lst_new1", product_name: body.product_name, base_price: body.base_price, status: "active", images: body.images || [] });
      }
      if (method === "PATCH" && String(url).includes("/v1/listings/")) {
        return jsonResponse(200, { id: "lst_new1", product_name: "X", status: "active", images: body.images ?? [] });
      }
      if (method === "GET" && /\/v1\/listings\/lst_/.test(String(url))) {
        const id = String(url).split("/v1/listings/")[1];
        const images =
          id === "lst_multi"
            ? ["https://img.test/1.jpg", "https://img.test/2.jpg", "https://img.test/3.jpg"]
            : id === "lst_none"
              ? []
              : ["https://img.test/only.jpg"];
        return jsonResponse(200, { id, product_name: "Sample", current_price: 5, base_price: 5, status: "active", images });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    })
  );
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_list / update — image_urls", () => {
  it("forwards image_urls to the create body as images", async () => {
    installFetch();
    const tools = captureTools();
    const url = "https://cole.pocodot.ai/api/poco/uploads/public/abc123";

    const res = await tools.firestarter_list({ product_name: "MX Master 3S", base_price: 40, image_urls: [url] });

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect(post?.body.images).toEqual([url]);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/1 attached/);
  });

  it("omits images when no image_urls given (back-compat)", async () => {
    installFetch();
    const tools = captureTools();

    await tools.firestarter_list({ product_name: "No Photo Item", base_price: 10 });

    const post = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/listings"));
    expect("images" in (post?.body ?? {})).toBe(false);
  });

  it("forwards image_urls to the update body as images (attach photo to existing listing)", async () => {
    installFetch();
    const tools = captureTools();
    const url = "https://cole.pocodot.ai/api/poco/uploads/public/def456";

    const res = await tools.firestarter_update_listing({ listing_id: "lst_new1", image_urls: [url] });

    const patch = fetchCalls.find((c) => c.method === "PATCH");
    expect(patch?.body.images).toEqual([url]);
    expect(res.isError).toBeFalsy();
  });
});

describe("firestarter_listings — image URL output (so the agent can post photos to chat)", () => {
  it("lists EVERY image URL for a multi-photo listing, not just the first", async () => {
    installFetch();
    const tools = captureTools();

    const res = await tools.firestarter_listings({ listing_id: "lst_multi" });
    const text = res.content[0].text as string;

    expect(text).toContain("Images (3):");
    expect(text).toContain("https://img.test/1.jpg");
    expect(text).toContain("https://img.test/2.jpg");
    expect(text).toContain("https://img.test/3.jpg");
    // No lossy "(+N more)" truncation — the agent needs every URL to send each photo.
    expect(text).not.toMatch(/more\)/);
  });

  it("shows the single image URL for a one-photo listing", async () => {
    installFetch();
    const tools = captureTools();

    const res = await tools.firestarter_listings({ listing_id: "lst_one" });
    const text = res.content[0].text as string;

    expect(text).toContain("Image: https://img.test/only.jpg");
    expect(text).not.toContain("Images (");
  });
});

/**
 * #611: the agent couldn't render listing photos because firestarter_listings
 * emitted only a bare image URL, and the seller's legacy URL resolved to an
 * HTML SPA shell (200) rather than image bytes. The detail path now embeds the
 * photos as MCP image blocks (fetched + validated server-side), so any client
 * renders them inline. fetchImageAsBase64 must skip non-image responses so a
 * bad URL never poisons the whole tool response.
 */
describe("firestarter_listings — inline image embedding (#611)", () => {
  // Minimal JPEG SOI + APP0 marker (FF D8 FF E0 ...): valid magic bytes.
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  function installFetchEmbedding(imageResponder: (url: string) => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        const u = String(url);
        if (method === "GET" && /\/v1\/listings\/lst_/.test(u)) {
          const id = u.split("/v1/listings/")[1];
          const images =
            id === "lst_multi"
              ? ["https://img.test/1.jpg", "https://img.test/2.jpg", "https://img.test/3.jpg"]
              : id === "lst_none"
                ? []
                : ["https://img.test/only.jpg"];
          return jsonResponse(200, { id, product_name: "Sample", current_price: 5, base_price: 5, status: "active", images });
        }
        if (/^https:\/\/img\.test\//.test(u)) return imageResponder(u);
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
  }

  it("embeds the product photo as an MCP image block when the URL returns a real image", async () => {
    installFetchEmbedding(() => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": String(JPEG.length) } }));
    const tools = captureTools();

    const res = await tools.firestarter_listings({ listing_id: "lst_one" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe("text");
    const images = res.content.filter((b: any) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/jpeg");
    expect(typeof images[0].data).toBe("string");
    expect(images[0].data.length).toBeGreaterThan(0);
  });

  it("caps embedded images at MAX_EMBED_IMAGES (3) and keeps every URL in the text block", async () => {
    installFetchEmbedding(() => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    const tools = captureTools();

    const res = await tools.firestarter_listings({ listing_id: "lst_multi" });

    expect(res.content.filter((b: any) => b.type === "image")).toHaveLength(3);
    expect(res.content[0].text).toContain("https://img.test/1.jpg");
    expect(res.content[0].text).toContain("https://img.test/3.jpg");
  });

  it("silently skips a URL that returns an HTML page with 200 (the #611 bug) without erroring", async () => {
    installFetchEmbedding(() => new Response("<!doctype html><html><body>SPA shell</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const tools = captureTools();

    const res = await tools.firestarter_listings({ listing_id: "lst_one" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Image: https://img.test/only.jpg");
    expect(res.content.filter((b: any) => b.type === "image")).toHaveLength(0);
  });
});

/**
 * #611: the buyer-facing browse tool now surfaces the first product image URL
 * on each result line, so chat clients auto-unfurl a preview and agents have a
 * fetchable, CORS-open image URL instead of only a share link.
 */
describe("firestarter_catalog_search — surfaces image URL (#611)", () => {
  it("includes the first image URL on the result line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "GET" && String(url).includes("/v1/listings/catalog")) {
          return jsonResponse(200, {
            query: { environment: "live" },
            has_more: false,
            listings: [
              {
                id: "lst_x",
                product_name: "Widget",
                current_price: 9.5,
                currency: "USD",
                buyable: true,
                category: "Gadgets",
                share_url: "https://firestarter.network/l/lst_x",
                images: ["https://api.firestarter.network/v1/img/abc"],
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();

    const res = await tools.firestarter_catalog_search({ query: "widget" });
    const text = res.content[0].text as string;

    expect(text).toContain("https://api.firestarter.network/v1/img/abc");
    expect(text).toContain("lst_x");
  });
});

/**
 * QA report, 2026-08-10 (TEST sandbox): every catalog_search result rendered
 * `id: lst_xxx · null` — reproduced across 11 listings in 4 searches. Root
 * cause: publicShareUrl() (services/listing-create.ts) deliberately returns
 * `null` for a test-mode listing, and the API's /v1/listings/catalog route
 * passes that straight through as `share_url: null` — correct, matches
 * firestarter_listings' own "sandbox-only, no public link" handling. But this
 * tool's result-line template interpolated `l.share_url` unconditionally, so
 * a null share_url rendered as the literal text "null" instead of anything
 * meaningful. Only reproduces in test mode, since a live/active listing's
 * share_url is never null.
 */
describe("firestarter_catalog_search — test-mode listing has no share_url (2026-08-10)", () => {
  it("does not render the literal string 'null' when share_url is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const method = init?.method || "GET";
        if (method === "GET" && String(url).includes("/v1/listings/catalog")) {
          return jsonResponse(200, {
            query: { environment: "test" },
            has_more: false,
            listings: [
              {
                id: "lst_VVn0NGeb",
                product_name: "Ceramic Mug",
                current_price: 12,
                currency: "USD",
                buyable: false,
                category: "Home",
                share_url: null,
                images: [],
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      })
    );
    const tools = captureTools();

    const res = await tools.firestarter_catalog_search({ query: "ceramic mug" });
    const text = res.content[0].text as string;

    expect(text).toContain("lst_VVn0NGeb");
    expect(text).not.toMatch(/·\s*null\b/);
    expect(text).toContain("sandbox");
  });
});
