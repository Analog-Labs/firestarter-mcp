/**
 * #336: self-hosted listing-image blob store.
 *
 * Converts base64 data-URI uploads into hosted URLs (served by GET /v1/img/:id)
 * so listing images stay out of the JSON payloads that carry listings. Bytes
 * live in Postgres (listing_image_blobs); this module is the single seam to
 * swap the backend to S3/R2/Spaces later without touching the write paths.
 */
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";

const API_URL = process.env.API_URL || "https://api.firestarter.network";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // reject anything over 6MB
const DATA_URI_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

/** Public URL for a stored blob id. */
export function blobUrl(id: string): string {
  return `${API_URL}/v1/img/${id}`;
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
