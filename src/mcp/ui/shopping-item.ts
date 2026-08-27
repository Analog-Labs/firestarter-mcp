/**
 * Pure view helpers for the shopping-results product grid.
 *
 * Split out of shopping-results.client.ts so they can be unit-tested in Node:
 * the client touches DOM globals at import time, this does not. esbuild bundles
 * this module into the same IIFE, so these functions are what runs in the
 * sandboxed iframe.
 */

/** The subset of a preview option / catalog listing / shelf item the grid renders.
 *  Kept loose on purpose — the structured payload evolves server-side and a
 *  missing field must degrade to "not shown", never throw. */
export interface ShoppingItem {
  title?: string;
  product_name?: string;
  image_url?: string;
  image?: string;
  images?: unknown;
  price_usd?: number;
  current_price?: number;
  /** Catalog rows send {amount_minor, currency}; the firestarter_product
   *  projection sends a plain number. priceLabel accepts both. */
  price?: number | { amount_minor?: number | null; currency?: string } | null;
  currency?: string;
  url?: string;
  share_url?: string;
  seller?: string;
  purchasable?: boolean;
  buyable?: boolean;
  eligible?: boolean;
  /** Provenance/lifecycle badge for surfaces with no buyability flag
   *  (a seller's own listings, a community shelf). */
  status_label?: string | null;
  /** Rating aggregate (phase 2 wiring): rendered ONLY when count > 0. */
  rating?: number | null;
  rating_count?: number | null;
  /** Catalog rows carry the aggregate under seller_* names (the API's public
   *  projection); preview/product payloads use the bare names. starsLabel
   *  accepts both so the grid's stars match the text rows for every surface. */
  seller_rating?: number | null;
  seller_rating_count?: number | null;
  /** True when `rating` is the SELLER's, standing in for a product with no
   *  reviews of its own. The detail view labels that fallback rather than
   *  letting seller stars read as the product's. */
  rating_is_seller_level?: boolean;
  /** Playable clips: url + optional poster. Present on preview options,
   *  catalog rows and seller listings; the detail view links them, and never
   *  embeds a player (#774 D11). */
  videos?: unknown;
  /** Long copy. Catalog rows carry it; preview options do not — the detail
   *  view's lazy firestarter_product call fills the gap. */
  description?: string | null;
  /** Delivered/completed non-test sales. 0 or absent for external results. */
  units_sold?: number | null;
}

export function firstImage(it: ShoppingItem): string | null {
  const direct = it.image_url ?? it.image;
  if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct;
  if (Array.isArray(it.images)) {
    const u = it.images.find((x) => typeof x === "string" && /^https?:\/\//i.test(x));
    if (typeof u === "string") return u;
  }
  return null;
}

/** Beyond a handful, a card's progress-bar row becomes hairlines, and a
 *  rotation nobody stays to watch. Six photos at ~3.2s is already ~19s. */
export const MAX_CARD_IMAGES = 6;

/**
 * Every usable photo for a card, primary first.
 *
 * The grid rendered firstImage() only, so a 4-photo listing looked identical
 * to a 1-photo one — the images array was already in the payload and simply
 * unused. This is the same filter firstImage applies, kept as one function so
 * the two cannot disagree about which photo leads: a card showing one photo
 * and opening a different one is worse than showing one photo.
 *
 * These are also the photos the card rotates through (grid.client.ts) and the
 * order the detail view opens on.
 */
export function galleryImages(it: ShoppingItem): string[] {
  const ok = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown) => {
    if (!ok(u) || seen.has(u) || out.length >= MAX_CARD_IMAGES) return;
    seen.add(u);
    out.push(u);
  };
  // The primary the API chose leads, whether or not it also appears in the
  // array — firstImage prefers it too.
  push(it.image_url ?? it.image);
  if (Array.isArray(it.images)) for (const u of it.images) push(u);
  return out;
}

export function priceLabel(it: ShoppingItem): string {
  const priceObj = typeof it.price === "object" && it.price !== null ? it.price : null;
  const currency = it.currency || priceObj?.currency || "USD";
  const amount =
    typeof it.price_usd === "number" ? it.price_usd
      : typeof it.current_price === "number" ? it.current_price
        : typeof it.price === "number" ? it.price
          : typeof priceObj?.amount_minor === "number" ? priceObj.amount_minor / 100
            : null;
  // A zero price is "price unknown" (unclaimed feed pre-listings carry 0, and
  // listing creation enforces a positive minimum) — showing "USD 0.00" reads
  // as free-for-sale, so render no price instead.
  return amount == null || amount === 0 ? "" : `${currency} ${amount.toFixed(2)}`;
}

/**
 * The badge on a card, or null to render none.
 *
 * Order matters. Explicit buyability wins, because whether a buyer can check
 * out is the most consequential thing a card can say and a provenance label
 * must never mask it. A `status_label` covers the surfaces that carry no
 * buyability at all — a seller's own listings (Active/Draft), a community
 * shelf (★ Pick / Sold here).
 *
 * When nothing is known, the badge is omitted. It used to fall through to
 * "Browse-only", which asserted a fact about checkout that the payload never
 * contained — telling a seller their own live listing could not be bought.
 */
export function badgeFor(it: ShoppingItem): { text: string; cls: string } | null {
  const buyable = it.purchasable ?? it.buyable;
  if (buyable === true) {
    return it.eligible !== false
      ? { text: "Buyable now", cls: "ok" }
      : { text: "Buyable", cls: "ok" };
  }
  if (buyable === false) return { text: "Browse-only", cls: "muted" };
  const label = typeof it.status_label === "string" ? it.status_label.trim() : "";
  return label ? { text: label, cls: "muted" } : null;
}

/**
 * `★ 4.6 (12)` when a real aggregate exists; null renders nothing — the
 * stars row collapses rather than showing an empty or zero state.
 */
export function starsLabel(it: ShoppingItem): { stars: string; count: string } | null {
  // Bare names (preview/product payloads) win; catalog rows carry the same
  // aggregate as seller_rating/seller_rating_count (the API's public
  // projection) — without the fallback the grid showed no stars for exactly
  // the rows whose TEXT rendering did.
  const rating = Number(it.rating ?? it.seller_rating);
  const count = Number(it.rating_count ?? it.seller_rating_count);
  if (!Number.isFinite(rating) || !Number.isFinite(count) || count <= 0) return null;
  return { stars: `★ ${rating.toFixed(1)}`, count: `(${count})` };
}

/**
 * The card's media chip — `📷 4 · ▶ 1` — or null when there is nothing worth
 * announcing.
 *
 * The card shows one photo at a time, so without this a buyer has no way to
 * know a click reveals three more photos and a clip. Silent for the common
 * one-photo, no-video card: a "1 photo" chip is noise on the majority of the
 * grid.
 */
export function mediaCountLabel(images: unknown[], videos: unknown[]): string | null {
  const photos = Array.isArray(images) ? images.length : 0;
  const clips = Array.isArray(videos) ? videos.length : 0;
  const parts: string[] = [];
  if (photos > 1) parts.push(`📷 ${photos}`);
  if (clips > 0) parts.push(`▶ ${clips}`);
  return parts.length ? parts.join(" · ") : null;
}
