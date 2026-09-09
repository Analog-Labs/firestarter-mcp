/**
 * Versioned output schemas + mappers for MCP tools that return structured data.
 *
 * Single source of truth: the Zod shapes here are advertised as a tool's
 * `outputSchema` (so agents get a typed, versioned contract) AND used by the
 * mappers that build the `structuredContent` returned at call time. Keeping both
 * in one module means a drift between the schema and the mapped object surfaces
 * as a typecheck/test failure rather than a silent runtime error.
 *
 * See MCP_P1_STRUCTURED_OUTPUTS.html for the audit + rollout plan.
 */
import { z } from "zod";
import { safeVideos, displayRating } from "./media.js";

/** A rating as a finite number, or null. Never NaN — a JSON payload can carry
 *  a string, and Number("") is 0, which would render as a real zero rating. */
function ratingOf(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== "" ? n : null;
}
import { sanitizeUntrusted, sanitizeUntrustedOrNull } from "./untrusted.js";
import { currencyExponent, toMinorUnits } from "./ucp-schema.js";
import { listingShareUrl } from "../lib/share-link.js";

/**
 * Parse an API money field into a float, or null when it is absent or not a
 * number. `Number(null)` is 0 and `Number(undefined)` is NaN — neither is a
 * price, and NaN passes `typeof === "number"` while failing the schema, so both
 * are collapsed here rather than at each call site.
 */
function toPriceOrNull(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Keep only http(s) URLs — the grid must never be handed a broken or unsafe src. */
function httpImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
}

/** Dated schema version, surfaced in every structured payload (à la UCP). */
export const MCP_OUTPUT_SCHEMA_VERSION = "2026-07-07";

/**
 * Human-readable copy for the eligibility/blocker reason codes emitted by
 * `services/preview.ts`. Used for BOTH the prose rendering and the structured
 * `blockers[].label` so the two never diverge.
 */
export const PREVIEW_REASON_LABELS: Record<string, string> = {
  NOT_CHECKOUT_CAPABLE: "browse-only (can't check out here)",
  BUDGET_EXCEEDED: "over budget",
  BELOW_MIN_BUDGET: "below your price floor",
  OUT_OF_STOCK: "out of stock",
  RELEVANCE_BELOW_FLOOR: "weak match",
  DEADLINE_INFEASIBLE: "can't arrive by the deadline",
  DEADLINE_UNKNOWN: "delivery time unknown",
  DESTINATION_UNSERVICEABLE: "doesn't ship to that destination",
};

/** https-only photo list. Same rule as the API's safeImages: `javascript:` is
 *  XSS in any host that renders the URL, `data:` smuggles bytes past every
 *  fetch-time check, and `http:` is mixed content that silently fails. */
function httpsImages(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((u): u is string => typeof u === "string" && /^https:\/\//i.test(u))
    : [];
}

/** A real aggregate or null. Never 0 — see previewOption.rating. */
function ratingOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ─── The money unit contract, stated ON THE WIRE ────────────────────────────
 *
 * These four strings exist because JSDoc does not reach an agent. Every price
 * field below already carried an "Integer minor units" doc comment — and zod
 * emits none of it into the JSON Schema a model actually receives, so a
 * consumer integrating against this server read `amount_minor: 1290` as 1290
 * currency units and reported "Firestarter prices off by 100x".
 *
 * Only `.describe()` is published. The contract is therefore written here once
 * and attached to every shape that carries a price: change the wording in one
 * place, or the shapes start telling agents different things.
 */
const AMOUNT_MINOR_DESC =
  "INTEGER amount in the currency's ISO-4217 MINOR units — 1290 with currency MYR means RM 12.90. "
  + "To get the amount a buyer is quoted, divide by 10^(ISO-4217 exponent for `currency`), NEVER by a hardcoded 100: "
  + "the exponent is 2 for MYR/SGD/THB/USD/EUR, 0 for JPY/KRW/VND (1290 JPY minor units IS ¥1290), and 3 for KWD/BHD/OMR. "
  + "Use `current_price` instead when you just need the displayable amount.";
const PRICE_CURRENCY_DESC =
  "ISO-4217 currency code for BOTH `amount_minor` and `current_price` — it sets the minor-unit exponent, so read it before dividing.";
const CURRENT_PRICE_DESC =
  "The price in MAJOR units (12.90 for RM 12.90, 1290 for ¥1290) in `currency` — already divided by the ISO-4217 exponent. "
  + "This is the number to quote a buyer and the number to pass to firestarter_record_purchase's `amount`. Null when the row carries no price.";
const PRICE_USD_DESC =
  "Price in MAJOR units and ONLY when `currency` is USD; null for every other currency — it is never a converted estimate. "
  + "For a non-USD row read `current_price` (major units) or `price.amount_minor` (minor units) instead.";

const previewOption = z.object({
  rank: z.number().int(),
  /** Listing/result id — chain to firestarter_execute when source is a FS store. */
  id: z.string(),
  title: z.string(),
  price_usd: z.number().nullable().describe(PRICE_USD_DESC),
  /** Major units in `currency` — the displayable price. Optional because
   *  firestarter_preview's own rows predate it and carry price_usd only; every
   *  marketplace-scout row sets it. */
  current_price: z.number().nullable().optional().describe(CURRENT_PRICE_DESC),
  currency: z.string().describe(PRICE_CURRENCY_DESC),
  /** Integer minor units (e.g. cents) in the option's native currency. */
  price: z.object({
    currency: z.string().describe(PRICE_CURRENCY_DESC),
    amount_minor: z.number().int().nullable().describe(AMOUNT_MINOR_DESC),
  }),
  shipping: z.object({ known: z.boolean(), amount_usd: z.number().nullable() }),
  /** price + shipping when both are known, else null. */
  total_usd: z.number().nullable(),
  seller: z.string().nullable(),
  /** firestarter_seller | google_shopping | ... */
  source: z.string(),
  url: z.string().nullable(),
  image_url: z.string().nullable(),
  /** Full https photo set; the shopping-results app grid-renders these. */
  images: z.array(z.string()),
  /** Playable video: url + optional poster. Deliberately not content type or
   *  byte size — an agent relays or links these, it does not decode them. */
  videos: z.array(z.object({ url: z.string(), poster_url: z.string().nullable() })),
  /** THIS product's own aggregate. Null until it has a review of its own. */
  product_rating: z.number().nullable(),
  product_rating_count: z.number().int(),
  /** The seller's aggregate across all their products. */
  seller_rating: z.number().nullable(),
  seller_rating_count: z.number().int(),
  /** True when `rating` above is the SELLER's, standing in for a product with
   *  no reviews yet — renderers must label it rather than imply it is this
   *  item's. */
  rating_is_seller_level: z.boolean(),
  /** The SELLER's Firestarter review aggregate (1dp) and its count. Null/0 when
   *  the seller has no reviews — the widget's starsLabel renders nothing rather
   *  than an empty state, so a zero must never be manufactured here. */
  rating: z.number().nullable(),
  rating_count: z.number().int(),
  /** Delivered/completed non-test sales of this listing. 0 for external results. */
  units_sold: z.number().int(),
  in_stock: z.boolean(),
  /** Checkout-capable through Firestarter (vs browse-only). */
  purchasable: z.boolean(),
  /** Passes every hard gate (budget / deadline / serviceability). */
  eligible: z.boolean(),
  blockers: z.array(z.object({ code: z.string(), label: z.string() })),
  /** Marketplace scout: badge for a row that is not purchasable THROUGH
   *  Firestarter but is buyable elsewhere ("Buy in app"). Absent for native rows. */
  external_buy_label: z.string().nullable().optional(),
});

/** Raw shape advertised as `firestarter_preview`'s `outputSchema`. */
export const previewOutputShape = {
  schema_version: z.literal(MCP_OUTPUT_SCHEMA_VERSION),
  query: z.string(),
  destination: z.object({ country: z.string().nullable(), city: z.string().nullable() }).nullable(),
  /** Echoed structured buyer context (locale, currency, intent). */
  context: z.object({
    language: z.string().nullable(),
    currency: z.string().nullable(),
    intent: z.string().nullable(),
  }),
  count: z.number().int(),
  buyable_count: z.number().int(),
  /** Cursor pagination for the option list. */
  page: z.object({
    limit: z.number().int(),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  }),
  blocked: z.boolean(),
  reason: z.string().nullable(),
  options: z.array(previewOption),
};

export const previewOutputSchema = z.object(previewOutputShape);
export type PreviewStructured = z.infer<typeof previewOutputSchema>;

/**
 * Map a `/commerce/preview` response into the typed structured payload. Handles
 * the success, empty, and blocked shapes uniformly (options default to []), so
 * every non-error return path of the tool can attach a schema-valid object.
 */
export function toPreviewStructured(
  data: any,
  input: { query: string; country?: string; city?: string; language?: string; currency?: string; intent?: string },
): PreviewStructured {
  const rawOptions: any[] = Array.isArray(data?.options) ? data.options : [];
  const options = rawOptions.map((o: any, i: number) => {
    const priceNum = Number(o?.price);
    const price_usd = Number.isFinite(priceNum) ? priceNum : null;
    const known = !!o?.shipping?.known;
    const amount_usd = typeof o?.shipping?.amount_usd === "number" ? o.shipping.amount_usd : null;
    const total_usd =
      price_usd != null && known ? Math.round((price_usd + (amount_usd ?? 0)) * 100) / 100 : null;
    const currency = typeof o?.currency === "string" ? o.currency : "USD";
    return {
      rank: i + 1,
      id: typeof o?.id === "string" ? o.id : "",
      title: sanitizeUntrusted(o?.title),
      price_usd,
      currency,
      // Machine-precise money in the option's native currency, alongside the float
      // above. Minor units honor the ISO-4217 exponent (USD=2, JPY=0, KWD=3).
      price: { currency, amount_minor: toMinorUnits(price_usd, currency) },
      shipping: { known, amount_usd },
      total_usd,
      seller: sanitizeUntrustedOrNull(o?.seller, 120),
      source: typeof o?.source === "string" ? o.source : "unknown",
      url: typeof o?.url === "string" ? o.url : null,
      image_url: typeof o?.image_url === "string" ? o.image_url : null,
      images: httpsImages(o?.images),
      videos: safeVideos(o?.videos),
      product_rating: ratingOf(o?.product_rating),
      product_rating_count: Number(o?.product_rating_count) || 0,
      seller_rating: ratingOf(o?.seller_rating),
      seller_rating_count: Number(o?.seller_rating_count) || 0,
      // DISPLAY rating: product-first, seller fallback. 2.10.0 fixed exactly
      // this in toCatalogStructured and missed the identical line here, so
      // firestarter_preview — the keyless, first-contact agent surface — served
      // the seller's stars under the display field's name while asserting
      // is_seller_level=false. Worse than showing nothing: it claimed the
      // number was about the product.
      rating: displayRating(o).rating,
      rating_count: displayRating(o).rating_count,
      rating_is_seller_level: displayRating(o).is_seller_level,
      units_sold: Number(o?.units_sold) || 0,
      in_stock: o?.in_stock !== false,
      purchasable: !!o?.purchasable,
      eligible: !!o?.eligible,
      blockers: Array.isArray(o?.reasons)
        ? o.reasons.map((code: string) => ({ code, label: PREVIEW_REASON_LABELS[code] ?? code }))
        : [],
    };
  });
  const destination =
    input.country || input.city ? { country: input.country ?? null, city: input.city ?? null } : null;
  // Prefer the service-echoed context; fall back to the tool's input.
  const dctx = data?.context ?? {};
  const context = {
    language: (typeof dctx.language === "string" ? dctx.language : input.language) ?? null,
    currency: (typeof dctx.currency === "string" ? dctx.currency : input.currency) ?? null,
    intent: (typeof dctx.intent === "string" ? dctx.intent : input.intent) ?? null,
  };
  const dpage = data?.page ?? {};
  const page = {
    limit: Number.isInteger(dpage.limit) ? dpage.limit : 10,
    next_cursor: typeof dpage.next_cursor === "string" ? dpage.next_cursor : null,
    has_more: !!dpage.has_more,
  };
  return {
    schema_version: MCP_OUTPUT_SCHEMA_VERSION,
    query: typeof data?.query === "string" ? data.query : input.query,
    destination,
    context,
    count: options.length,
    buyable_count: options.filter((o) => o.purchasable && o.eligible).length,
    page,
    blocked: !!data?.blocked,
    reason: typeof data?.reason === "string" ? data.reason : null,
    options,
  };
}

const catalogListing = z.object({
  /** Listing id (lst_...) — chain to firestarter_execute's listing_id to buy. */
  id: z.string(),
  product_name: z.string(),
  category: z.string().nullable(),
  current_price: z.number().nullable().describe(CURRENT_PRICE_DESC),
  currency: z.string().describe(PRICE_CURRENCY_DESC),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({
    currency: z.string().describe(PRICE_CURRENCY_DESC),
    amount_minor: z.number().int().nullable().describe(AMOUNT_MINOR_DESC),
  }),
  buyable: z.boolean(),
  share_url: z.string().nullable(),
  /** http(s) product photo URLs; the shopping-results app renders images[0]. */
  images: z.array(z.string()),
  /** Playable video: url + optional poster. Deliberately not content type or
   *  byte size — an agent relays or links these, it does not decode them. */
  videos: z.array(z.object({ url: z.string(), poster_url: z.string().nullable() })),
  /** THIS product's own aggregate. Null until it has a review of its own. */
  product_rating: z.number().nullable(),
  product_rating_count: z.number().int(),
  /** True when `rating` above is the SELLER's, standing in for a product with
   *  no reviews yet — renderers must label it rather than imply it is this
   *  item's. */
  rating_is_seller_level: z.boolean(),
  /** Seller's average review rating (1 decimal), null until they have reviews.
   *  Same aggregate the listing-detail endpoint returns. The shopping widget
   *  renders it as the card's stars row — without these two fields in the
   *  STRUCTURED row the widget can never show stars, no matter what the text
   *  rendering says (the mapper below is a strip-list, not a passthrough). */
  seller_rating: z.number().nullable(),
  /** Number of reviews behind seller_rating (0 when none). */
  seller_rating_count: z.number().int(),
  /** DISPLAY rating: this product's own stars when it has any, the seller's
   *  otherwise (rating_is_seller_level says which). Null/0 when neither exists
   *  — never a manufactured zero. The widget reads these two. */
  rating: z.number().nullable(),
  rating_count: z.number().int(),
  /** Delivered/completed non-test sales of this listing. */
  units_sold: z.number().int(),
  picked_by_community: z.boolean(),
  pick_note: z.string().nullable(),
});

/** Raw shape advertised as `firestarter_catalog_search`'s `outputSchema`. */
export const catalogOutputShape = {
  schema_version: z.literal(MCP_OUTPUT_SCHEMA_VERSION),
  environment: z.string(),
  count: z.number().int(),
  buyable_count: z.number().int(),
  has_more: z.boolean(),
  /** Set when a zero-result query was broadened to its head noun. */
  broadened_to: z.string().nullable(),
  /** The buyer's community, when they're in one (attributes ★ picks). */
  community: z.string().nullable(),
  listings: z.array(catalogListing),
};

export const catalogOutputSchema = z.object(catalogOutputShape);
export type CatalogStructured = z.infer<typeof catalogOutputSchema>;

/**
 * Map a `/v1/listings/catalog` response into the typed structured payload the
 * shopping-results MCP App renders (its client reads `structuredContent.listings`
 * — same key handling as preview's `options`). Field names deliberately match
 * what the widget already understands: product_name, images, current_price,
 * currency, buyable, share_url.
 *
 * Every field is defaulted. The SDK validates `structuredContent` against the
 * advertised `outputSchema` on every call, so a blocked, empty, or partial API
 * response must still map to a schema-valid object rather than a tool error.
 */
export function toCatalogStructured(
  data: any,
  listings: any[],
  broadenedTo: string | null,
): CatalogStructured {
  const rows = listings.map((l: any) => {
    const priceNum = Number(l?.current_price);
    const current_price = Number.isFinite(priceNum) ? priceNum : null;
    const currency = typeof l?.currency === "string" ? l.currency : "USD";
    return {
      id: typeof l?.id === "string" ? l.id : "",
      product_name: sanitizeUntrusted(l?.product_name),
      category: sanitizeUntrustedOrNull(l?.category, 80),
      current_price,
      currency,
      price: { currency, amount_minor: toMinorUnits(current_price, currency) },
      buyable: !!l?.buyable,
      share_url: typeof l?.share_url === "string" ? l.share_url : null,
      images: Array.isArray(l?.images)
        ? l.images.filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
        : [],
      videos: safeVideos(l?.videos),
      product_rating: ratingOf(l?.product_rating),
      product_rating_count: Number(l?.product_rating_count) || 0,
      rating_is_seller_level: displayRating(l).is_seller_level,
      // Aggregate-only social proof, normalized like the API detail view:
      // rating null until reviews exist, count coerced to a non-negative int.
      seller_rating: toPriceOrNull(l?.seller_rating),
      seller_rating_count: Number.isFinite(Number(l?.seller_rating_count))
        ? Math.max(0, Math.trunc(Number(l.seller_rating_count)))
        : 0,
      // THE fix: `rating` was the SELLER's aggregate wearing the display
      // field's name, so an agent saw seller stars where apps/web showed
      // product stars for the same listing.
      rating: displayRating(l).rating,
      rating_count: displayRating(l).rating_count,
      units_sold: Number(l?.units_sold) || 0,
      picked_by_community: l?.picked_by_community === true,
      pick_note: sanitizeUntrustedOrNull(l?.pick_note),
    };
  });
  return {
    schema_version: MCP_OUTPUT_SCHEMA_VERSION,
    environment: typeof data?.query?.environment === "string" ? data.query.environment : "live",
    count: rows.length,
    buyable_count: rows.filter((r) => r.buyable).length,
    has_more: !!data?.has_more,
    broadened_to: broadenedTo,
    community: sanitizeUntrustedOrNull(data?.query?.community?.name, 120),
    listings: rows,
  };
}

/**
 * Seller-facing status → the badge the product grid shows on the card. A
 * seller's own listing carries a lifecycle status, never the `buyable` flag the
 * buyer-facing tools return, and the widget's fallback badge is "Browse-only" —
 * so without an explicit label a seller's own live listing would render as
 * something nobody can buy. Unknown statuses fall through to the raw string
 * rather than being dropped.
 */
const SELLER_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  draft: "Draft",
  paused: "Paused",
  delisted: "Delisted",
  sold_out: "Sold out",
  out_of_stock: "Out of stock",
};

const sellerListing = z.object({
  /** Listing id (lst_...) — pass to firestarter_update_listing or share. */
  id: z.string(),
  product_name: z.string(),
  /** Buyer-facing description, null when the seller never set one. Surfaced so
   *  a seller checking their own listing can SEE the description is saved —
   *  "descriptions not saving" was partly descriptions never being shown. */
  description: z.string().nullable(),
  current_price: z.number().nullable().describe(CURRENT_PRICE_DESC),
  currency: z.string().describe(PRICE_CURRENCY_DESC),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({
    currency: z.string().describe(PRICE_CURRENCY_DESC),
    amount_minor: z.number().int().nullable().describe(AMOUNT_MINOR_DESC),
  }),
  /** Raw lifecycle status from the API (active, draft, …). */
  status: z.string().nullable(),
  /** Human-readable badge for the grid; null when the API sent no status. */
  status_label: z.string().nullable(),
  inventory_qty: z.number().int().nullable(),
  created_at: z.string().nullable(),
  /** Null for sandbox and non-active listings, which have no public page. */
  share_url: z.string().nullable(),
  /** http(s) product photo URLs; the shopping-results app renders images[0]. */
  images: z.array(z.string()),
  /** Playable video: url + optional poster. Deliberately not content type or
   *  byte size — an agent relays or links these, it does not decode them. */
  videos: z.array(z.object({ url: z.string(), poster_url: z.string().nullable() })),
  /** THIS product's own aggregate. Null until it has a review of its own. */
  product_rating: z.number().nullable(),
  product_rating_count: z.number().int(),
  /** The seller's aggregate across all their products. */
  seller_rating: z.number().nullable(),
  seller_rating_count: z.number().int(),
  // No rating_is_seller_level here, deliberately: this shape carries no
  // combined `rating` field for the flag to qualify. A seller looking at their
  // OWN listings gets both aggregates explicitly and needs no display rule —
  // 2.10.0 added the flag to all three shapes uniformly, which left a dangling
  // qualifier on the one shape that has nothing to qualify.
});

/** Raw shape advertised as `firestarter_listings`'s `outputSchema`. */
export const sellerListingsOutputShape = {
  schema_version: z.literal(MCP_OUTPUT_SCHEMA_VERSION),
  count: z.number().int(),
  active_count: z.number().int(),
  listings: z.array(sellerListing),
};

export const sellerListingsOutputSchema = z.object(sellerListingsOutputShape);
export type SellerListingsStructured = z.infer<typeof sellerListingsOutputSchema>;

/**
 * Map `/v1/listings` rows (list view or a single detail row) into the typed
 * payload the shopping-results MCP App renders. Same `listings` key the catalog
 * mapper emits, so the widget needs no branch to tell the two apart.
 *
 * Every field is defaulted: the SDK validates `structuredContent` against the
 * advertised `outputSchema` on every call, so an empty or partial API response
 * must still map to a schema-valid object rather than a tool error.
 */
export function toSellerListingsStructured(listings: any[]): SellerListingsStructured {
  const rows = (Array.isArray(listings) ? listings : []).map((l: any) => {
    const current_price = toPriceOrNull(l?.current_price);
    const currency = typeof l?.currency === "string" ? l.currency : "USD";
    const status = typeof l?.status === "string" && l.status.trim() ? l.status.trim() : null;
    const qty = Number(l?.inventory_qty);
    return {
      id: typeof l?.id === "string" ? l.id : "",
      product_name: typeof l?.product_name === "string" ? l.product_name : "",
      description: typeof l?.description === "string" && l.description.trim() ? l.description : null,
      current_price,
      currency,
      price: { currency, amount_minor: toMinorUnits(current_price, currency) },
      status,
      status_label: status ? (SELLER_STATUS_LABELS[status] ?? status) : null,
      inventory_qty: Number.isInteger(qty) ? qty : null,
      created_at: typeof l?.created_at === "string" ? l.created_at : null,
      share_url: listingShareUrl(l),
      images: httpImages(l?.images),
      videos: safeVideos(l?.videos),
      product_rating: ratingOf(l?.product_rating),
      product_rating_count: Number(l?.product_rating_count) || 0,
      seller_rating: ratingOf(l?.seller_rating),
      seller_rating_count: Number(l?.seller_rating_count) || 0,
    };
  });
  return {
    schema_version: MCP_OUTPUT_SCHEMA_VERSION,
    count: rows.length,
    active_count: rows.filter((r) => r.status === "active").length,
    listings: rows,
  };
}

/**
 * Badge per shelf surface. A community market shows two disjoint sets of
 * products — listings the owner curated from other sellers, and the owner's
 * own stock — and flattening them into one grid would erase that distinction
 * without a label. Neither surface carries a buyability flag, so the badge is
 * provenance, not checkout state.
 */
const SHELF_KIND_LABELS = { pick: "★ Pick", sells: "Sold here" } as const;

const shelfItem = z.object({
  /** Listing id (lst_...) — chain to firestarter_execute's listing_id to buy. */
  id: z.string(),
  product_name: z.string(),
  current_price: z.number().nullable().describe(CURRENT_PRICE_DESC),
  currency: z.string().describe(PRICE_CURRENCY_DESC),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({
    currency: z.string().describe(PRICE_CURRENCY_DESC),
    amount_minor: z.number().int().nullable().describe(AMOUNT_MINOR_DESC),
  }),
  /** http(s) product photo URLs; the shopping-results app renders images[0]. */
  images: z.array(z.string()),
  /** Which surface this came from: a curated pick, or the community's own stock. */
  kind: z.enum(["pick", "sells"]),
  status_label: z.string(),
  /** The curator's note on a pick — why they chose it. */
  note: z.string().nullable(),
  /** Tier gate on a pick (0 = open to every member). */
  min_tier: z.number().int().nullable(),
});

/** Raw shape advertised as the community-market tools' `outputSchema`. */
export const shelfOutputShape = {
  schema_version: z.literal(MCP_OUTPUT_SCHEMA_VERSION),
  community: z.string().nullable(),
  pick_count: z.number().int(),
  sells_count: z.number().int(),
  listings: z.array(shelfItem),
};

export const shelfOutputSchema = z.object(shelfOutputShape);
export type ShelfStructured = z.infer<typeof shelfOutputSchema>;

/**
 * Map a community's `picks` + `sells` into the typed payload the
 * shopping-results MCP App renders, picks first.
 *
 * Two normalizations matter here. The shelf API sends a single `image` string
 * where the widget expects an `images` array, and a bare number `price` where a
 * `price` key means `{amount_minor, currency}` — a number falls through the
 * widget's price formatting and renders blank. Both are fixed here rather than
 * by loosening the widget, which would weaken the typed contract for agents.
 *
 * The shelf payload carries no currency; the prose render has always assumed
 * dollars, so USD stays the default.
 *
 * Unlike the prose render this does NOT truncate at SHELF_RENDER_LIMIT — a grid
 * has room for the whole shelf, which is the point of showing one.
 */
export function toShelfStructured(community: any): ShelfStructured {
  const mapRow = (row: any, kind: "pick" | "sells") => {
    const current_price = toPriceOrNull(row?.price);
    const currency = typeof row?.currency === "string" ? row.currency : "USD";
    const minTier = Number(row?.min_tier);
    return {
      id: typeof row?.listing_id === "string" ? row.listing_id : "",
      product_name: typeof row?.product_name === "string" ? row.product_name : "",
      current_price,
      currency,
      price: { currency, amount_minor: toMinorUnits(current_price, currency) },
      images: httpImages([row?.image]),
      kind,
      status_label: SHELF_KIND_LABELS[kind],
      note: typeof row?.note === "string" && row.note.trim() ? row.note.trim() : null,
      min_tier: Number.isInteger(minTier) ? minTier : null,
    };
  };
  const picks = (Array.isArray(community?.picks) ? community.picks : []).map((p: any) => mapRow(p, "pick"));
  const sells = (Array.isArray(community?.sells) ? community.sells : []).map((s: any) => mapRow(s, "sells"));
  return {
    schema_version: MCP_OUTPUT_SCHEMA_VERSION,
    community:
      typeof community?.name === "string" && community.name.trim() ? community.name.trim() : null,
    pick_count: picks.length,
    sells_count: sells.length,
    listings: [...picks, ...sells],
  };
}

/* ─── Marketplace scout (#1056) ─────────────────────────────────────────── */

const scoutNeedsInput = z.object({
  kind: z.string(),
  marketplace: z.string(),
  live_view_url: z.string(),
  expires_at: z.string(),
});

/**
 * Raw shape advertised as `firestarter_marketplace_search`'s `outputSchema`.
 * Rows reuse the preview option shape under `options` so the shopping-results
 * MCP App renders them with no client change.
 */
export const marketplaceOutputShape = {
  schema_version: z.literal(MCP_OUTPUT_SCHEMA_VERSION),
  job_id: z.string(),
  /** queued | running | needs_input | completed | failed | cancelled | expired */
  status: z.string(),
  query: z.string(),
  environment: z.string(),
  count: z.number().int(),
  checkoutable_count: z.number().int(),
  /** Per-source state: queued | running | done | cached | not_connected | needs_login | timeout | failed:<code> */
  progress: z.record(z.string(), z.string()),
  cached_sources: z.array(z.string()),
  needs_input: scoutNeedsInput.nullable(),
  options: z.array(previewOption),
};

export const marketplaceOutputSchema = z.object(marketplaceOutputShape);
export type MarketplaceStructured = z.infer<typeof marketplaceOutputSchema>;

/**
 * One product card as the buyer's OWN browser saw it (Cole's browser_products).
 *
 * Deliberately loose, and that is load-bearing: the MCP SDK enforces this
 * shape BEFORE the handler runs and answers any failure as an `isError: true`
 * result carrying "MCP error -32602" text — which the host this exists for
 * throws on. So one card with `price: ""` (routine: browser_products types
 * price as a non-nullable string) or one from a store the API does not know
 * must not be able to fail the other four. No `min(1)` on `price_text`,
 * `title`, `url` or `items`; `marketplace` is a string rather than an enum;
 * `rating`/`reviews` are any number (a scraped -1 or 1234.5 is normalised or
 * omitted per card). The handler drops or fits what the API would refuse and
 * says so in the `compared:` header, and the API remains the validator for
 * everything else (its 400 renders as a plain sentence). What is left that
 * can reject a whole call at this layer is a wrong JSON type or a string past
 * a sanity bound — caller bugs, not card imperfections. `price_text` keeps only a sanity cap
 * here: the route's own cap is 80, and the handler slices to it, because a
 * long price range is a per-card imperfection — a row to trim, never a batch
 * to reject.
 *
 * Only `.describe()` reaches the wire, so the parsing contract for `price_text`
 * and `sold_text` lives there, not in a comment.
 */
const capturedItem = z.object({
  marketplace: z.string().max(32).describe("Which storefront the card came from: lazada or shopee. A card from any other store is dropped from the comparison (the header says how many)."),
  title: z.string().max(500).describe("Product title as shown on the card."),
  price_text: z.string().max(400).describe("The price EXACTLY as the page shows it — '฿29', '29 บาท', 'RM12.90', 'S$4.50', '1,290', '฿1,290 - ฿1,590'. Firestarter parses it (the first price in the text wins; anything past 80 characters is cut off); do not convert it or strip the currency. Send an empty string when the card shows no price: that card is dropped from the comparison, never priced 0, and the others still rank."),
  url: z.string().max(2048).describe("The card's product page URL — becomes the row id and the Buy link."),
  image_url: z.string().max(2048).nullable().optional().describe("Product photo URL from the card, if any. Omit it (or send null) when the card has none; a value that is not a URL is ignored, never a reason to drop the card."),
  sold_text: z.string().max(100).nullable().optional().describe("The sold count EXACTLY as shown — 'ขายแล้ว 1.2พัน', '2.5k sold', '350 sold', '10K+ sold'. Parsed server-side into a number for ranking."),
  rating: z.number().nullable().optional().describe("Star rating on the card, if shown (e.g. 4.8). A negative or unreadable value is ignored, never a reason to drop the card."),
  reviews: z.number().nullable().optional().describe("Review count on the card, if shown. Rounded to a whole number; a negative or unreadable value is ignored, never a reason to drop the card."),
});

/** Raw shape advertised as `firestarter_marketplace_compare`'s input. */
export const marketplaceCompareInputShape = {
  country: z.string().length(2).optional().describe("Storefront country the cards came from — TH, MY or SG. Sets the currency the prices are parsed in (THB, MYR, SGD). Default: the buyer's connected marketplace's country, else the API's default storefront."),
  items: z.array(capturedItem).max(50).describe("The cards browser_products returned — up to 50, from every marketplace the person searched, in ONE call. Cards with no readable price or from an unsupported store are dropped, never the whole call."),
  max_price: z.number().positive().optional().describe("Drop rows above this price, in the storefront currency's MAJOR units (e.g. 30 for ฿30 / RM30)."),
};

const SCOUT_BLOCKER_LABELS: Record<string, string> = {
  NOT_CONNECTED: "buy in the marketplace app via the link",
  EXTERNAL_LINK: "buy directly via the link",
  ON_NETWORK: "buy with firestarter_execute (listing id in the result)",
};

/** "Pay only" / "Buy in app · 2 taps" — the handoff, stated honestly from the adapter's buy_steps. */
function buyBadge(r: any): string {
  const steps = Array.isArray(r?.buy_steps) ? r.buy_steps.filter((s: unknown) => typeof s === "string") : [];
  if (steps.length === 1 && /^pay$/i.test(steps[0])) return "Pay only";
  if (steps.length > 0) return `Buy in app · ${steps.length} tap${steps.length === 1 ? "" : "s"}`;
  return "Buy in app";
}

/** Map a /v1/scout job (search) into the typed structured payload. Every field defaulted. */
export function toMarketplaceStructured(job: any): MarketplaceStructured {
  const results: any[] = Array.isArray(job?.results) ? job.results : [];
  const progress: Record<string, string> = {};
  for (const [k, v] of Object.entries(job?.progress ?? {})) progress[k] = typeof v === "string" ? v : String(v);
  const options = results.map((r: any, i: number) => {
    const currency = typeof r?.currency === "string" ? r.currency : "USD";
    const amount_minor = Number.isInteger(r?.price_minor) ? r.price_minor : null;
    // THE fix. This mapper was the only one emitting no major-unit price, so a
    // consumer had nothing correct to read — and the field it did emit as
    // `price_usd` is not a price at all: it is scout/rank.ts's ranking key,
    // computed from a deliberately over-estimating static FX table whose own
    // source comment says "never use for charging or displaying money". Read as
    // this row's price it turned RM 12.90 into "MYR 3.87", reported from the
    // field as "prices off by 100x".
    //
    // So: derive the displayable amount from the minor units the adapters
    // genuinely produce, honoring the ISO-4217 exponent (MYR=2, JPY=0, KWD=3),
    // and keep price_usd only where it is literally true.
    const current_price = amount_minor == null ? null : amount_minor / 10 ** currencyExponent(currency);
    const price_usd = currency.trim().toUpperCase() === "USD" ? current_price : null;
    const checkoutable = r?.checkoutable === true;
    const media: Array<{ type: string; url: string }> = Array.isArray(r?.media)
      ? r.media.filter((m: any) => m && typeof m.url === "string" && (m.type === "image" || m.type === "video"))
      : [];
    const rating = typeof r?.rating === "number" && Number.isFinite(r.rating) ? r.rating : null;
    const ratingCount = Number.isInteger(r?.rating_count) && r.rating_count > 0 ? r.rating_count : 0;
    const blocker = checkoutable ? null
      : r?.on_network ? "ON_NETWORK"
      : r?.source === "shopee" || r?.source === "lazada" ? "NOT_CONNECTED"
      : "EXTERNAL_LINK";
    return {
      rank: i + 1,
      id: typeof r?.id === "string" ? r.id : "",
      title: typeof r?.title === "string" ? r.title : "",
      price_usd,
      current_price,
      currency,
      price: { currency, amount_minor },
      shipping: { known: false, amount_usd: null },
      total_usd: null,
      seller: typeof r?.seller_name === "string" ? r.seller_name : null,
      source: typeof r?.source === "string" ? r.source : "unknown",
      url: typeof r?.buy_url === "string" ? r.buy_url : typeof r?.product_url === "string" ? r.product_url : null,
      image_url: typeof r?.image_url === "string" ? r.image_url : null,
      images: media.filter((m) => m.type === "image").map((m) => m.url),
      videos: media.filter((m) => m.type === "video").map((m) => ({ url: m.url, poster_url: null })),
      // Marketplace ratings are per product; the scout has no seller aggregate.
      product_rating: rating,
      product_rating_count: ratingCount,
      seller_rating: null,
      seller_rating_count: 0,
      rating_is_seller_level: false,
      rating,
      rating_count: ratingCount,
      units_sold: Number.isInteger(r?.sold_count) && r.sold_count > 0 ? r.sold_count : 0,
      in_stock: r?.in_stock !== false,
      purchasable: checkoutable,
      eligible: checkoutable,
      blockers: blocker ? [{ code: blocker, label: SCOUT_BLOCKER_LABELS[blocker] }] : [],
      external_buy_label: checkoutable || r?.on_network ? null : typeof r?.buy_url === "string" ? buyBadge(r) : null,
    };
  });
  const ni = job?.needs_input;
  return {
    schema_version: MCP_OUTPUT_SCHEMA_VERSION,
    job_id: typeof job?.id === "string" ? job.id : "",
    status: typeof job?.status === "string" ? job.status : "unknown",
    query: typeof job?.query === "string" ? job.query : "",
    environment: typeof job?.environment === "string" ? job.environment : "live",
    count: options.length,
    checkoutable_count: options.filter((o) => o.purchasable).length,
    progress,
    cached_sources: Object.entries(progress).filter(([, v]) => v === "cached").map(([k]) => k),
    needs_input: ni && typeof ni === "object"
      ? { kind: String(ni.kind ?? ""), marketplace: String(ni.marketplace ?? ""), live_view_url: String(ni.live_view_url ?? ""), expires_at: String(ni.expires_at ?? "") }
      : null,
    options,
  };
}
