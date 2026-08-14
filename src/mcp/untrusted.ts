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

/** Zero-width joiners a marker can hide behind. Kept in the TEXT (emoji
 *  sequences, Persian/Urdu orthography) but seen through by the matchers. */
const ZW = "[\u200c\u200d]*";

/** Interleave ZW between every character, so `<sys‍tem>` matches `<system>`
 *  without stripping joiners from text that merely contains them. */
function seeThrough(word: string): string {
  return word.split("").join(ZW);
}

const SPEAKER_WORDS = [
  "system", "user", "assistant", "human", "instructions?", "listing", "intent",
  // Tool-use grammars. `function_calls`/`invoke`/`parameter` are Claude's own,
  // which makes them the likeliest consumer of this server's output.
  "tool_result", "tool_use", "tool_call", "function_results?", "function_calls",
  "invoke", "parameter", "thinking", "document", "start_of_turn", "end_of_turn",
];

/**
 * Conversational and structural markers that let text change who is speaking.
 *
 * `\b[^<>]*` after the word is load-bearing: requiring `>` immediately meant a
 * single attribute walked straight through — `<system priority="max">` was
 * emitted byte-identical, and whitespace normalisation even tidied a multi-line
 * one into a better-formed tag than the input.
 */
const SPEAKER_TAGS = new RegExp(
  `<${ZW}\\/?${ZW}\\s*(?:${SPEAKER_WORDS.map(seeThrough).join("|")})\\b[^<>]*>`,
  "gi",
);

/**
 * Speaker delimiters for OpenAI-, Llama- and Mistral-family models, plus the
 * sentence markers some tokenizers treat as turn boundaries. Structural, like
 * the tags above, so they belong here rather than in the phrase blocklist this
 * module deliberately does not have.
 */
const MODEL_DELIMITERS = /<\|[^|>]*\|>|\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>|<\/?s>/gi;

/**
 * Characters with no legitimate place in a product name that DO have a use in
 * an attack: C0, DEL, C1, soft hyphen and combining grapheme joiner, the bidi
 * embeds/overrides/isolates behind Trojan Source (including U+061C ALM), the
 * Hangul/Braille filler blocks used as invisible padding, BOM, and the
 * U+E0000 tag block — the canonical channel for smuggling invisible text past
 * a human reader.
 *
 * Zero-width joiner (U+200D) and non-joiner (U+200C) are deliberately NOT here.
 * ZWJ holds an emoji sequence together — stripping it turns "👨‍👩‍👧" into
 * three separate people — and ZWNJ is grammatically required in Persian, Urdu
 * and Devanagari, where removing it splits one word into two. The matchers see
 * through them instead (see ZW above).
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufeff\uffa0]+|[\u{e0000}-\u{e007f}]+/gu;

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
    SPEAKER_TAGS.lastIndex = 0;
    MODEL_DELIMITERS.lastIndex = 0;
    const next = out.replace(SPEAKER_TAGS, " ").replace(MODEL_DELIMITERS, " ");
    if (next === out) return out;
    out = next;
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
