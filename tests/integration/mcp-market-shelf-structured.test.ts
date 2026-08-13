/**
 * Community-market shelves — structured output contract + product grid.
 *
 * A community market has two product surfaces: `picks` (other sellers' listings
 * the owner curated) and `sells` (the owner's own listings). Both rendered as
 * bare text bullets with no photo at all, even though the API returns a first
 * image for each. These tests pin them to the shopping-results grid.
 *
 * The two shapes are flattened into ONE `listings` array because the widget
 * renders a single array — `kind` and `status_label` are what keep a curated
 * pick distinguishable from something the community sells itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shelfOutputSchema,
  toShelfStructured,
  MCP_OUTPUT_SCHEMA_VERSION,
} from "../../src/mcp/schemas.js";
import { registerTools } from "../../src/mcp/tools.js";

const PICK = {
  listing_id: "lst_abc",
  product_name: "Might-Not-Make-It Sticker",
  price: 3,
  note: "my favorite",
  image: "https://cdn.shopify.com/sticker.jpg",
  min_tier: 0,
};

const SELL = {
  listing_id: "lst_mug",
  product_name: "Ceramic Mug",
  price: 24,
  image: "https://cdn.shopify.com/mug.jpg",
};

const COMMUNITY = { name: "Tania Saleem", picks: [PICK], sells: [SELL] };

describe("toShelfStructured", () => {
  it("flattens picks and sells into one schema-valid listings array", () => {
    const out = toShelfStructured(COMMUNITY);
    expect(() => shelfOutputSchema.parse(out)).not.toThrow();
    expect(out.schema_version).toBe(MCP_OUTPUT_SCHEMA_VERSION);
    expect(out.community).toBe("Tania Saleem");
    expect(out.pick_count).toBe(1);
    expect(out.sells_count).toBe(1);
    expect(out.listings).toHaveLength(2);
  });

  it("carries the pick's photo through, which the text render never showed", () => {
    const out = toShelfStructured(COMMUNITY);
    expect(out.listings[0].images).toEqual(["https://cdn.shopify.com/sticker.jpg"]);
    expect(out.listings[1].images).toEqual(["https://cdn.shopify.com/mug.jpg"]);
  });

  it("normalizes the shelf's bare number price into the field the grid reads", () => {
    // The shelf API sends `price: 3`, but the widget's priceLabel() treats a
    // `price` key as {amount_minor, currency} and renders nothing for a number.
    const out = toShelfStructured(COMMUNITY);
    expect(out.listings[0].current_price).toBe(3);
    expect(out.listings[0].price).toEqual({ currency: "USD", amount_minor: 300 });
  });

  it("orders picks before what the community sells", () => {
    const out = toShelfStructured(COMMUNITY);
    expect(out.listings.map((l) => l.kind)).toEqual(["pick", "sells"]);
    expect(out.listings[0].id).toBe("lst_abc");
  });

  it("badges each kind so a curated pick is not mistaken for the owner's stock", () => {
    const out = toShelfStructured(COMMUNITY);
    expect(out.listings[0].status_label).toBe("★ Pick");
    expect(out.listings[1].status_label).toBe("Sold here");
  });

  it("keeps the curator's note, which is the whole point of a pick", () => {
    expect(toShelfStructured(COMMUNITY).listings[0].note).toBe("my favorite");
    expect(toShelfStructured(COMMUNITY).listings[1].note).toBeNull();
  });

  it("shows every pick even when the text render truncated the shelf", () => {
    // The prose caps at SHELF_RENDER_LIMIT and says "…and N more". A grid has
    // no such constraint, so it carries the whole shelf.
    const picks = Array.from({ length: 9 }, (_, i) => ({ ...PICK, listing_id: `lst_${i}` }));
    const out = toShelfStructured({ ...COMMUNITY, picks });
    expect(out.listings).toHaveLength(10);
    expect(out.pick_count).toBe(9);
  });

  it("drops a non-http image rather than handing the widget a broken src", () => {
    const out = toShelfStructured({ ...COMMUNITY, picks: [{ ...PICK, image: "/relative.jpg" }], sells: [] });
    expect(out.listings[0].images).toEqual([]);
    expect(() => shelfOutputSchema.parse(out)).not.toThrow();
  });

  it("maps an absent price to null rather than NaN or zero", () => {
    const out = toShelfStructured({ ...COMMUNITY, picks: [{ ...PICK, price: null }], sells: [] });
    expect(out.listings[0].current_price).toBeNull();
    expect(out.listings[0].price.amount_minor).toBeNull();
    expect(() => shelfOutputSchema.parse(out)).not.toThrow();
  });

  it("stays schema-valid for a community with nothing on either surface", () => {
    const out = toShelfStructured({ name: "Empty", picks: [], sells: [] });
    expect(() => shelfOutputSchema.parse(out)).not.toThrow();
    expect(out.listings).toEqual([]);
    expect(out.pick_count).toBe(0);
    expect(out.sells_count).toBe(0);
  });

  it("defaults every field when the payload is missing or malformed", () => {
    const out = toShelfStructured(undefined);
    expect(() => shelfOutputSchema.parse(out)).not.toThrow();
    expect(out.community).toBeNull();
    expect(out.listings).toEqual([]);
  });

  it("carries a pick's tier gate so a locked item is not shown as freely available", () => {
    const out = toShelfStructured({ ...COMMUNITY, picks: [{ ...PICK, min_tier: 2 }], sells: [] });
    expect(out.listings[0].min_tier).toBe(2);
  });
});

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

function textOf(res: any): string {
  return (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

function json(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let routes: {
  community?: () => Response;
  me?: () => Response;
  redeem?: () => Response;
  getPicks?: () => Response;
  putPicks?: () => Response;
};

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method || "GET";
      if (u.includes("/marketplace/community/")) {
        return routes.community ? routes.community() : json(200, { community: COMMUNITY });
      }
      if (method === "POST" && u.endsWith("/v1/attribution/redeem")) {
        return routes.redeem ? routes.redeem() : json(200, {});
      }
      if (method === "GET" && u.endsWith("/v1/attribution/me")) {
        return routes.me ? routes.me() : json(200, { community: null });
      }
      if (u.includes("/v1/attribution/programs/") && u.endsWith("/picks")) {
        if (method === "PUT") return routes.putPicks ? routes.putPicks() : json(200, { picks: [], count: 0 });
        return routes.getPicks ? routes.getPicks() : json(200, { picks: [], max_picks: 15 });
      }
      return json(404, { error: `unhandled ${method} ${u}` });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_market_preview — grid", () => {
  it("attaches schema-valid structuredContent with both shelf surfaces", async () => {
    const res = await captureTools().firestarter_market_preview({ code: "TANIACODE1" });
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(2);
    expect(res.structuredContent.community).toBe("Tania Saleem");
  });

  it("keeps the prose shelf intact for hosts without MCP Apps support", async () => {
    const t = textOf(await captureTools().firestarter_market_preview({ code: "TANIACODE1" }));
    expect(t).toContain("Might-Not-Make-It Sticker");
    expect(t).toContain("lst_abc");
    expect(t).toContain("firestarter_join_market");
  });

  it("stays schema-valid when the community has curated nothing", async () => {
    routes.community = () => json(200, { community: { name: "Empty", picks: [], sells: [] } });
    const res = await captureTools().firestarter_market_preview({ code: "X" });
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });
});

describe("firestarter_my_market — grid", () => {
  it("attaches the connected community's shelf as structuredContent", async () => {
    routes.me = () => json(200, {
      community: { connected: true, name: "Tania Saleem", code: "TANIACODE1", program_status: "active" },
    });
    const res = await captureTools().firestarter_my_market({});
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(2);
  });

  it("stays schema-valid when the buyer belongs to no community", async () => {
    routes.me = () => json(200, { community: null });
    const res = await captureTools().firestarter_my_market({});
    expect(textOf(res)).toContain("not connected");
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });
});

describe("firestarter_join_market — grid", () => {
  it("attaches the joined community's shelf as structuredContent", async () => {
    const res = await captureTools().firestarter_join_market({ code: "TANIACODE1" });
    expect(textOf(res)).toContain("Joined the market");
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(2);
  });

  it("still confirms the join, with an empty grid, when the shelf fetch fails", async () => {
    // The shelf is best-effort garnish on a join; a 500 must not turn a
    // successful join into a schema violation or an error.
    routes.community = () => json(500, { error: "boom" });
    const res = await captureTools().firestarter_join_market({ code: "TANIACODE1" });
    expect(textOf(res)).toContain("Joined the market");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });
});

describe("firestarter_set_market_picks — grid", () => {
  it("shows the owner the resulting shelf as a grid", async () => {
    routes.putPicks = () => json(200, {
      count: 1,
      picks: [{ listing_id: "lst_a", product_name: "Cool Sticker", price: 3, note: "love it", image: "https://cdn.shopify.com/c.jpg" }],
    });
    const res = await captureTools().firestarter_set_market_picks({
      program_id: "apg_1",
      picks: [{ listing_id: "lst_a", note: "love it" }],
    });
    expect(textOf(res)).toContain("Shelf updated");
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings[0]).toMatchObject({
      id: "lst_a",
      product_name: "Cool Sticker",
      images: ["https://cdn.shopify.com/c.jpg"],
    });
  });

  it("stays schema-valid when the last pick is removed", async () => {
    routes.getPicks = () => json(200, { picks: [{ listing_id: "lst_a", note: null }], max_picks: 15 });
    routes.putPicks = () => json(200, { count: 0, picks: [] });
    const res = await captureTools().firestarter_set_market_picks({
      program_id: "apg_1",
      action: "remove",
      picks: [{ listing_id: "lst_a" }],
    });
    expect(textOf(res)).toContain("Shelf cleared");
    expect(res.structuredContent).toBeDefined();
    expect(() => shelfOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });
});
