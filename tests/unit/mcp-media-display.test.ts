/**
 * What an agent actually receives for a product's media.
 *
 * Two gaps this pins:
 *
 *  1. firestarter_product — the "show me this product" zoom-in — listed photo
 *     URLs but never called inlineImageBlocks, so it was the ONE image surface
 *     that handed a text-only host bare URLs instead of pictures. Preview,
 *     catalog and listings all inline.
 *  2. Video existed nowhere in any MCP shape, so a listing with a clip looked
 *     identical to one without.
 *
 * D11: the widget shows a poster and a play chip that links out — no inline
 * playback. It runs in a sandboxed iframe inside someone else's chat client;
 * autoplaying a 25MB seller-supplied file there is not ours to decide.
 */
import { describe, it, expect } from "vitest";
import { safeVideos, videoLines } from "../../src/mcp/media.js";

const V = [
  { url: "https://a/clip.mp4", poster_url: "https://a/p.jpg" },
  { url: "https://a/two.webm" },
];

describe("safeVideos", () => {
  it("keeps https entries with url + poster only", () => {
    expect(safeVideos(V)).toEqual([
      { url: "https://a/clip.mp4", poster_url: "https://a/p.jpg" },
      { url: "https://a/two.webm", poster_url: null },
    ]);
  });

  it("drops non-https, javascript: and data: urls", () => {
    expect(safeVideos([
      { url: "http://a/1.mp4" }, { url: "javascript:alert(1)" },
      { url: "data:video/mp4;base64,AA" }, { url: "https://a/ok.mp4" },
    ])).toEqual([{ url: "https://a/ok.mp4", poster_url: null }]);
  });

  it("nulls a non-https poster but keeps the video", () => {
    // A mixed-content poster renders as a broken frame over working playback.
    expect(safeVideos([{ url: "https://a/1.mp4", poster_url: "http://a/p.jpg" }])[0].poster_url).toBeNull();
  });

  it("does not leak byte_size or content_type to the agent", () => {
    // An agent relays or links these; it does not decode them.
    const out = safeVideos([{ url: "https://a/1.mp4", content_type: "video/mp4", byte_size: 999 }]);
    expect(Object.keys(out[0]).sort()).toEqual(["poster_url", "url"]);
  });

  it("dedupes by url and caps the count", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://a/${i}.mp4` }));
    expect(safeVideos([...many, many[0]]).length).toBeLessThanOrEqual(3);
  });

  it("returns [] for junk without throwing", () => {
    for (const junk of [null, undefined, "x", 42, [1, "a", null], [{}]]) {
      expect(safeVideos(junk)).toEqual([]);
    }
  });
});

describe("videoLines", () => {
  it("prints one ▶ line per video", () => {
    const lines = videoLines(V);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("▶");
    expect(lines[0]).toContain("https://a/clip.mp4");
  });

  it("says nothing at all when there is no video", () => {
    expect(videoLines([])).toEqual([]);
    expect(videoLines(undefined)).toEqual([]);
  });

  it("never emits a zero state", () => {
    expect(videoLines([]).join("")).not.toMatch(/0 video/i);
  });
});

// ─── The zoom-in, end to end ─────────────────────────────────────────────────

import { vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;
function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, "fs_live_k", "http://api.test");
  return tools;
}
const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
const textOf = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

const LISTING = {
  id: "lst_1", product_name: "Leather wallet", current_price: 40, currency: "USD",
  inventory_qty: 5, images: ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"],
  videos: [{ url: "https://a/clip.mp4", poster_url: "https://a/p.jpg" }],
  seller_name: "Dom", seller_rating: 4.6, seller_rating_count: 12, units_sold: 9,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("firestarter_product — media reaching the agent", () => {
  it("lists every photo, not just the first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(LISTING)));
    const text = textOf(await captureTools().firestarter_product({ listing_id: "lst_1" }));
    expect(text).toContain("Photos (3)");
    for (const u of LISTING.images) expect(text).toContain(u);
  });

  it("prints the video URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(LISTING)));
    const text = textOf(await captureTools().firestarter_product({ listing_id: "lst_1" }));
    expect(text).toContain("▶");
    expect(text).toContain("https://a/clip.mp4");
  });

  it("carries the full gallery AND the video in structured output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(LISTING)));
    const res = await captureTools().firestarter_product({ listing_id: "lst_1" });
    expect(res.structuredContent.product.images).toHaveLength(3);
    expect(res.structuredContent.product.videos).toEqual([
      { url: "https://a/clip.mp4", poster_url: "https://a/p.jpg" },
    ]);
  });

  it("says nothing about video when the listing has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...LISTING, videos: [] })));
    const res = await captureTools().firestarter_product({ listing_id: "lst_1" });
    expect(textOf(res)).not.toContain("▶");
    expect(res.structuredContent.product.videos).toEqual([]);
  });

  it("does not fail the tool when a photo cannot be fetched for inlining", async () => {
    // Inlining is best-effort: a dead CDN must degrade to URLs-only, never turn
    // "show me this product" into an error.
    vi.stubGlobal("fetch", vi.fn(async (u: any) => {
      if (String(u).includes("/v1/listings/")) return json(LISTING);
      throw new Error("cdn down");
    }));
    const res = await captureTools().firestarter_product({ listing_id: "lst_1" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("Leather wallet");
  });
});
