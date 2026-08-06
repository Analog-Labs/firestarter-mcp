/**
 * Follow-up fixes from a manual MCP QA pass over the listing surface
 * (staging @ 7b098d64). Each `it` pins one reported bug:
 *
 *  - firestarter_list: allow_duplicate documented in the DUPLICATE_LISTING
 *    error hint but missing from the input schema (same class of bug as
 *    allow_imageless — the field was silently stripped before the handler
 *    ever saw it).
 *  - firestarter_reprice: floor/ceiling render as the literal string
 *    "$null" when unset, because formatListing() returns null (not
 *    undefined) for an unset price and the handler only checked `!==
 *    undefined`.
 *  - firestarter_demand: the category-feed branch destructured the
 *    handler args without `category` (so the filter was a silent no-op)
 *    and read `data.signals || data.demand || [data]` when the feed route
 *    actually returns `{ feed: [...] }` — wrapping the whole response
 *    object as a single "item" and rendering "- Unknown".
 *  - firestarter_connect_store: `platform` was a 5-value zod enum, so
 *    "shopify"/"tiktok_shop" got rejected by schema validation as a raw
 *    MCP error before ever reaching the handler's own friendly redirect
 *    code (which exists, and is correct, but was unreachable).
 *  - firestarter_listings: description claims "list all active listings"
 *    but GET /v1/listings returns every non-delisted status, drafts
 *    included — a wording bug, not a filtering bug (a seller needs to see
 *    drafts to know what to activate).
 *  - firestarter_listings (detail view): only rendered name/price/
 *    inventory/category/description/images/demand — brand, sku,
 *    condition, dimensions, weight, country_of_origin, materials, tags,
 *    variants, return_policy, ship_time_days, shipping_policy, and
 *    verification_status were all already on the API response and simply
 *    never rendered.
 *
 * Same harness as mcp-import.test.ts, extended (per mcp-allow-imageless.test.ts)
 * to actually parse args through `z.object(rawShape)` like the real SDK does,
 * so a schema gap fails the test instead of silently passing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, { handler: ToolHandler; description: string }> {
  const tools: Record<string, { handler: ToolHandler; description: string }> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      // (description, schema, [annotations], handler) — annotations is
      // optional, so the handler is always the last argument.
      const [description, schema] = rest;
      const handler = rest[rest.length - 1];
      const shape = z.object(schema);
      tools[name] = { description, handler: (args: any) => handler(shape.parse(args)) };
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

type RecordedCall = { method: string; url: string; body: any };

function installFetch(
  respond: (method: string, url: string, body: any) => { status: number; json: any }
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(url), body });
      const { status, json } = respond(method, String(url), body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

describe("firestarter_list allow_duplicate passthrough", () => {
  it("forwards allow_duplicate: true in the POST /v1/listings body", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({
      status: 201,
      json: { id: "lst_1", product_name: "Widget", status: "active", base_price: 10 },
    }));

    await tools.firestarter_list.handler({ product_name: "Widget", base_price: 10, allow_duplicate: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.allow_duplicate).toBe(true);
  });
});

describe("firestarter_reprice null price rendering", () => {
  it("omits the Floor/Ceiling lines instead of printing '$null' when they're unset", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 200,
      json: { id: "lst_1", base_price: 25, floor_price: null, ceiling_price: null },
    }));

    const res = await tools.firestarter_reprice.handler({ listing_id: "lst_1", base_price: 25 });

    const text = textOf(res);
    expect(text).not.toContain("$null");
    expect(text).not.toContain("Floor:");
    expect(text).not.toContain("Ceiling:");
  });

  it("still renders a real floor/ceiling value when one is set", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 200,
      json: { id: "lst_1", base_price: 25, floor_price: 15, ceiling_price: null },
    }));

    const res = await tools.firestarter_reprice.handler({ listing_id: "lst_1", base_price: 25 });

    const text = textOf(res);
    expect(text).toContain("Floor: $15");
    expect(text).not.toContain("Ceiling:");
  });
});

describe("firestarter_demand category feed", () => {
  it("reads the /v1/demand/feed response's `feed` array, not the whole envelope", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 200,
      json: {
        feed: [
          { category: "electronics/audio", frequency: 12, avg_budget: 45, trend: "rising", top_queries: ["earbuds"] },
        ],
        summary: { total_signals: 12 },
      },
    }));

    const res = await tools.firestarter_demand.handler({ category: "electronics/audio" });

    const text = textOf(res);
    expect(text).not.toContain("Unknown");
    expect(text).toContain("electronics/audio");
  });

  it("filters the feed to the requested category instead of ignoring the param", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 200,
      json: {
        feed: [
          { category: "electronics/audio", frequency: 12, top_queries: [] },
          { category: "home/kitchen", frequency: 40, top_queries: [] },
        ],
      },
    }));

    const res = await tools.firestarter_demand.handler({ category: "electronics/audio" });

    const text = textOf(res);
    expect(text).toContain("electronics/audio");
    expect(text).not.toContain("home/kitchen");
  });
});

describe("firestarter_connect_store friendly redirect for shopify/tiktok_shop", () => {
  it("rejects platform: 'shopify' with the handler's own redirect text, not a raw schema error", async () => {
    const tools = captureTools();
    // No fetch call expected — the handler should short-circuit before any apiRequest.
    installFetch(() => {
      throw new Error("should not call the API for a shopify/tiktok_shop platform");
    });

    const res = await tools.firestarter_connect_store.handler({ platform: "shopify" });

    expect(textOf(res)).toContain("firestarter_connect_shopify");
  });

  it("rejects platform: 'tiktok_shop' with the handler's own redirect text", async () => {
    const tools = captureTools();
    installFetch(() => {
      throw new Error("should not call the API for a shopify/tiktok_shop platform");
    });

    const res = await tools.firestarter_connect_store.handler({ platform: "tiktok_shop" });

    expect(textOf(res)).toContain("firestarter_connect_tiktok");
  });
});

describe("firestarter_listings description accuracy", () => {
  it("does not claim the no-arg call is limited to active listings (drafts are included)", () => {
    const tools = captureTools();
    const { description } = tools.firestarter_listings;
    expect(description.toLowerCase()).not.toContain("list all active listings");
  });
});

describe("firestarter_listings detail view renders the extended fields", () => {
  it("surfaces brand/sku/condition/dimensions/materials/tags/variants/verification when present", async () => {
    const tools = captureTools();
    installFetch(() => ({
      status: 200,
      json: {
        id: "lst_1",
        product_name: "Trail Runner Jacket",
        status: "draft",
        current_price: 89,
        brand: "Acme Outdoors",
        sku: "ACME-TRJ-001",
        condition: "new",
        length_in: 12,
        width_in: 8,
        height_in: 3,
        weight_oz: 14,
        country_of_origin: "VN",
        materials: ["nylon"],
        tags: ["hiking", "waterproof"],
        variants: [{ label: "Small", inventory_qty: 4 }, { label: "Large", inventory_qty: 2 }],
        return_policy: "30-day returns",
        ship_time_days: 2,
        verification_status: "required",
        verification_code: "FS-7K2M",
      },
    }));

    const res = await tools.firestarter_listings.handler({ listing_id: "lst_1" });
    const text = textOf(res);

    expect(text).toContain("Acme Outdoors");
    expect(text).toContain("ACME-TRJ-001");
    expect(text.toLowerCase()).toContain("new");
    expect(text).toContain("12");
    expect(text).toContain("VN");
    expect(text).toContain("nylon");
    expect(text).toContain("hiking");
    expect(text).toContain("waterproof");
    expect(text).toContain("Small");
    expect(text).toContain("30-day returns");
    expect(text).toContain("FS-7K2M");
  });
});
