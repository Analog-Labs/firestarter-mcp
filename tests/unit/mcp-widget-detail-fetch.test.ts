/**
 * The detail modal's lazy top-up call, seen from the server.
 *
 * When a buyer clicks a card, the widget calls firestarter_product itself
 * (App.callServerTool — the same bridge Claude Desktop and ChatGPT both
 * implement) to fetch the description, seller and review quotes that a search
 * row never carries. That call wants DATA, not pictures: the widget already has
 * the photo urls and renders them straight from the CDN, so inlining the same
 * photos as base64 would push megabytes across the host bridge for a modal that
 * displays none of it — and firestarter_product inlines up to the full 1MB
 * result budget.
 *
 * The widget marks its own calls in request `_meta`. A host that drops `_meta`
 * costs us only the wasted bytes, never correctness — which is why the marker
 * gates an optimisation and nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";
import { isWidgetCall, WIDGET_SURFACE_KEY, WIDGET_SURFACE } from "../../src/mcp/ui/widget-call.js";

type ToolHandler = (args: any, extra?: any) => Promise<any>;

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

// 1x1 PNG — small enough to inline well inside the budget, real enough to decode.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const LISTING = {
  id: "lst_abc123",
  product_name: "Leather conditioner",
  current_price: 24,
  currency: "USD",
  status: "active",
  images: ["https://img.test/a.png", "https://img.test/b.png"],
  description: "Restores dry leather.",
  seller_name: "Wax & Hide",
  seller_verified: true,
  product_rating: 4.8,
  product_rating_count: 9,
  units_sold: 31,
  reviews: { count: 9, top: [{ rating: 5, comment: "Works well", created_at: "2026-08-01T00:00:00Z" }] },
};

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith("https://img.test/")) {
        return new Response(new Uint8Array(PNG_1x1), { status: 200, headers: { "Content-Type": "image/png" } });
      }
      if (u.includes("/v1/listings/lst_abc123")) {
        return new Response(JSON.stringify(LISTING), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

beforeEach(installFetch);
afterEach(() => vi.unstubAllGlobals());

describe("isWidgetCall", () => {
  it("recognises the widget's own marker", () => {
    expect(isWidgetCall({ [WIDGET_SURFACE_KEY]: WIDGET_SURFACE })).toBe(true);
  });

  it("treats an ordinary agent call as not from the widget", () => {
    // An agent asking to see a product wants the photos inlined, which is the
    // only way a text-only host shows one at all.
    expect(isWidgetCall(undefined)).toBe(false);
    expect(isWidgetCall({})).toBe(false);
    expect(isWidgetCall({ progressToken: "abc" })).toBe(false);
  });

  it("ignores a marker naming some other surface", () => {
    expect(isWidgetCall({ [WIDGET_SURFACE_KEY]: "something-else" })).toBe(false);
  });
});

describe("firestarter_product", () => {
  it("inlines the photos for an ordinary agent call", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_product({ listing_id: "lst_abc123" });
    expect(res.content.filter((c: any) => c.type === "image").length).toBeGreaterThan(0);
  });

  it("skips the base64 photos when the widget is the caller", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_product(
      { listing_id: "lst_abc123" },
      { _meta: { [WIDGET_SURFACE_KEY]: WIDGET_SURFACE } },
    );
    expect(res.content.filter((c: any) => c.type === "image")).toEqual([]);
  });

  it("still returns everything the modal renders", async () => {
    // The whole point of the call. Dropping the pictures must not drop the
    // description, the seller, or the review quotes the row never carried.
    const tools = captureTools();
    const res = await tools.firestarter_product(
      { listing_id: "lst_abc123" },
      { _meta: { [WIDGET_SURFACE_KEY]: WIDGET_SURFACE } },
    );
    const p = res.structuredContent.product;
    expect(p.description).toBe("Restores dry leather.");
    expect(p.seller).toBe("Wax & Hide");
    expect(p.seller_verified).toBe(true);
    expect(p.images).toEqual(["https://img.test/a.png", "https://img.test/b.png"]);
    expect(p.reviews.count).toBe(9);
    expect(p.reviews.top[0].comment).toBe("Works well");
  });
});
