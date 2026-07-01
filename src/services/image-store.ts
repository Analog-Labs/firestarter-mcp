/**
 * #336: self-hosted listing-image blob store.
 *
 * Converts base64 data-URI uploads into hosted URLs (served by GET /v1/img/:id)
 * so listing images stay out of the JSON payloads that carry listings. Bytes
 * live in Postgres (listing_image_blobs); this module is the single seam to
 * swap the backend to S3/R2/Spaces later without touching the write paths.
 */
import crypto from "node:crypto";
import { Jimp } from "jimp";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";

const API_URL = process.env.API_URL || "https://api.firestarter.network";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // reject anything over 6MB
const THUMB_MAX_DIM = 320; // px — list/search/gallery thumbnails
const DATA_URI_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

/** Public URL for a stored blob id. */
export function blobUrl(id: string): string {
  return `${API_URL}/v1/img/${id}`;
}

/**
 * #434/#436: normalize a stored attachment URL to a host-relative blob path.
 *
 * The support-attachment feeds are consumed by frontends that prepend their own
 * API base to the returned `url`. blobUrl() mints an ABSOLUTE URL (correct for
 * listing images, which are embedded in payloads consumed by clients that do
 * NOT prepend), so returning it verbatim makes those frontends build a
 * double-host URL (`https://hosthttps://host/v1/img/...`) and the image never
 * loads. Stripping back to `/v1/img/<id>` lets each frontend resolve it against
 * its own host. Idempotent: tolerates already-relative and legacy
 * double-prefixed values, and passes non-blob URLs through untouched.
 */
export function toBlobPath<T extends string | null | undefined>(url: T): T {
  if (!url) return url;
  const i = url.indexOf("/v1/img/");
  return (i >= 0 ? url.slice(i) : url) as T;
}

const BLOB_PATH_RE = /^\/v1\/img\/[a-f0-9]{32}$/;

/**
 * True iff `url` is a hosted blob URL this server minted (our API host +
 * /v1/img/<32-hex-id>). Buyer-supplied reference images (#348) are gated
 * through this: the only URL we accept is one our own upload endpoint
 * produced, which guarantees the bytes exist in our store AND removes the
 * SSRF surface of letting a caller point the vision model at an arbitrary
 * host. Compared against the same API_URL used to mint the URL, so the two
 * always agree by construction.
 */
export function isOwnBlobUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length > 256) return false;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(API_URL);
  } catch {
    return false;
  }
  return (
    parsed.protocol === base.protocol &&
    parsed.host === base.host &&
    BLOB_PATH_RE.test(parsed.pathname)
  );
}

/** Deterministic, hex-safe id for a blob's thumbnail variant. */
export function thumbBlobId(id: string): string {
  return crypto.createHash("sha256").update(id + ":thumb").digest("hex").slice(0, 32);
}

/**
 * #336: lazily produce (and cache) a downscaled thumbnail for a stored blob.
 * Generated on first request and stored alongside the full-res blob, so list /
 * search / gallery surfaces can load light images while the detail page keeps
 * full-res. Returns null if the source is missing or undecodable (e.g. webp) —
 * the caller then serves the full image, so this never breaks an <img>.
 */
export async function getOrCreateThumb(id: string): Promise<{ contentType: string; bytes: Buffer } | null> {
  const tid = thumbBlobId(id);
  const existing = await pool.query("SELECT content_type, bytes FROM listing_image_blobs WHERE id = $1", [tid]);
  if (existing.rows[0]) return { contentType: existing.rows[0].content_type, bytes: existing.rows[0].bytes };

  const src = await pool.query("SELECT bytes FROM listing_image_blobs WHERE id = $1", [id]);
  if (!src.rows[0]) return null;
  try {
    const img = await Jimp.read(src.rows[0].bytes as Buffer);
    if (img.width > THUMB_MAX_DIM || img.height > THUMB_MAX_DIM) {
      img.scaleToFit({ w: THUMB_MAX_DIM, h: THUMB_MAX_DIM });
    }
    const bytes = await img.getBuffer("image/jpeg", { quality: 72 });
    await pool.query(
      `INSERT INTO listing_image_blobs (id, content_type, bytes, byte_size)
       VALUES ($1, 'image/jpeg', $2, $3) ON CONFLICT (id) DO NOTHING`,
      [tid, bytes, bytes.length]
    );
    return { contentType: "image/jpeg", bytes };
  } catch (err) {
    logger.warn("image-store: thumbnail generation failed", { id, error: (err as Error).message });
    return null;
  }
}

/**
 * Persist a base64 image data-URI and return its hosted URL. Content-addressed
 * (sha256 of the bytes) so identical uploads dedup. Returns null for non-data-URI
 * input or an empty/oversized/undecodable payload.
 */
export async function storeDataUri(dataUri: unknown): Promise<string | null> {
  if (typeof dataUri !== "string") return null;
  const m = dataUri.match(DATA_URI_RE);
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2].replace(/\s/g, ""), "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const id = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  try {
    await pool.query(
      `INSERT INTO listing_image_blobs (id, content_type, bytes, byte_size)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, contentType, bytes, bytes.length]
    );
  } catch (err) {
    logger.error("image-store: failed to persist blob", { error: (err as Error).message });
    return null;
  }
  return blobUrl(id);
}

/**
 * Store arbitrary bytes (e.g. a DHL shipping-label or commercial-invoice PDF) in
 * the blob store and return its hosted URL (served by GET /v1/img/:id).
 * Content-addressed + idempotent, like storeDataUri but for non-image payloads.
 * Returns null on empty/oversized input or a write failure.
 */
export async function storeBlob(bytes: Buffer, contentType: string): Promise<string | null> {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const id = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  try {
    await pool.query(
      `INSERT INTO listing_image_blobs (id, content_type, bytes, byte_size)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, contentType, bytes, bytes.length]
    );
  } catch (err) {
    logger.error("image-store: failed to persist blob", { error: (err as Error).message });
    return null;
  }
  return blobUrl(id);
}

/**
 * Normalize a listing's images array: convert base64 data-URIs to hosted blob
 * URLs, pass http(s) URLs through unchanged, and drop anything else. Preserves
 * order. Non-array input → [].
 */
export async function normalizeListingImages(images: unknown): Promise<string[]> {
  if (!Array.isArray(images)) return [];
  const out: string[] = [];
  for (const entry of images) {
    if (typeof entry !== "string") continue;
    if (/^https?:\/\//i.test(entry)) {
      out.push(entry);
    } else if (entry.startsWith("data:")) {
      const url = await storeDataUri(entry);
      if (url) out.push(url);
    }
    // anything else (junk / unsupported scheme) is dropped
  }
  return out;
}
