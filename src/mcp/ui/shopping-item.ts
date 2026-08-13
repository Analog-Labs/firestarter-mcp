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
  price?: { amount_minor?: number | null; currency?: string } | null;
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

export function priceLabel(it: ShoppingItem): string {
  const currency = it.currency || it.price?.currency || "USD";
  const amount =
    typeof it.price_usd === "number" ? it.price_usd
      : typeof it.current_price === "number" ? it.current_price
        : typeof it.price?.amount_minor === "number" ? it.price.amount_minor / 100
          : null;
  return amount == null ? "" : `${currency} ${amount.toFixed(2)}`;
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
