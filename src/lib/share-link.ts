/**
 * The one rule for "does this listing have a public share link?".
 *
 * Shared by the tools that render listings as text and the schema mappers that
 * build `structuredContent` for the product grid, so the two surfaces can never
 * disagree about whether a listing is publicly reachable. A sandbox or
 * non-active listing has no public page — handing back a link for one sends the
 * seller (or a buyer they forwarded it to) straight to a 404.
 */
export const SHARE_LINK_BASE = process.env.SHARE_LINK_BASE || "https://firestarter.network/l";

export function listingShareUrl(listing: any): string | null {
  if (listing?.test_mode === true || listing?.environment === "test" || listing?.status !== "active") {
    return null;
  }
  if (typeof listing?.share_url === "string" && listing.share_url.trim()) {
    return listing.share_url.trim();
  }
  // Backward compatibility during rolling deploys where the API may not yet
  // return share_url. New API responses always include it (string or null).
  if (listing?.share_url === undefined && listing?.id) {
    return `${SHARE_LINK_BASE}/${listing.id}`;
  }
  return null;
}
