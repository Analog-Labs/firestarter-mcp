/**
 * Developer-margin math - the SINGLE source of truth for both what a buyer is
 * SHOWN in chat (src/mcp/tools.ts option render) and what is CHARGED at pay
 * time (src/services/developer-margin.ts). Keeping one pure function means the
 * disclosed total can never drift from the charged total.
 *
 * Leaf module: NO imports (no DB), so the MCP layer can use it without pulling
 * in the pool.
 */

export const MAX_MARGIN_BPS = 1000; // 10%
export const MAX_MARGIN_CENTS = 5000; // $50

/**
 * Margin in cents for an item total, double-capped (bps already clamped by the
 * caller; this clamps the absolute cents). Returns 0 for non-positive inputs.
 */
export function marginCentsFor(itemCents: number, marginBps: number, capCents: number = MAX_MARGIN_CENTS): number {
  if (!Number.isFinite(itemCents) || itemCents <= 0) return 0;
  if (!Number.isFinite(marginBps) || marginBps <= 0) return 0;
  const cap = Number.isFinite(capCents) ? capCents : MAX_MARGIN_CENTS;
  return Math.min(Math.round((itemCents * marginBps) / 10000), cap);
}
