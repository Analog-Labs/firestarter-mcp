/**
 * firestarter_catalog_search — structured output contract.
 *
 * The catalog tool advertises an `outputSchema`, which makes `structuredContent`
 * mandatory on every non-error return (the SDK throws otherwise) and is what the
 * shopping-results MCP App renders as a product grid. These tests pin both
 * halves: that the mapper produces a schema-valid payload from whatever the API
 * returns — including degraded rows — and that the tool attaches it on every
 * path a host can reach without an error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  catalogOutputSchema,
  toCatalogStructured,
  MCP_OUTPUT_SCHEMA_VERSION,
} from "../../src/mcp/schemas.js";
import { registerTools } from "../../src/mcp/tools.js";

const API_DATA = { query: { environment: "test" }, has_more: false };

const ROW = {
  id: "lst_w1",
  product_name: "Leather Wallet",
  category: "Accessories",
  current_price: 20,
  currency: "USD",
  buyable: true,
  share_url: "https://firestarter.network/l/lst_w1",
  images: ["https://cdn.shopify.com/a.jpg"],
};

describe("toCatalogStructured", () => {
  it("maps a listing row into a schema-valid payload", () => {
    const out = toCatalogStructured(API_DATA, [ROW], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.schema_version).toBe(MCP_OUTPUT_SCHEMA_VERSION);
    expect(out.environment).toBe("test");
    expect(out.count).toBe(1);
    expect(out.buyable_count).toBe(1);
    expect(out.listings[0]).toMatchObject({
      id: "lst_w1",
      product_name: "Leather Wallet",
      current_price: 20,
      currency: "USD",
      buyable: true,
      share_url: "https://firestarter.network/l/lst_w1",
      images: ["https://cdn.shopify.com/a.jpg"],
    });
    // Machine-precise money alongside the float, honoring the ISO-4217 exponent.
    expect(out.listings[0].price).toEqual({ currency: "USD", amount_minor: 2000 });
  });

  // The mapper is a strip-list, not a passthrough: a field it doesn't name
  // never reaches the widget. The stars fix in the client is therefore only
  // half a fix — these pin the OTHER half, the structured row carrying the
  // aggregate at all (commerce#850's projection).
  it("passes the seller rating aggregate through to the structured row", () => {
    const out = toCatalogStructured(API_DATA, [{ ...ROW, seller_rating: "4.6", seller_rating_count: 12 }], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.listings[0].seller_rating).toBe(4.6);
    expect(out.listings[0].seller_rating_count).toBe(12);
  });

  it("normalizes an unrated seller to null rating / zero count", () => {
    const out = toCatalogStructured(API_DATA, [ROW], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.listings[0].seller_rating).toBeNull();
    expect(out.listings[0].seller_rating_count).toBe(0);
  });

  it("counts only buyable rows in buyable_count", () => {
    const out = toCatalogStructured(API_DATA, [ROW, { ...ROW, id: "lst_w2", buyable: false }], null);
    expect(out.count).toBe(2);
    expect(out.buyable_count).toBe(1);
  });

  it("drops non-http image entries so the widget never renders a broken src", () => {
    const out = toCatalogStructured(
      API_DATA,
      [{ ...ROW, images: ["javascript:alert(1)", "/relative.jpg", null, "https://ok.test/b.jpg"] }],
      null,
    );
    expect(out.listings[0].images).toEqual(["https://ok.test/b.jpg"]);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
  });

  it("maps a missing or non-numeric price to null rather than NaN", () => {
    const out = toCatalogStructured(API_DATA, [{ ...ROW, current_price: undefined }], null);
    expect(out.listings[0].current_price).toBeNull();
    expect(out.listings[0].price.amount_minor).toBeNull();
    // NaN would pass `typeof === "number"` but fail the schema; this is the guard.
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
  });

  it("stays schema-valid for an empty result set", () => {
    const out = toCatalogStructured(API_DATA, [], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.count).toBe(0);
    expect(out.buyable_count).toBe(0);
    expect(out.listings).toEqual([]);
  });

  it("defaults every field when the API response is empty or malformed", () => {
    const out = toCatalogStructured({}, [{}], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.environment).toBe("live");
    expect(out.community).toBeNull();
    expect(out.listings[0]).toMatchObject({ id: "", product_name: "", category: null, buyable: false });
  });

  it("records the broadened head noun and the buyer's community", () => {
    const data = { query: { environment: "live", community: { name: "Analog" } }, has_more: true };
    const out = toCatalogStructured(data, [{ ...ROW, picked_by_community: true, pick_note: "  great leather  " }], "wallet");
    expect(out.broadened_to).toBe("wallet");
    expect(out.community).toBe("Analog");
    expect(out.has_more).toBe(true);
    expect(out.listings[0].picked_by_community).toBe(true);
    expect(out.listings[0].pick_note).toBe("great leather");
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

/** Per-URL responder: return listings for a given q, [] otherwise. */
let respond: (q: string | null) => any[];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = new URL(String(url));
      const listings = respond(u.searchParams.get("q"));
      return new Response(
        JSON.stringify({ query: { environment: "test" }, count: listings.length, listings, has_more: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

describe("firestarter_catalog_search — structured content on every non-error path", () => {
  beforeEach(() => {
    respond = () => [ROW];
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("attaches schema-valid structuredContent to a normal hit", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(res.structuredContent).toBeDefined();
    expect(() => catalogOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(1);
    expect(res.structuredContent.listings[0].id).toBe("lst_w1");
    // The text result is unchanged — this addition is additive for hosts
    // without MCP Apps support.
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Leather Wallet");
  });

  it("attaches schema-valid structuredContent to a zero-result search", async () => {
    respond = () => [];
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(res.content[0].text).toContain("No catalog listings matched");
    // Without this the SDK throws: an outputSchema makes structuredContent
    // mandatory on any result that is not isError.
    expect(res.structuredContent).toBeDefined();
    expect(() => catalogOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });

  it("records the head noun in broadened_to when a query is broadened", async () => {
    respond = (q) => (q === "wallet" ? [ROW] : []);
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "red leather wallet" });
    expect(res.structuredContent.broadened_to).toBe("wallet");
    expect(res.structuredContent.listings).toHaveLength(1);
  });

  it("leaves broadened_to null when the first query hits", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(res.structuredContent.broadened_to).toBeNull();
  });
});
