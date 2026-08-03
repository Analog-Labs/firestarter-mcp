import { z } from "zod";

/**
 * A display/inventory-tracking variant (size/color/option). Extends the shape
 * catalog-sync already writes from Shopify/BigCommerce (see NormalizedVariant
 * in services/catalog-sync/types.ts) with `label` for manually-created
 * variants. NOT a checkout-level construct — Firestarter execution/orders
 * still resolve at the listing level only (see the plan's "Deviations" note).
 */
export const variantSchema = z.object({
  sku: z.string().optional(),
  label: z.string(),
  price: z.number().positive().optional(),
  currency: z.string().optional(),
  compare_at_price: z.number().positive().optional(),
  inventory_qty: z.number().int().nonnegative().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  external_id: z.string().optional(),
});

export const listingDetailFields = {
  brand: z.string().max(200).optional(),
  sku: z.string().max(100).optional(),
  condition: z.enum(["new", "used_like_new", "used_good", "used_fair", "refurbished"]).optional(),
  return_policy: z.string().max(2000).optional(),
  ship_time_days: z.number().int().nonnegative().optional(),
  country_of_origin: z.string().length(2).transform((v) => v.toUpperCase()).optional(),
  length_in: z.number().positive().optional(),
  width_in: z.number().positive().optional(),
  height_in: z.number().positive().optional(),
  weight_oz: z.number().positive().optional(),
  materials: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  variants: z.array(variantSchema).optional(),
};

export const listingDetailFieldsSchema = z.object(listingDetailFields);
export type ListingDetailFields = z.infer<typeof listingDetailFieldsSchema>;

/** Validate the listing-detail subset of a request body. Extra keys (product_name, base_price, ...) are ignored. */
export function parseListingDetailFields(
  body: unknown
): { ok: true; value: ListingDetailFields } | { ok: false; error: string } {
  const result = listingDetailFieldsSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".") || "body";
    return { ok: false, error: `${path}: ${issue.message}` };
  }
  return { ok: true, value: result.data };
}

/**
 * Appends "column = $N" / value pairs for whichever listing-detail fields are
 * present in `parsed`, continuing the numbering an existing route handler has
 * already built up in `updates`/`params` (numbered from params.length + 1 at
 * call time, so call order relative to other per-field pushes doesn't matter).
 */
export function applyListingDetailFields(parsed: ListingDetailFields, updates: string[], params: unknown[]): void {
  let idx = params.length + 1;
  if (parsed.brand !== undefined) { updates.push(`brand = $${idx++}`); params.push(parsed.brand || null); }
  if (parsed.sku !== undefined) { updates.push(`sku = $${idx++}`); params.push(parsed.sku || null); }
  if (parsed.condition !== undefined) { updates.push(`condition = $${idx++}`); params.push(parsed.condition); }
  if (parsed.return_policy !== undefined) { updates.push(`return_policy = $${idx++}`); params.push(parsed.return_policy || null); }
  if (parsed.ship_time_days !== undefined) { updates.push(`ship_time_days = $${idx++}`); params.push(parsed.ship_time_days); }
  if (parsed.country_of_origin !== undefined) { updates.push(`country_of_origin = $${idx++}`); params.push(parsed.country_of_origin || null); }
  if (parsed.length_in !== undefined) { updates.push(`length_in = $${idx++}`); params.push(parsed.length_in); }
  if (parsed.width_in !== undefined) { updates.push(`width_in = $${idx++}`); params.push(parsed.width_in); }
  if (parsed.height_in !== undefined) { updates.push(`height_in = $${idx++}`); params.push(parsed.height_in); }
  if (parsed.weight_oz !== undefined) { updates.push(`weight_oz = $${idx++}`); params.push(parsed.weight_oz); }
  if (parsed.materials !== undefined) { updates.push(`materials = $${idx++}`); params.push(JSON.stringify(parsed.materials)); }
  if (parsed.tags !== undefined) { updates.push(`tags = $${idx++}`); params.push(JSON.stringify(parsed.tags)); }
  if (parsed.variants !== undefined) { updates.push(`variants = $${idx++}`); params.push(JSON.stringify(parsed.variants)); }
}
