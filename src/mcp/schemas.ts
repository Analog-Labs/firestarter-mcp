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
