/**
 * The detail view's content rules.
 *
 * One model feeds two mounts: the firestarter_product payload (which arrives
 * complete) and a grid card the buyer clicked (which arrives as a search row
 * and is topped up by a lazy firestarter_product call). Both must read
 * identically, so the merge, the labelling and the link set are decided here
 * rather than twice in the DOM code.
 *
 * Pure, so Node can test it — the client half owns the modal element.
 */
import { describe, it, expect } from "vitest";
import { detailFetchId, detailModel } from "../../src/mcp/ui/detail.js";

const listingRow = {
  id: "lst_abc123",
  product_name: "Leather conditioner",
  current_price: 24,
  currency: "USD",
  images: ["https://img.test/a.jpg", "https://img.test/b.jpg"],
  buyable: true,
  share_url: "https://firestarter.network/l/lst_abc123",
};

const externalOption = {
  id: "gs_9981",
  title: "Leather conditioner",
  source: "google_shopping",
  price_usd: 19.5,
  currency: "USD",
  url: "https://shop.example.com/products/leather-conditioner",
  image_url: "https://img.test/ext.jpg",
  purchasable: false,
};

describe("detailFetchId", () => {
  it("returns the listing id for a Firestarter row", () => {
    expect(detailFetchId(listingRow)).toBe("lst_abc123");
  });

  it("returns nothing for an external search result", () => {
    // A Google Shopping id is not a listing id. Calling firestarter_product
    // with it spends a round trip to earn a 404, and the modal would flash an
    // empty reviews section for a product we hold no reviews about.
    expect(detailFetchId(externalOption)).toBeNull();
  });

  it("returns nothing for a row with no id at all", () => {
    expect(detailFetchId({ title: "Orphan" })).toBeNull();
  });
});

describe("detailModel — from a row alone", () => {
  it("shows the row's price and photos before any fetch resolves", () => {
    // The modal must be useful on the frame it opens; the fetch only tops up.
    const m = detailModel(listingRow, null);
    expect(m.price).toBe("USD 24.00");
    expect(m.images).toEqual(["https://img.test/a.jpg", "https://img.test/b.jpg"]);
  });

  it("offers the listing page for a Firestarter listing", () => {
    const m = detailModel(listingRow, null);
    expect(m.links).toContainEqual({ kind: "listing", label: "View listing page", url: listingRow.share_url });
  });

  it("names the merchant's own host for an external result", () => {
    // "View listing page" would be a lie here — there is no Firestarter page
    // for a Google Shopping hit, and the buyer is leaving for the merchant.
    const m = detailModel(externalOption, null);
    expect(m.links).toContainEqual({ kind: "store", label: "Open on shop.example.com", url: externalOption.url });
    expect(m.links.some((l) => l.kind === "listing")).toBe(false);
  });

  it("lists no links at all when the row carries no usable url", () => {
    const m = detailModel({ id: "lst_x", product_name: "No links" }, null);
    expect(m.links).toEqual([]);
  });
});

describe("detailModel — ratings", () => {
  it("labels a seller-level rating as the seller's", () => {
    // Unlabelled seller stars read as this product's, which is the exact
    // misattribution product-first ratings exist to prevent (media.ts).
    const m = detailModel({ ...listingRow, rating: 4.6, rating_count: 12, rating_is_seller_level: true }, null);
    expect(m.rating).toEqual({ stars: "★ 4.6", count: "(12)", label: "seller rating" });
  });

  it("leaves a product's own rating unlabelled", () => {
    const m = detailModel({ ...listingRow, rating: 4.9, rating_count: 3, rating_is_seller_level: false }, null);
    expect(m.rating).toEqual({ stars: "★ 4.9", count: "(3)", label: null });
  });

  it("shows no stars when nothing has been rated", () => {
    // Never a manufactured zero: "0.0 (0)" describes reviews that do not exist.
    expect(detailModel({ ...listingRow, rating: 0, rating_count: 0 }, null).rating).toBeNull();
  });

  it("shows a sold count only once something has sold", () => {
    expect(detailModel({ ...listingRow, units_sold: 12 }, null).soldLabel).toBe("12 sold");
    expect(detailModel({ ...listingRow, units_sold: 0 }, null).soldLabel).toBeNull();
  });
});

describe("detailModel — merging the lazy fetch", () => {
  const fetched = {
    description: "Restores dry leather.",
    seller: "Wax & Hide",
    seller_verified: true,
    images: ["https://img.test/a.jpg", "https://img.test/b.jpg", "https://img.test/c.jpg"],
    videos: [{ url: "https://img.test/clip.mp4", poster_url: "https://img.test/clip.jpg" }],
    reviews: { count: 9, top: [{ rating: 5, comment: "Works", created_at: "2026-08-01T00:00:00Z" }] },
    units_sold: 31,
  };

  it("takes the fuller photo set from the fetch", () => {
    // A grid row caps photos at MAX_CARD_IMAGES; the detail view has room for
    // the whole gallery and should not stay capped once it has one.
    expect(detailModel(listingRow, fetched).images).toHaveLength(3);
  });

  it("adds the description, seller and reviews the row never carried", () => {
    const m = detailModel(listingRow, fetched);
    expect(m.description).toBe("Restores dry leather.");
    expect(m.seller).toEqual({ name: "Wax & Hide", verified: true });
    expect(m.reviewCount).toBe(9);
    expect(m.reviews).toEqual([{ rating: 5, comment: "Works", created_at: "2026-08-01T00:00:00Z" }]);
  });

  it("keeps the row's own seller name when the fetch has none", () => {
    // Preview rows carry a seller; catalog rows do not. Neither may be erased
    // by a fetch that came back thin.
    const m = detailModel({ ...listingRow, seller: "Wax & Hide" }, { description: "x" } as any);
    expect(m.seller).toEqual({ name: "Wax & Hide", verified: false });
  });

  it("drops a review that has no comment left after sanitising", () => {
    const m = detailModel(listingRow, { reviews: { count: 2, top: [{ rating: 5, comment: "   ", created_at: null }] } } as any);
    expect(m.reviews).toEqual([]);
  });

  // ── Ratings off the fetch ────────────────────────────────────────────────
  // firestarter_product returns rating / rating_count / rating_is_seller_level
  // on every product (tools.ts), but FetchedDetail never declared them, so
  // detailModel read stars from the ROW alone. A catalog row whose aggregate
  // was absent therefore showed no stars in the detail view even after the
  // fetch answered with them — the rating arrived and was thrown away, while
  // description, seller, photos and units_sold beside it all merged correctly.

  it("shows the rating the fetch carried when the row had none", () => {
    const m = detailModel(listingRow, { ...fetched, rating: 4.4, rating_count: 39, rating_is_seller_level: false } as any);
    expect(m.rating).toEqual({ stars: "★ 4.4", count: "(39)", label: null });
  });

  it("labels a fetched seller-level rating as the seller's", () => {
    // The label is the whole point of the fallback — unlabelled seller stars
    // read as this product's. It has to survive the merge, not just the row.
    const m = detailModel(listingRow, { ...fetched, rating: 4.4, rating_count: 39, rating_is_seller_level: true } as any);
    expect(m.rating).toEqual({ stars: "★ 4.4", count: "(39)", label: "seller rating" });
  });

  it("prefers the row's rating over the fetch's", () => {
    // The row is what the buyer just saw on the card. A detail view that
    // renumbers the stars on open reads as two different products.
    const rated = { ...listingRow, rating: 4.9, rating_count: 3, rating_is_seller_level: false };
    const m = detailModel(rated, { ...fetched, rating: 4.4, rating_count: 39, rating_is_seller_level: true } as any);
    expect(m.rating).toEqual({ stars: "★ 4.9", count: "(3)", label: null });
  });

  it("still shows nothing when neither the row nor the fetch has a rating", () => {
    expect(detailModel(listingRow, fetched).rating).toBeNull();
  });

  it("keeps the review count visible when no quote survived", () => {
    // Ratings without written comments are the common case: topReviews only
    // quotes comments past a length floor, so a listing can hold 9 ratings and
    // zero quotable ones. Dropping the whole section there told the buyer the
    // product had no feedback at all.
    const m = detailModel(listingRow, { reviews: { count: 9, top: [] } } as any);
    expect(m.reviews).toEqual([]);
    expect(m.reviewCount).toBe(9);
  });
});

describe("detailModel — the reviews note", () => {
  // reviewsHtml drops the whole section when no quote survives, so a listing
  // rated by nine buyers who wrote nothing rendered identically to one nobody
  // has ever bought. The count is real and worth saying on its own.

  it("says how many rated a product nobody wrote about", () => {
    const m = detailModel(listingRow, { reviews: { count: 9, top: [] } } as any);
    expect(m.reviewsNote).toBe("9 ratings, no written reviews yet");
  });

  it("counts a single rating in the singular", () => {
    const m = detailModel(listingRow, { reviews: { count: 1, top: [] } } as any);
    expect(m.reviewsNote).toBe("1 rating, no written reviews yet");
  });

  it("stays quiet when the quotes already speak for themselves", () => {
    const m = detailModel(listingRow, {
      reviews: { count: 4, top: [{ rating: 5, comment: "Works", created_at: null }] },
    } as any);
    expect(m.reviewsNote).toBeNull();
  });

  it("stays quiet for a product with genuinely no reviews", () => {
    // A brand-new listing must not be handed a note announcing its own
    // emptiness — that reads as rejected rather than new.
    expect(detailModel(listingRow, { reviews: { count: 0, top: [] } } as any).reviewsNote).toBeNull();
    expect(detailModel(listingRow, null).reviewsNote).toBeNull();
  });

  it("stays quiet while the fetch is still in flight", () => {
    // Nothing fetched yet is not the same as nothing to say, and the section
    // is already showing a skeleton at that point.
    expect(detailModel(listingRow, {} as any).reviewsNote).toBeNull();
  });
});

describe("detailModel — media links", () => {
  it("links every photo so a buyer can open the original", () => {
    const m = detailModel(listingRow, null);
    expect(m.photoLinks).toEqual([
      { label: "Photo 1", url: "https://img.test/a.jpg" },
      { label: "Photo 2", url: "https://img.test/b.jpg" },
    ]);
  });

  it("links a video by url with its poster, never as an inline player", () => {
    // The widget is a sandboxed iframe in someone else's client; embedding a
    // seller-supplied 25MB file there is not ours to decide (#774 D11).
    const m = detailModel(listingRow, { videos: [{ url: "https://img.test/clip.mp4", poster_url: null }] } as any);
    expect(m.videos).toEqual([{ url: "https://img.test/clip.mp4", poster_url: null }]);
  });

  it("keeps out a photo url that is not https", () => {
    // javascript: is XSS in any host that renders the url; plain http is
    // blocked as mixed content, which shows as a broken frame.
    const m = detailModel({ ...listingRow, images: ["javascript:alert(1)", "http://img.test/c.jpg", "https://img.test/ok.jpg"] }, null);
    expect(m.images).toEqual(["https://img.test/ok.jpg"]);
  });
});
