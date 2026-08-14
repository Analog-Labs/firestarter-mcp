/**
 * firestarter_listings — structured output contract + product grid.
 *
 * The seller's own listings rendered as a bulleted text list with base64
 * thumbnails stapled underneath; this pins them to the same shopping-results
 * grid firestarter_catalog_search uses. Advertising an `outputSchema` makes
 * `structuredContent` mandatory on EVERY non-error return (the SDK throws
 * otherwise), and this tool has three of them — detail, empty, and list — so
 * each gets its own test.
 *
 * The badge is the part worth guarding: the grid's default is "Browse-only"
 * whenever buyability is absent, and a seller's own listing carries a status
 * (active/draft), never a buyability flag. Mapping status to an explicit
 * `status_label` is what keeps a live listing from being labelled unbuyable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sellerListingsOutputSchema,
  toSellerListingsStructured,
  MCP_OUTPUT_SCHEMA_VERSION,
} from "../../src/mcp/schemas.js";
import { registerTools } from "../../src/mcp/tools.js";

const ROW = {
  id: "lst_s1",
  product_name: "Hand-thrown Planter",
  status: "active",
  current_price: 18.5,
  currency: "USD",
  inventory_qty: 4,
  created_at: "2026-08-13T09:00:00Z",
  share_url: "https://firestarter.network/l/lst_s1",
  images: ["https://cdn.shopify.com/planter.jpg"],
};

describe("toSellerListingsStructured", () => {
  it("maps a listing row into a schema-valid payload the grid can render", () => {
    const out = toSellerListingsStructured([ROW]);
    expect(() => sellerListingsOutputSchema.parse(out)).not.toThrow();
    expect(out.schema_version).toBe(MCP_OUTPUT_SCHEMA_VERSION);
    expect(out.count).toBe(1);
    expect(out.listings[0]).toMatchObject({
      id: "lst_s1",
      product_name: "Hand-thrown Planter",
      current_price: 18.5,
      currency: "USD",
      status: "active",
      inventory_qty: 4,
      images: ["https://cdn.shopify.com/planter.jpg"],
    });
    expect(out.listings[0].price).toEqual({ currency: "USD", amount_minor: 1850 });
  });

  it("labels an active listing so the grid never calls it browse-only", () => {
    // The widget's fallback badge is "Browse-only". A seller looking at their
    // own live listing must not be told it can't be bought.
    expect(toSellerListingsStructured([ROW]).listings[0].status_label).toBe("Active");
  });

  it("labels a draft as a draft", () => {
    const out = toSellerListingsStructured([{ ...ROW, status: "draft" }]);
    expect(out.listings[0].status_label).toBe("Draft");
    expect(out.active_count).toBe(0);
  });

  it("counts only active rows in active_count", () => {
    const out = toSellerListingsStructured([ROW, { ...ROW, id: "lst_s2", status: "draft" }]);
    expect(out.count).toBe(2);
    expect(out.active_count).toBe(1);
  });

  it("omits the share link for a sandbox listing rather than inventing one", () => {
    // listingShareUrl() returns null for test-mode rows; the grid turns a card
    // with no link into a non-clickable card, which is the honest rendering.
    const out = toSellerListingsStructured([{ ...ROW, test_mode: true }]);
    expect(out.listings[0].share_url).toBeNull();
  });

  it("drops non-http image entries so the widget never renders a broken src", () => {
    const out = toSellerListingsStructured([
      { ...ROW, images: ["javascript:alert(1)", "/relative.jpg", null, "https://ok.test/b.jpg"] },
    ]);
    expect(out.listings[0].images).toEqual(["https://ok.test/b.jpg"]);
    expect(() => sellerListingsOutputSchema.parse(out)).not.toThrow();
  });

  it("maps a missing or non-numeric price to null rather than NaN", () => {
    const out = toSellerListingsStructured([{ ...ROW, current_price: undefined }]);
    expect(out.listings[0].current_price).toBeNull();
    expect(out.listings[0].price.amount_minor).toBeNull();
    expect(() => sellerListingsOutputSchema.parse(out)).not.toThrow();
  });

  it("stays schema-valid for a seller with no listings", () => {
    const out = toSellerListingsStructured([]);
    expect(() => sellerListingsOutputSchema.parse(out)).not.toThrow();
    expect(out.count).toBe(0);
    expect(out.listings).toEqual([]);
  });

  it("defaults every field when a row is empty or malformed", () => {
    const out = toSellerListingsStructured([{}]);
    expect(() => sellerListingsOutputSchema.parse(out)).not.toThrow();
    expect(out.listings[0]).toMatchObject({
      id: "",
      product_name: "",
      status: null,
      status_label: null,
      inventory_qty: null,
      images: [],
    });
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

/** Per-test rows for GET /v1/listings and GET /v1/listings/:id. */
let listRows: any[];
let detailRow: any;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      const body = /\/v1\/listings\/[^/?]+$/.test(u) ? detailRow : { listings: listRows };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("firestarter_listings — structured content on every non-error path", () => {
  beforeEach(() => {
    listRows = [ROW];
    detailRow = ROW;
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("attaches schema-valid structuredContent to the list view", async () => {
    const res = await captureTools().firestarter_listings({});
    expect(res.structuredContent).toBeDefined();
    expect(() => sellerListingsOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(1);
    expect(res.structuredContent.listings[0].id).toBe("lst_s1");
    expect(res.structuredContent.listings[0].images).toEqual(["https://cdn.shopify.com/planter.jpg"]);
  });

  it("keeps the text rendering intact for hosts without MCP Apps support", async () => {
    // This change is additive: a host that ignores the UI resource must still
    // get exactly the list it got before.
    const t = textOf(await captureTools().firestarter_listings({}));
    expect(t).toContain("Your listings (1)");
    expect(t).toContain("Hand-thrown Planter");
    expect(t).toContain("lst_s1");
  });

  it("attaches schema-valid structuredContent when the seller has no listings", async () => {
    // Without this the SDK throws — an outputSchema makes structuredContent
    // mandatory on any result that is not isError.
    listRows = [];
    const res = await captureTools().firestarter_listings({});
    expect(textOf(res)).toContain("no active listings");
    expect(res.structuredContent).toBeDefined();
    expect(() => sellerListingsOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });

  it("attaches schema-valid structuredContent to the single-listing detail view", async () => {
    const res = await captureTools().firestarter_listings({ listing_id: "lst_s1" });
    expect(res.structuredContent).toBeDefined();
    expect(() => sellerListingsOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(1);
    expect(res.structuredContent.listings[0].product_name).toBe("Hand-thrown Planter");
  });
});
