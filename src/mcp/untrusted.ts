/**
 * Neutralise seller-supplied text before it leaves in a tool result.
 *
 * Everything a seller types — product name, description, category, pick note,
 * store name — is third-party input that ends up verbatim in the CALLING
 * agent's context window. That agent is not ours: we cannot wrap its prompt in
 * "treat the following as data", and we cannot assume it distinguishes a tool
 * result from an instruction. The API defends its own model calls with
 * `sanitizeForPrompt` (apps/api/src/services/llm.ts); nothing covered the text
 * we hand to somebody else's agent.
 *
 * WHAT THIS REMOVES, and why it stops there:
 *
 * Structure, not vocabulary. Three things give injected text its power — the
 * ability to impersonate a different speaker (`<system>`, `<assistant>`), the
 * ability to forge new result rows or headings (line breaks in a field the
 * caller renders inline), and characters that hide payloads from a human
 * reviewing the output (control characters). All three are removed. The words
 * themselves survive.
 *
 * There is deliberately NO phrase blocklist. Matching "ignore previous
 * instructions" and its cousins is evaded by paraphrase in seconds, while
 * reliably destroying honest listings: a t-shirt printed with "IGNORE THE
 * HATERS" is a product, not an attack. A filter that mangles real catalogue
 * text in exchange for stopping the laziest attacker is a bad trade, and it
 * would make the tool output untrustworthy in a way that is much harder to
 * debug than the thing it was guarding against.
 */

/** Conversational and structural markers that let text change who is speaking. */
const SPEAKER_TAGS = /<\/?(?:system|user|assistant|human|instructions?|listing|intent|tool_result|tool_use|function_results?|thinking)\s*\/?>/gi;

/** Default budget for one rendered field. Long enough for a real description
 *  line, short enough that no single field can dominate a result row. */
const DEFAULT_MAX = 300;

/**
 * Returns display-safe text, or "" for anything that is not a string.
 *
 * Idempotent: running it twice is the same as running it once, so it is safe to
 * apply at more than one layer without compounding the truncation.
 */
export function sanitizeUntrusted(value: unknown, max: number = DEFAULT_MAX): string {
  if (typeof value !== "string") return "";
  return value
    .replace(SPEAKER_TAGS, " ")
    // Control characters, which covers newlines and tabs: a field rendered
    // inline must not be able to open a new line and forge a row or heading.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** `sanitizeUntrusted`, but preserving "this field was absent" as null. */
export function sanitizeUntrustedOrNull(value: unknown, max: number = DEFAULT_MAX): string | null {
  const cleaned = sanitizeUntrusted(value, max);
  return cleaned ? cleaned : null;
}
