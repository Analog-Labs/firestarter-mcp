/**
 * Relevance floor for search results.
 *
 * Minimum spec_match (0-100, from `scoreProduct`) for a result to count as a
 * genuine match - i.e. eligible to be pre-selected for payment and surfaced to
 * the buyer as a buyable "best option". A real match scores 80-100; an
 * irrelevant one scores ~0.
 *
 * Below this floor there is no real match: the buyer must be shown a
 * no-match / refine response, never an unrelated item pitched as "best option"
 * (e.g. a floral-dress photo returning a $10.99 toothpick as "best option").
 * Shared by the execution worker (pre-selection + messaging) and the MCP tool
 * layer so both judge relevance with one threshold. (#206)
 */
export const MIN_RELEVANT_SPEC_MATCH = 40;

/**
 * True when at least one result clears the relevance floor. Accepts raw
 * spec_match values (0-100); null / undefined / missing are treated as 0.
 */
export function isRelevantMatch(specMatches: Array<number | null | undefined>): boolean {
  return specMatches.some((s) => (s ?? 0) >= MIN_RELEVANT_SPEC_MATCH);
}
