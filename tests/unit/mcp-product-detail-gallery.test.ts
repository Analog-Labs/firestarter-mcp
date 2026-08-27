/**
 * commerce#927 / #774 — "product detail via MCP returns multiple images per
 * product, ratings, and video where the listing has it".
 *
 * The image half of both tickets reads as outstanding, but the work landed
 * incrementally: apps/api projects the whole `images` array onto all three
 * agent read paths (services/internal-listings.ts uses safeImages, not the old
 * firstSafeImage, which no longer exists), and firestarter_product renders the
 * full gallery plus the trust aggregate and any video.
 *
 * Nothing pinned that, so it could regress to a single thumbnail silently and
 * the tickets would simply be reopened. These tests are the evidence the
 * acceptance criteria are met, and the guard that keeps them met.
 *
 * The one deliberate limit: LIST views still inline only the first photo per
 * row. That is not the gap — inlining a whole gallery for twenty search hits
 * would blow the 1MB MCP result cap that mcp-image-budget.test.ts exists to
 * defend. Multiple images are a DETAIL-view promise.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; },
  };
  registerTools(fakeServer as any, "fs_test_gallery", "http://api.test");
  return tools;
}

function text(res: any): string {
  return (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

const LISTING = {
  id: "lst_gallery1",
  product_name: "Trail Runner Jacket",
  price: 89,
  currency: "USD",
  status: "active",
  description: "Windproof shell.",
  images: [
    "https://api.firestarter.network/v1/img/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    "https://api.firestarter.network/v1/img/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
    "https://api.firestarter.network/v1/img/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
  ],
  videos: [{ url: "https://api.firestarter.network/v1/img/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1", poster: null }],
  product_rating: 4.5,
  product_rating_count: 12,
  seller_rating: 4.8,
  seller_rating_count: 30,
  units_sold: 7,
  seller_name: "Tanner Goods",
};

/** A whole 1x1 PNG — inlineImageBlocks decodes what it embeds, so this must be real. */
const PNG = () => Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * URL-aware: the listing endpoint answers JSON, /v1/img/ answers image bytes.
 * A single catch-all stub returns JSON for the photo fetches too, which makes
 * inlineImageBlocks embed nothing and reads as a missing-gallery defect that
 * is really just the fixture.
 */
function stubListing(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("/v1/img/")) {
      return new Response(PNG(), { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response(JSON.stringify({ ...LISTING, ...overrides }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_product detail (commerce#927, #774)", () => {
  it("lists EVERY photo, not just the first", async () => {
    stubListing();
    const t = text(await captureTools().firestarter_product({ listing_id: "lst_gallery1" }));

    expect(t).toMatch(/Photos \(3\)/);
    for (const img of LISTING.images) expect(t).toContain(img);
  });

  it("renders every photo as an inline image block, so the buyer SEES the gallery", async () => {
    stubListing();
    const res = await captureTools().firestarter_product({ listing_id: "lst_gallery1" });

    // Listing the URLs as text is not the ask — #927 is about the buyer being
    // able to look at the product.
    const imageBlocks = (res.content || []).filter((c: any) => c.type === "image");
    expect(imageBlocks.length).toBeGreaterThan(1);
  });

  it("shows the product rating and units sold alongside the gallery", async () => {
    stubListing();
    const t = text(await captureTools().firestarter_product({ listing_id: "lst_gallery1" }));

    expect(t).toMatch(/4\.5/);
    // Exactly "7 sold" — a bare /7/ would also match the price or a count and
    // pass whether or not units_sold was rendered at all.
    expect(t).toMatch(/7 sold/);
  });

  it("shows video when the listing has one", async () => {
    stubListing();
    const t = text(await captureTools().firestarter_product({ listing_id: "lst_gallery1" }));

    expect(t).toContain(LISTING.videos[0].url);
  });

  it("says nothing about photos when the listing genuinely has none", async () => {
    stubListing({ images: [], videos: [] });
    const t = text(await captureTools().firestarter_product({ listing_id: "lst_gallery1" }));

    expect(t).not.toMatch(/Photos \(/);
  });
});
