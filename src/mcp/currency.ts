/**
 * ISO-4217 minor-unit arithmetic. Import-free ON PURPOSE.
 *
 * This table used to live in ucp-schema.ts, which imports zod and builds UCP
 * schema constants at module scope. The shopping-results widget needs the same
 * exponents (a card that divides every price by 100 renders ¥1290 as
 * "JPY 12.90"), and that widget is an esbuild IIFE inlined into one HTML
 * document, so an import from ucp-schema would drag a server-side schema module
 * into the iframe — top-level `z.object(...)` calls are side-effecting, so
 * esbuild cannot tree-shake them away (a standalone bundle of just
 * `currencyExponent` from ucp-schema measured 321 KB minified).
 *
 * Splitting the table out keeps ONE source of truth for the server and the
 * iframe rather than a duplicated list that can drift on the next currency.
 * Measured cost to the widget bundle: +348 bytes.
 *
 * Keep this module free of imports.
 */

// Most currencies use 2 minor digits (cents), but zero-decimal (JPY, KRW, VND,
// ...) and three-decimal (KWD, BHD, ...) currencies exist. Anything unlisted
// defaults to 2.
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
 * Integer minor units → the major-unit amount a buyer is quoted (1290 MYR minor
 * → 12.9; 1290 JPY minor → 1290). Null in, null out.
 */
export function toMajorUnits(minor: number | null | undefined, currency: string | null | undefined): number | null {
  if (minor == null) return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return n / 10 ** currencyExponent(currency);
}
