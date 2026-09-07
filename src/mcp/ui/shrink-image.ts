/**
 * Downsize a photo IN THE BROWSER before it rides the host bridge.
 *
 * Why (commerce#1090 / #1074 / #1111 / #1118): the drop zone puts the whole
 * file into an `image_base64` tool argument. A 6 MB phone photo becomes an
 * ~8 MB JSON-RPC message, and the claude.ai host refuses it BEFORE it reaches
 * the server — the seller sees "Unable to reach Firestarter", the API logs
 * show no request at all (Loki, 2026-09-04), and small files through the same
 * zone succeed. So the bound is the host's tool-call payload, not our 6 MB
 * server cap, and the only place to honour it is here, before the call.
 *
 * What this does: photos over BRIDGE_PHOTO_BUDGET_BYTES are decoded, scaled
 * down (longest edge stepping 2048 → 1024) and re-encoded as JPEG until they
 * fit the budget. Below the budget the ORIGINAL bytes go through untouched, so
 * a typical already-compressed photo keeps its exact quality. GIFs are never
 * re-encoded (an animation would become one frame). Videos are out of scope —
 * nothing here can re-encode a clip; they keep the 25 MB contract.
 *
 * Failure mode is always "send the original": a browser without
 * createImageBitmap / canvas, a decode error, an encoder that returns null —
 * every one of them falls back to the untouched file, which is exactly what
 * happened before this module existed.
 *
 * The I/O primitives are injectable so the size-stepping logic is unit-testable
 * in jsdom, which has neither createImageBitmap nor a real canvas.
 */

/** Raw bytes above which a photo is downsized before upload. 1 MiB of bytes is
 *  ~1.4 MB as a data-URI — well under any cap we have seen a host apply, while
 *  a 2048px JPEG at q0.85 (400–900 KB) almost always lands under it in one
 *  pass. */
export const BRIDGE_PHOTO_BUDGET_BYTES = 1024 * 1024;

/** Longest-edge targets, tried in order until the encoded photo fits. 2048px
 *  is beyond what any listing page or share card renders at. */
const EDGE_STEPS = [2048, 1600, 1280, 1024] as const;
/** JPEG qualities tried at each edge, best first. */
const QUALITY_STEPS = [0.85, 0.75] as const;
const OUTPUT_TYPE = "image/jpeg";

export interface DecodedImage {
  width: number;
  height: number;
  /** Release the decoded pixels (ImageBitmap.close). Optional for fakes. */
  close?: () => void;
}

/** The two things the browser has to do for us; swapped for fakes in tests. */
export interface ShrinkIO {
  decode(file: Blob): Promise<DecodedImage>;
  /** Draw `img` scaled to width×height and encode as `type` at `quality`.
   *  null when the encoder declines (canvas.toBlob's contract). */
  encode(img: DecodedImage, width: number, height: number, type: string, quality: number): Promise<Blob | null>;
}

export interface ShrinkResult {
  blob: Blob;
  filename: string;
  /** false = the original bytes are what `blob` holds. */
  shrunk: boolean;
  fromBytes: number;
  toBytes: number;
}

/** Is this file one we would downsize at all? Pure; no browser needed. */
export function shouldShrink(file: { size: number; type: string }, budget: number = BRIDGE_PHOTO_BUDGET_BYTES): boolean {
  if (file.size <= budget) return false;
  // Re-encoding a GIF keeps one frame of an animation; the server's own cap
  // still applies to it, so it just goes through as-is.
  if (/^image\/gif$/i.test(file.type)) return false;
  return true;
}

/** True when this browser can decode + re-encode a photo. */
export function canShrinkHere(): boolean {
  return typeof createImageBitmap === "function"
    && typeof document !== "undefined"
    && typeof document.createElement === "function";
}

/** Swap the extension for the output format's, since the bytes are JPEG now. */
export function jpegName(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  return `${base || "photo"}.jpg`;
}

function browserIO(): ShrinkIO {
  return {
    decode: async (file) => {
      // "from-image" honours EXIF orientation, so a portrait phone shot does
      // not come out sideways once the metadata is gone.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { width: bmp.width, height: bmp.height, close: () => bmp.close(), __bmp: bmp } as DecodedImage & { __bmp: ImageBitmap };
    },
    encode: (img, width, height, type, quality) => new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage((img as DecodedImage & { __bmp: ImageBitmap }).__bmp, 0, 0, width, height);
      canvas.toBlob((b) => resolve(b), type, quality);
    }),
  };
}

/**
 * Downsize `file` to fit `budget`. Never throws: any failure returns the
 * original file with shrunk:false.
 */
export async function shrinkPhoto(
  file: File,
  budget: number = BRIDGE_PHOTO_BUDGET_BYTES,
  io: ShrinkIO = browserIO(),
): Promise<ShrinkResult> {
  const original: ShrinkResult = { blob: file, filename: file.name, shrunk: false, fromBytes: file.size, toBytes: file.size };
  if (!shouldShrink(file, budget)) return original;

  let img: DecodedImage | null = null;
  try {
    img = await io.decode(file);
    if (!(img.width > 0 && img.height > 0)) return original;
    const longest = Math.max(img.width, img.height);
    let best: Blob | null = null;
    for (const edge of EDGE_STEPS) {
      // Never upscale: an edge step larger than the photo is the photo itself,
      // so the first pass at a small-but-heavy image is a pure re-encode.
      const scale = Math.min(1, edge / longest);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      for (const q of QUALITY_STEPS) {
        const out = await io.encode(img, w, h, OUTPUT_TYPE, q);
        if (!out) continue;
        if (!best || out.size < best.size) best = out;
        if (out.size <= budget) {
          return { blob: out, filename: jpegName(file.name), shrunk: true, fromBytes: file.size, toBytes: out.size };
        }
      }
    }
    // Nothing met the budget; the smallest re-encode still beats the original
    // if it IS smaller. Otherwise the original is the least-bad payload.
    if (best && best.size < file.size) {
      return { blob: best, filename: jpegName(file.name), shrunk: true, fromBytes: file.size, toBytes: best.size };
    }
    return original;
  } catch {
    return original;
  } finally {
    try { img?.close?.(); } catch { /* releasing pixels is best-effort */ }
  }
}
