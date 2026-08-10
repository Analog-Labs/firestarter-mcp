/**
 * QA 2026-08-10: firestarter_market_preview rendered ONLY the curated Recommends
 * shelf, so a seller-owned community (own listings, empty shelf) previewed as
 * "hasn't curated a shelf yet" — reading as an empty market even though the
 * owner had live products. The copy everywhere promises own listings "already
 * appear under what you sell"; these tests lock the agent surface that finally
 * keeps that promise.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatCommunitySells, registerTools } from "../../src/mcp/tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const community = (over: Record<string, unknown> = {}) => ({
  name: "Sunset District Makers",
  active: true,
  picks: [],
  sells: [
    { listing_id: "lst_mug", product_name: "Ceramic Mug", price: 24, image: null },
    { listing_id: "lst_planter", product_name: "Hand-thrown Planter", price: 18.5, image: null },
  ],
  ...over,
});

describe("formatCommunitySells", () => {
  it("renders the community's own listings with buyable listing_ids", () => {
    const text = formatCommunitySells(community());
    expect(text).toContain("What Sunset District Makers sells:");
    expect(text).toContain("Ceramic Mug — $24.00");
    expect(text).toContain("`lst_mug`");
    expect(text).toContain("Hand-thrown Planter — $18.50");
  });

  it("returns null when the community sells nothing", () => {
    expect(formatCommunitySells(community({ sells: [] }))).toBeNull();
    expect(formatCommunitySells(community({ sells: undefined }))).toBeNull();
  });
});

describe("firestarter_market_preview — sells surface", () => {
  function captureTool(name: string): (args: any) => Promise<any> {
    let handler: ((args: any) => Promise<any>) | null = null;
    const stub = {
      tool: (toolName: string, _desc: string, _schema: any, _ann: any, cb: any) => {
        if (toolName === name) handler = cb;
      },
    } as any;
    registerTools(stub, "fs_test_previewsells", "http://api.local");
    if (!handler) throw new Error(`tool ${name} was not registered`);
    return handler;
  }

  function stubCommunityFetch(body: any) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      })),
    );
  }

  it("shows what the community sells even when the Recommends shelf is empty", async () => {
    stubCommunityFetch({ community: community() });
    const preview = captureTool("firestarter_market_preview");

    const res = await preview({ code: "AG6MZY2JFE" });
    const text = res.content.map((b: any) => b.text ?? "").join("\n");

    expect(text).toContain("What Sunset District Makers sells:");
    expect(text).toContain("`lst_mug`");
    // The empty-shelf line must no longer imply the market has nothing at all.
    expect(text).not.toContain("hasn't curated a shelf yet — you can still shop the full Firestarter catalog");
  });

  it("keeps the plain empty-market framing when there are no picks AND no sells", async () => {
    stubCommunityFetch({ community: community({ sells: [] }) });
    const preview = captureTool("firestarter_market_preview");

    const res = await preview({ code: "AG6MZY2JFE" });
    const text = res.content.map((b: any) => b.text ?? "").join("\n");
    expect(text).toContain("hasn't curated");
  });
});
