/**
 * Neutralise seller-supplied text before it leaves in a tool result.
 *
 * Everything a seller types — product name, description, category, pick note,
 * store name, a dispute message — is third-party input that ends up verbatim in
 * the CALLING agent's context window. That agent is not ours: we cannot wrap its
 * prompt in "treat the following as data", and we cannot assume it distinguishes
 * a tool result from an instruction. The API defends its own model calls with
 * `sanitizeForPrompt` (apps/api/src/services/llm.ts); nothing covered the text
 * we hand to somebody else's agent.
 *
 * WHAT THIS REMOVES, and why it stops there:
 *
 * Structure, not vocabulary. Three things give injected text its power — the
 * ability to impersonate a different speaker (`<system>`, `<|im_start|>`), the
 * ability to forge new result rows via line breaks in a field rendered inline,
 * and characters that hide a payload from a human reading the output. All three
 * go. The words themselves survive.
 *
 * There is deliberately NO phrase blocklist. Matching "ignore previous
 * instructions" is evaded by paraphrase in seconds while reliably destroying
 * honest listings — a t-shirt printed with "IGNORE THE HATERS" is a product,
 * not an attack.
 *
 * ORDER MATTERS, and getting it wrong is how the first two versions were
 * bypassed. Invisible characters are stripped BEFORE tags are matched: a single
 * \x01 or zero-width space inside `<system\x01>` makes the tag pattern miss,
 * and stripping afterwards then reassembles `<system >` — a live tag,
 * manufactured by the sanitiser itself.
 */

/** Conversational and structural markers that let text change who is speaking. */
const SPEAKER_TAGS = /<\/?\s*(?:system|user|assistant|human|instructions?|listing|intent|tool_result|tool_use|function_results?|thinking)\s*\/?>/gi;

/**
 * Speaker delimiters for OpenAI- and Llama-family models. Structural, like the
 * tags above, so they belong here rather than in the phrase blocklist this
 * module deliberately does not have.
 */
const MODEL_DELIMITERS = /<\|[^|>]{0,40}\|>|\[\/?INST\]|<<\/?SYS>>/gi;

/**
 * Characters with no legitimate place in a product name that DO have a use in
 * an attack: C0, DEL, C1, the bidi embeds/overrides/isolates behind Trojan
 * Source (text renders right-to-left and a human cannot read what the model
 * consumed), and BOM.
 *
 * Zero-width joiner (U+200D) and non-joiner (U+200C) are deliberately NOT here.
 * ZWJ is what holds an emoji sequence together — stripping it turns
 * "👨‍👩‍👧" into three separate people — and ZWNJ is grammatically required in
 * Persian, Urdu and Devanagari, where removing it splits one word into two.
 * They are handled by letting the tag patterns match through them instead, so a
 * hostile `<system‍>` is still caught while a real product name survives.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\x00-\x1f\x7f-\x9f​‎‏‪-‮⁠-⁤⁦-⁯﻿]+/g;

/** Zero-width characters left in the text, which a tag may hide behind. */
const ZERO_WIDTH_IN_TAG = /[‌‍]/g;

/** Default budget for one rendered field. */
const DEFAULT_MAX = 300;

/**
 * Remove speaker markers, repeatedly, because removal can reveal a new one:
 * `<system<system>>` collapses to `<system >`, which is itself a live tag.
 *
 * Bounded — the input is hostile and nesting depth is free — and FAIL CLOSED if
 * it has not converged: a deeply nested payload that outlasts the budget has
 * its angle brackets removed outright rather than being handed on intact.
 */
function stripSpeakerMarkers(input: string): string {
  let out = input;
  for (let i = 0; i < 12; i++) {
    // Probe with the kept zero-width characters removed, so `<system‍>` is
    // still caught — but only ADOPT the probe when it actually revealed a
    // marker. Otherwise benign text keeps its ZWJ/ZWNJ, which is the whole
    // reason they are not stripped outright: emoji sequences and Persian
    // orthography depend on them.
    const probe = out.replace(ZERO_WIDTH_IN_TAG, "");
    SPEAKER_TAGS.lastIndex = 0;
    MODEL_DELIMITERS.lastIndex = 0;
    if (!SPEAKER_TAGS.test(probe) && !MODEL_DELIMITERS.test(probe)) return out;
    out = probe.replace(SPEAKER_TAGS, " ").replace(MODEL_DELIMITERS, " ");
  }
  // Did not converge. Anything that survives 12 peels is adversarial, so drop
  // the characters a tag cannot exist without.
  return out.replace(/[<>|]/g, " ");
}

/**
 * Returns display-safe text, or "" for anything that is not a string.
 *
 * Idempotent: safe to apply at more than one layer without compounding.
 */
export function sanitizeUntrusted(value: unknown, max: number = DEFAULT_MAX): string {
  if (typeof value !== "string") return "";
  // 1. Invisibles first — see the ORDER MATTERS note above.
  // 2. Then speaker markers, to a fixpoint.
  // 3. Then collapse whitespace, which also folds the newlines that would
  //    otherwise forge a new row in an inline-rendered field.
  const cleaned = stripSpeakerMarkers(value.replace(INVISIBLE, " "))
    .replace(/\s+/g, " ")
    .trim();
  // Code POINTS, not units: a code-unit cut can split a surrogate pair and
  // leave a lone surrogate in structuredContent.
  return Array.from(cleaned).slice(0, max).join("").trim();
}

/** `sanitizeUntrusted`, but preserving "this field was absent" as null. */
export function sanitizeUntrustedOrNull(value: unknown, max: number = DEFAULT_MAX): string | null {
  const cleaned = sanitizeUntrusted(value, max);
  return cleaned ? cleaned : null;
}
