/**
 * The API tells us which photos it refused and when a restock was held. We
 * never told the seller.
 *
 * Four commerce-side producers set `rejected_images` (listing-create.ts,
 * listings.ts PATCH, seller-dashboard.ts x2) and one sets `restock_blocked`
 * (listings.ts PATCH). Before this file, `rejected_images` and
 * `restock_blocked` appeared ZERO times in tools.ts — every one of those
 * reasons was computed, serialized, and thrown away at the renderer.
 *
 * What the seller saw instead, from the 2026-08-20 regression run:
 *
 *   - 1 photo submitted from an unreachable host, 0 stored -> "Add at least one
 *     product photo before this listing can go live", i.e. indistinguishable
 *     from having sent nothing at all.
 *   - 3 submitted, 2 stored -> "Photos: 2 attached". The third is never
 *     mentioned.
 *   - 14 submitted, 12 stored -> "Photos: 12 attached". The cap is silent.
 *   - a restock held behind possession verification -> "Listing updated".
 *
 * That is why a seller reports "the photo just didn't work" (commerce#849):
 * the agent cheerfully creates the listing and then asks them for a photo they
 * already gave it. It needs no timeout to happen — one unreachable host does it.
 *
 * Same harness as mcp-reprice-regate.test.ts: drive the REAL registered tool
 * handlers against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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

function installFetch(json: any, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

const LISTING_ID = "lst_ZYdsvKtp";

const UNREACHABLE =
  "We couldn't load an image from this link. Check it opens publicly and is a JPEG, PNG, WebP or GIF under 6 MB.";

describe("refused photos are reported to the seller", () => {
  it("firestarter_list: a listing that went live anyway still names the photo it refused", async () => {
    // The exact shape from the regression run: 3 URLs in, 2 stored, listing
    // ACTIVE. Nothing was blocked, so nothing else in the response hints that a
    // photo is missing — this is the case the old code was silent about.
    installFetch({
      id: LISTING_ID,
      product_name: "Three-photo test",
      status: "active",
      base_price: 5.2,
      images: ["https://api.firestarter.network/v1/img/a", "https://api.firestarter.network/v1/img/b"],
      rejected_images: [{ url: "https://unreachable.example.com/c.jpg", reason: UNREACHABLE }],
    });

    const text = textOf(
      await captureTools().firestarter_list({
        product_name: "Three-photo test",
        base_price: 5.2,
        image_urls: ["https://a", "https://b", "https://unreachable.example.com/c.jpg"],
      })
    );

    expect(text).toMatch(/Photos: 2 attached/);
    expect(text).toContain("unreachable.example.com/c.jpg");
    expect(text).toContain(UNREACHABLE);
  });

  it("firestarter_list: a draft with no photos says WHY, not just 'add a photo'", async () => {
    // 1 in, 0 stored. The activation block already prints "Add at least one
    // product photo"; on its own that reads as "you sent nothing".
    installFetch({
      id: LISTING_ID,
      product_name: "Goat Soft Toy",
      status: "draft",
      base_price: 5.2,
      images: [],
      activation_blocked: [{ code: "NEEDS_IMAGE", message: "Add at least one product photo before this listing can go live." }],
      rejected_images: [{ url: "https://unreachable.example.com/goat.jpg", reason: UNREACHABLE }],
    });

    const text = textOf(
      await captureTools().firestarter_list({
        product_name: "Goat Soft Toy",
        base_price: 5.2,
        image_urls: ["https://unreachable.example.com/goat.jpg"],
      })
    );

    expect(text).toContain("Add at least one product photo");
    expect(text).toContain("unreachable.example.com/goat.jpg");
    expect(text).toContain(UNREACHABLE);
  });

  it("firestarter_update_listing: a refused photo on an edit is reported", async () => {
    installFetch({
      id: LISTING_ID,
      product_name: "Edited",
      status: "active",
      images: ["https://api.firestarter.network/v1/img/a"],
      rejected_images: [
        { url: "https://hotlinked.example.com/x.jpg", reason: UNREACHABLE },
        { url: "https://cdn.example.com/y.jpg", reason: "Only the first 12 photos are stored — this one was not." },
      ],
    });

    const text = textOf(
      await captureTools().firestarter_update_listing({
        listing_id: LISTING_ID,
        image_urls: ["https://a", "https://hotlinked.example.com/x.jpg", "https://cdn.example.com/y.jpg"],
      })
    );

    expect(text).toContain("hotlinked.example.com/x.jpg");
    expect(text).toContain("cdn.example.com/y.jpg");
    expect(text).toContain("Only the first 12 photos are stored");
  });

  it("says nothing extra when no photo was refused", async () => {
    // A clean write must be byte-identical to before, or every successful
    // listing grows a paragraph of reassurance nobody asked for.
    installFetch({
      id: LISTING_ID,
      product_name: "Clean",
      status: "active",
      base_price: 5.2,
      images: ["https://api.firestarter.network/v1/img/a"],
    });

    const text = textOf(
      await captureTools().firestarter_list({ product_name: "Clean", base_price: 5.2, image_urls: ["https://a"] })
    );

    expect(text).not.toMatch(/refuse|rejected|could ?n.t load/i);
  });
});

describe("a held restock is reported to the seller", () => {
  it("firestarter_update_listing: a restock held behind verification is not a plain 'updated'", async () => {
    installFetch({
      id: LISTING_ID,
      product_name: "Held restock",
      status: "out_of_stock",
      inventory_qty: 25,
      restock_blocked: {
        code: "RESTOCK_HELD_VERIFICATION",
        message:
          "Stock was updated, but the listing stays out of stock until possession verification is resolved. See GET /v1/listings/:id for the code and instructions.",
      },
    });

    const text = textOf(
      await captureTools().firestarter_update_listing({ listing_id: LISTING_ID, inventory_qty: 25 })
    );

    expect(text).toContain("stays out of stock until possession verification is resolved");
  });

  it("firestarter_update_listing: a restock held by a moderation hold names that reason", async () => {
    installFetch({
      id: LISTING_ID,
      product_name: "Quarantined",
      status: "quarantined",
      inventory_qty: 25,
      restock_blocked: {
        code: "RESTOCK_HELD_MODERATION",
        message: "This listing is on hold pending content review and cannot be republished.",
      },
    });

    const text = textOf(
      await captureTools().firestarter_update_listing({ listing_id: LISTING_ID, inventory_qty: 25 })
    );

    expect(text).toContain("on hold pending content review");
  });

  it("says nothing extra when the restock went through", async () => {
    installFetch({ id: LISTING_ID, product_name: "Restocked", status: "active", inventory_qty: 25 });

    const text = textOf(
      await captureTools().firestarter_update_listing({ listing_id: LISTING_ID, inventory_qty: 25 })
    );

    expect(text).not.toMatch(/held|blocked|stays out of stock/i);
  });
});
