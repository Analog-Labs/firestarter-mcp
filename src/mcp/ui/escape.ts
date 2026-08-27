/**
 * HTML escaping for the widget's string-built markup.
 *
 * The view builds its DOM by concatenating strings, and almost every value in
 * it is third-party text: a seller's title, a feed's merchant name, a buyer's
 * review quote. This is the only thing between that text and the document, so
 * it lives in a pure module Node can test rather than inside the client bundle.
 *
 * Escapes the five characters that matter in both element content and quoted
 * attribute values — titles land in `alt=""` and urls in `data-url=""`.
 */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
