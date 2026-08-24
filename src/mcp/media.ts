/**
 * Listing media, normalised for the agent surface.
 *
 * Shared by the output schemas, the zoom-in prose and the shopping widget so
 * the three cannot disagree about what a product's media is.
 *
 * HTTPS only. `javascript:` and `data:` are the XSS shapes, and plain `http://`
 * is blocked as mixed content by any client rendering these in a page — a
 * broken frame reads worse than an absent one. The API already rewrites every
 * accepted video to one of our own blob URLs, but this layer talks to whatever
 * the API returns and does not get to assume which version shipped.
 */

/** Three is a product, more is a channel. Mirrors MAX_LISTING_VIDEOS server-side. */
export const MAX_VIDEOS = 3;

/** What an agent gets: somewhere to play it, and something to show first. */
export interface AgentVideo {
  url: string;
  poster_url: string | null;
}

const isHttps = (u: unknown): u is string =>
  typeof u === "string" && /^https:\/\//i.test(u);

/**
 * Deliberately narrow: url + poster, never content_type or byte_size. An agent
 * relays or links a video; it does not decode one, and shipping decode hints
 * into a context window is noise the buyer pays for in tokens.
 */
export function safeVideos(raw: unknown): AgentVideo[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentVideo[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const url = (v as { url?: unknown }).url;
    if (!isHttps(url) || seen.has(url)) continue;
    seen.add(url);
    const poster = (v as { poster_url?: unknown }).poster_url;
    out.push({ url, poster_url: isHttps(poster) ? poster : null });
    if (out.length >= MAX_VIDEOS) break;
  }
  return out;
}

/**
 * One "▶ video: <url>" line per clip, or nothing at all.
 *
 * A URL rather than an embed: the calling agent decides how to present it, and
 * several hosts already render a bare media URL as a player. Never a zero state
 * — "0 videos" is noise on the overwhelming majority of listings that have none.
 */
export function videoLines(videos: unknown): string[] {
  return safeVideos(videos).map((v) => `▶ video: ${v.url}`);
}
