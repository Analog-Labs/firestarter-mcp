/**
 * UCP (Universal Commerce Protocol) catalog projection — schemas + mappers.
 *
 * P6 / audit finding #7 ("Open interop"). This module projects Firestarter's
 * existing listing data into the UCP catalog capability shapes
 * (https://ucp.dev/2026-04-08/specification/catalog/) so any UCP-aware agent
 * (Shopify Global Catalog clients, Google AI Mode / Gemini, AP2 shopping
 * agents) can read our catalog with zero Firestarter-specific knowledge.
 *
 * It is a PURE, additive projection: no DB access, no network. The existing
 * `firestarter_*` tools, `/commerce/preview`, `agents.json`, and `mcp.json` are
 * untouched — UCP is a new surface alongside them, never a replacement.
 *
 * Honesty constraints (see MCP_P6_UCP_CATALOG.html §03):
 *   - Firestarter listings are SINGLE-VARIANT (one price, one inventory count,
 *     one currency). Each listing → one Product with exactly one Variant, and
 *     price_range.min == price_range.max. We never fabricate option axes.
 *   - listing.category is a free string → Category { value, taxonomy: "merchant" }.
 *     We never claim a google_product_category mapping we don't have.
 *   - Money is emitted in ISO-4217 MINOR units using the currency's real
 *     exponent (USD=2, JPY=0, KWD=3) — not a hardcoded *100.
 */
import { z } from "zod";

/** Dated UCP catalog spec version this projection targets. */
export const UCP_CATALOG_VERSION = "2026-04-08";

/** Reverse-domain id of the UCP catalog capability we advertise. */
export const UCP_CATALOG_CAPABILITY = "dev.ucp.shopping.catalog";

// ─── Currency minor units ─────────────────────────────────────────────────────
// UCP Price.amount is an integer in the currency's minor unit, where the number
// of minor digits is the ISO-4217 exponent. Most currencies use 2 (cents), but
// zero-decimal (JPY, KRW, ...) and three-decimal (KWD, BHD, ...) currencies
// exist. Default to 2 for anything not listed.
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** ISO-4217 minor-unit exponent for a currency code (defaults to 2). */
export function currencyExponent(currency: string | null | undefined): number {
  const code = (currency ?? "USD").trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/**
 * Convert a major-unit amount (e.g. dollars 18.5) to integer minor units in the
 * currency's exponent (e.g. USD → 1850). Returns null for non-finite input.
 */
export function toMinorUnits(major: number | null | undefined, currency: string | null | undefined): number | null {
  if (major == null) return null;
  const n = Number(major);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** currencyExponent(currency));
}

// ─── UCP type schemas (the subset the catalog capability uses) ────────────────

/** UCP Description — content in one or more formats. */
export const ucpDescriptionSchema = z.object({
  plain: z.string().optional(),
  html: z.string().optional(),
  markdown: z.string().optional(),
});

/** UCP Price — integer minor units + ISO-4217 currency. 0 = free. */
export const ucpPriceSchema = z.object({
  amount: z.number().int().nullable(),
  currency: z.string(),
});

/** UCP Price Range — min/max across variants (min == max for single-variant). */
export const ucpPriceRangeSchema = z.object({
  min: ucpPriceSchema,
  max: ucpPriceSchema,
});

/** UCP Category — value + source taxonomy. */
export const ucpCategorySchema = z.object({
  value: z.string(),
  taxonomy: z.string().optional(),
});

/** UCP Media — typed media resource (we only emit images today). */
export const ucpMediaSchema = z.object({
  type: z.string(),
  url: z.string(),
  alt_text: z.string().optional(),
});

/**
 * Variant availability. UCP leaves `availability` as an open object; we emit a
 * small, honest shape derived from inventory + seller checkout capability.
 */
export const ucpAvailabilitySchema = z.object({
  in_stock: z.boolean(),
  /** Checkout-capable through Firestarter (seller has an active payout method). */
  purchasable: z.boolean(),
});

/** UCP Variant — the purchasable unit; its id is `item.id` at checkout. */
export const ucpVariantSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: ucpDescriptionSchema,
  url: z.string().nullable(),
  price: ucpPriceSchema,
  availability: ucpAvailabilitySchema,
  media: z.array(ucpMediaSchema),
});

/** UCP Product — one per Firestarter listing, carrying a single variant. */
export const ucpProductSchema = z.object({
  id: z.string(),
  handle: z.string().optional(),
  title: z.string(),
  description: ucpDescriptionSchema,
  url: z.string().nullable(),
  categories: z.array(ucpCategorySchema),
  price_range: ucpPriceRangeSchema,
  media: z.array(ucpMediaSchema),
  options: z.array(z.unknown()),
  variants: z.array(ucpVariantSchema),
});

/** UCP Pagination Response — cursor + has_next_page (+ optional total_count). */
export const ucpPaginationSchema = z.object({
  cursor: z.string().nullable(),
  has_next_page: z.boolean(),
  total_count: z.number().int().optional(),
});

/** Minimal UCP message (lookup misses, informational notices). */
export const ucpMessageSchema = z.object({
  type: z.enum(["error", "warning", "info"]),
  code: z.string().optional(),
  content: z.string(),
  path: z.string().optional(),
});

/** The `ucp` metadata object attached to every catalog response. */
export const ucpMetadataSchema = z.object({
  version: z.string(),
  status: z.enum(["success", "error"]),
  capabilities: z.record(z.string(), z.object({ version: z.string() })),
});

export const ucpCatalogSearchResponseSchema = z.object({
  ucp: ucpMetadataSchema,
  products: z.array(ucpProductSchema),
  pagination: ucpPaginationSchema,
  messages: z.array(ucpMessageSchema).optional(),
});

export const ucpCatalogLookupResponseSchema = z.object({
  ucp: ucpMetadataSchema,
  products: z.array(ucpProductSchema),
  messages: z.array(ucpMessageSchema).optional(),
});

export const ucpGetProductResponseSchema = z.object({
  ucp: ucpMetadataSchema,
  product: ucpProductSchema.nullable(),
  messages: z.array(ucpMessageSchema).optional(),
});

export type UcpPrice = z.infer<typeof ucpPriceSchema>;
export type UcpProduct = z.infer<typeof ucpProductSchema>;
export type UcpVariant = z.infer<typeof ucpVariantSchema>;
export type UcpPagination = z.infer<typeof ucpPaginationSchema>;
export type UcpMessage = z.infer<typeof ucpMessageSchema>;

// ─── Mappers ──────────────────────────────────────────────────────────────────

/**
 * The listing fields this projection needs — the public catalog projection
 * (publicListingView) plus the `buyable` flag and public share URL. Kept
 * structural (not imported from routes) so this module stays DB/route-free.
 */
export interface CatalogListing {
  id: string;
  product_name: string;
  category?: string | null;
  description?: string | null;
  images?: string[] | null;
  current_price: number;
  currency?: string | null;
  inventory_qty?: number | null;
  buyable?: boolean;
  share_url?: string | null;
}

/** URL-safe slug for the UCP `handle` (SEO-friendly, non-authoritative). */
function slugify(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function ucpMedia(images: string[] | null | undefined, altText: string): z.infer<typeof ucpMediaSchema>[] {
  return (Array.isArray(images) ? images : [])
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
    .map((url) => ({ type: "image", url, alt_text: altText }));
}

/** Project a Firestarter listing into a UCP Variant. */
export function toUcpVariant(listing: CatalogListing): UcpVariant {
  const currency = (listing.currency || "USD").toUpperCase();
  const inStock = listing.inventory_qty == null || Number(listing.inventory_qty) > 0;
  return {
    id: listing.id,
    title: listing.product_name,
    description: { plain: listing.description ?? "" },
    url: listing.share_url ?? null,
    price: { amount: toMinorUnits(listing.current_price, currency), currency },
    availability: { in_stock: inStock, purchasable: listing.buyable === true },
    media: ucpMedia(listing.images, listing.product_name),
  };
}

/**
 * Project a Firestarter listing into a UCP Product. Single-variant: the product
 * carries exactly one variant and price_range.min == price_range.max.
 */
export function toUcpProduct(listing: CatalogListing): UcpProduct {
  const variant = toUcpVariant(listing);
  const categories = listing.category
    ? [{ value: String(listing.category), taxonomy: "merchant" }]
    : [];
  return {
    id: listing.id,
    handle: slugify(listing.product_name),
    title: listing.product_name,
    description: { plain: listing.description ?? "" },
    url: listing.share_url ?? null,
    categories,
    price_range: { min: variant.price, max: variant.price },
    media: variant.media,
    options: [],
    variants: [variant],
  };
}

/** Build the `ucp` metadata object for a successful catalog response. */
export function ucpMetadata(status: "success" | "error" = "success"): z.infer<typeof ucpMetadataSchema> {
  return {
    version: UCP_CATALOG_VERSION,
    status,
    capabilities: { [UCP_CATALOG_CAPABILITY]: { version: UCP_CATALOG_VERSION } },
  };
}
