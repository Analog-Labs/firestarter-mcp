/**
 * The detail view's content rules — what the modal says, and where each fact
 * came from.
 *
 * Two things mount this model. firestarter_product delivers a complete product
 * payload; a clicked grid card delivers a SEARCH ROW (no description, no seller
 * on catalog rows, never any review text) which a lazy firestarter_product call
 * tops up a moment later. Both must read identically, so the merge order, the
 * rating label and the link set are decided once, here, instead of twice in the
 * DOM code.
 *
 * Pure — no DOM, no fetch. esbuild bundles it into the iframe IIFE; Node tests
 * it. Same split as shopping-item.ts and carousel.ts.
 */
import { badgeFor, galleryImages, priceLabel, starsLabel, type ShoppingItem } from "./shopping-item.js";

/** Three is a product, more is a channel — mirrors media.ts's MAX_VIDEOS. */
const MAX_VIDEOS = 3;

const isHttps = (u: unknown): u is string => typeof u === "string" && /^https:\/\//i.test(u);

export interface DetailVideo {
  url: string;
  poster_url: string | null;
}

export interface DetailReview {
  rating: number;
  comment: string;
  created_at: string | null;
}

/** What firestarter_product adds on top of a search row. Every field optional:
 *  the fetch may never resolve, may be refused by the host, or may come back
 *  thin, and none of that may erase what the row already told us. */
export interface FetchedDetail {
  description?: string | null;
  seller?: string | null;
  seller_verified?: boolean;
  images?: unknown;
  videos?: unknown;
  units_sold?: number;
  reviews?: { count?: number; top?: unknown } | null;
}

export interface DetailLink {
  kind: "listing" | "store";
  label: string;
  url: string;
}

export interface DetailModel {
  title: string;
  images: string[];
  videos: DetailVideo[];
  photoLinks: { label: string; url: string }[];
  price: string;
  badge: { text: string; cls: string } | null;
  /** `label` names the FALLBACK only: seller stars standing in for a product
   *  with no reviews of its own. A product's own rating carries no label. */
  rating: { stars: string; count: string; label: string | null } | null;
  soldLabel: string | null;
  seller: { name: string; verified: boolean } | null;
  description: string | null;
  reviews: DetailReview[];
  reviewCount: number;
  links: DetailLink[];
}

/**
 * The listing id to fetch full detail for, or null when there is nothing to
 * fetch.
 *
 * External results (Google Shopping and friends) carry a source-specific id.
 * Calling firestarter_product with one spends a round trip to earn a 404, and
 * the modal would sit on a loading skeleton for reviews we do not hold.
 */
export function detailFetchId(item: unknown): string | null {
  const id = (item as { id?: unknown })?.id;
  return typeof id === "string" && /^lst_[A-Za-z0-9._-]+$/.test(id) ? id : null;
}

function cleanText(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

function httpsList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(isHttps) : [];
}

/** Playable clips off any payload shape, https-only and capped. Exported so
 *  the grid can count them for the card's media chip without re-deriving the
 *  filter — a card that advertises a video the modal then refuses to show is
 *  worse than a card that stays quiet. */
export function videosOf(v: unknown): DetailVideo[] {
  if (!Array.isArray(v)) return [];
  const out: DetailVideo[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const url = (raw as { url?: unknown })?.url;
    if (!isHttps(url) || seen.has(url)) continue;
    seen.add(url);
    const poster = (raw as { poster_url?: unknown })?.poster_url;
    out.push({ url, poster_url: isHttps(poster) ? poster : null });
    if (out.length >= MAX_VIDEOS) break;
  }
  return out;
}

function reviewList(raw: unknown): DetailReview[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => ({
      rating: Number((r as { rating?: unknown })?.rating) || 0,
      // Already sanitised server-side (tools.ts caps and flattens every quote);
      // trimmed here only so a whitespace-only comment cannot render an empty
      // quote block with stars attached to nothing.
      comment: cleanText((r as { comment?: unknown })?.comment) ?? "",
      created_at: cleanText((r as { created_at?: unknown })?.created_at),
    }))
    .filter((r) => r.comment !== "");
}

/** A host to name in "Open on …", or null when the url is unusable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Where this product can be opened.
 *
 * A Firestarter listing has a share page and that is the honest destination.
 * An external result has none — "View listing page" would name a page that does
 * not exist — so it is named by the merchant's own host instead, which also
 * tells the buyer they are leaving.
 */
function linksFor(it: ShoppingItem): DetailLink[] {
  const links: DetailLink[] = [];
  const share = it.share_url;
  if (typeof share === "string" && /^https?:\/\//i.test(share)) {
    links.push({ kind: "listing", label: "View listing page", url: share });
  }
  const url = it.url;
  if (typeof url === "string" && /^https?:\/\//i.test(url) && !links.some((l) => l.url === url)) {
    const host = hostOf(url);
    if (host) links.push({ kind: "store", label: `Open on ${host}`, url });
  }
  return links;
}

export function detailModel(item: unknown, fetched: FetchedDetail | null): DetailModel {
  const it = (item ?? {}) as ShoppingItem;

  // Photos: the fetch wins when it has any, because a grid row is capped at
  // MAX_CARD_IMAGES and the detail view has room for the whole gallery.
  const fetchedImages = httpsList(fetched?.images);
  const images = fetchedImages.length ? fetchedImages : galleryImages(it).filter(isHttps);

  const fetchedVideos = videosOf(fetched?.videos);
  const videos = fetchedVideos.length ? fetchedVideos : videosOf(it.videos);

  const stars = starsLabel(it);
  // The flag when the payload sets it; otherwise infer it, because a catalog
  // row that carries only seller_rating IS showing seller stars whether or not
  // the mapper said so.
  const sellerLevel =
    it.rating_is_seller_level === true ||
    (it.rating == null && it.rating_count == null && it.seller_rating != null);

  const sold = Number(fetched?.units_sold ?? it.units_sold);

  const sellerName = cleanText(fetched?.seller) ?? cleanText(it.seller);

  return {
    title: cleanText(it.title) ?? cleanText(it.product_name) ?? "Untitled",
    images,
    videos,
    photoLinks: images.map((url, i) => ({ label: `Photo ${i + 1}`, url })),
    price: priceLabel(it),
    badge: badgeFor(it),
    rating: stars ? { ...stars, label: sellerLevel ? "seller rating" : null } : null,
    soldLabel: Number.isFinite(sold) && sold > 0 ? `${sold} sold` : null,
    seller: sellerName ? { name: sellerName, verified: fetched?.seller_verified === true } : null,
    description: cleanText(fetched?.description) ?? cleanText(it.description),
    reviews: reviewList(fetched?.reviews?.top),
    reviewCount: Number(fetched?.reviews?.count) || 0,
    links: linksFor(it),
  };
}
