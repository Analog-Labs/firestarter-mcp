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
import { sanitizeUntrusted, sanitizeUntrustedOrNull } from "./untrusted.js";
import { toMinorUnits } from "./ucp-schema.js";
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

const previewOption = z.object({
  rank: z.number().int(),
  /** Listing/result id — chain to firestarter_execute when source is a FS store. */
  id: z.string(),
  title: z.string(),
  price_usd: z.number().nullable(),
  currency: z.string(),
  /** Integer minor units (e.g. cents) in the option's native currency. */
  price: z.object({ currency: z.string(), amount_minor: z.number().int().nullable() }),
  shipping: z.object({ known: z.boolean(), amount_usd: z.number().nullable() }),
  /** price + shipping when both are known, else null. */
  total_usd: z.number().nullable(),
  seller: z.string().nullable(),
  /** firestarter_seller | google_shopping | ... */
  source: z.string(),
  url: z.string().nullable(),
  image_url: z.string().nullable(),
  in_stock: z.boolean(),
  /** Checkout-capable through Firestarter (vs browse-only). */
  purchasable: z.boolean(),
  /** Passes every hard gate (budget / deadline / serviceability). */
  eligible: z.boolean(),
  blockers: z.array(z.object({ code: z.string(), label: z.string() })),
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
  current_price: z.number().nullable(),
  currency: z.string(),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({ currency: z.string(), amount_minor: z.number().int().nullable() }),
  buyable: z.boolean(),
  share_url: z.string().nullable(),
  /** http(s) product photo URLs; the shopping-results app renders images[0]. */
  images: z.array(z.string()),
  /** Seller's average review rating (1 decimal), null until they have reviews.
   *  Same aggregate the listing-detail endpoint returns. The shopping widget
   *  renders it as the card's stars row — without these two fields in the
   *  STRUCTURED row the widget can never show stars, no matter what the text
   *  rendering says (the mapper below is a strip-list, not a passthrough). */
  seller_rating: z.number().nullable(),
  /** Number of reviews behind seller_rating (0 when none). */
  seller_rating_count: z.number().int(),
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
      // Aggregate-only social proof, normalized like the API detail view:
      // rating null until reviews exist, count coerced to a non-negative int.
      seller_rating: toPriceOrNull(l?.seller_rating),
      seller_rating_count: Number.isFinite(Number(l?.seller_rating_count))
        ? Math.max(0, Math.trunc(Number(l.seller_rating_count)))
        : 0,
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
  current_price: z.number().nullable(),
  currency: z.string(),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({ currency: z.string(), amount_minor: z.number().int().nullable() }),
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
      current_price,
      currency,
      price: { currency, amount_minor: toMinorUnits(current_price, currency) },
      status,
      status_label: status ? (SELLER_STATUS_LABELS[status] ?? status) : null,
      inventory_qty: Number.isInteger(qty) ? qty : null,
      created_at: typeof l?.created_at === "string" ? l.created_at : null,
      share_url: listingShareUrl(l),
      images: httpImages(l?.images),
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
  current_price: z.number().nullable(),
  currency: z.string(),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({ currency: z.string(), amount_minor: z.number().int().nullable() }),
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
