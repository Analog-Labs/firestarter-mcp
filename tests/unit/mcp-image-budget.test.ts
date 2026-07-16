/**
 * MCP image size budget — an MCP client rejects the WHOLE tool result once it
 * exceeds 1MB ("Tool result is too large. Maximum size is 1MB."), which broke
 * firestarter_preview / firestarter_execute for any search returning external
 * product photos: the per-image cap was 5MB (ABOVE the whole-response cap) and
 * up to 3 images embedded with no cumulative budget, so a response could carry
 * ~20MB of base64. The ?thumb= downscale only applied to Firestarter-hosted
 * blobs, so external (Google Shopping) images went in full-res.
 *
 * These tests pin the two guarantees that keep a response renderable:
 *   1. an oversized external image is DOWNSCALED, not embedded full-res;
 *   2. the summed base64 of all images never exceeds the response budget,
 *      even when downscaling fails — dropping a photo degrades the answer,
 *      exceeding the cap destroys it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  inlineImageBlocks,
  MAX_RESPONSE_IMAGE_BASE64_BYTES,
  MCP_RESULT_LIMIT_BYTES,
} from "../../src/mcp/tools.js";

// A real, decodable JPEG that stands in for a full-res Google Shopping photo:
// ~1MB — above the per-image cap so it must be downscaled, below the download
// ceiling so it is actually fetched, and (crucially) large enough that its
// base64 alone (~1.4MB) would blow the 1MB result cap if embedded as-is.
// Pseudo-random pixel noise defeats JPEG compression so the size is real.
const DIM = 800;
async function bigJpeg(): Promise<Buffer> {
  const { Jimp } = await import("jimp");
  const img = new Jimp({ width: DIM, height: DIM, color: 0x000000ff });
  for (let x = 0; x < DIM; x++) {
    for (let y = 0; y < DIM; y++) {
      const v = ((x * 2654435761) ^ (y * 40503)) >>> 0;
      img.setPixelColor(((((v & 0xffffff) << 8) | 0xff) >>> 0), x, y);
    }
  }
  return await img.getBuffer("image/jpeg", { quality: 90 });
}

/** Base64 length of n raw bytes — mirrors the encoder's 4/3 inflation. */
function base64Len(n: number): number {
  return Math.ceil(n / 3) * 4;
}

function mockFetchAlways(bytes: Buffer, contentType = "image/jpeg") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": contentType } }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("inlineImageBlocks — 1MB tool-result budget", () => {
  it("downscales an oversized external image instead of embedding it full-res", async () => {
    const big = await bigJpeg();
    // Preconditions — without these the test could pass on an empty result for
    // the wrong reason (image rejected at the download ceiling, never shrunk).
    expect(big.byteLength).toBeGreaterThan(256 * 1024); // over the per-image cap
    expect(big.byteLength).toBeLessThan(5 * 1024 * 1024); // under the download ceiling
    expect(base64Len(big.byteLength)).toBeGreaterThan(MCP_RESULT_LIMIT_BYTES); // would blow the cap as-is
    mockFetchAlways(big);

    const blocks = await inlineImageBlocks(["https://cdn.example/cat-food.jpg"]);

    // The photo must SURVIVE (dropping it silently would be its own bug)...
    expect(blocks).toHaveLength(1);
    expect(blocks[0].mimeType).toBe("image/jpeg");
    // ...and be small enough that the response fits.
    expect(blocks[0].data.length).toBeLessThan(base64Len(big.byteLength) / 4);
    expect(blocks[0].data.length).toBeLessThanOrEqual(MAX_RESPONSE_IMAGE_BASE64_BYTES);
  }, 60_000);

  it("keeps total image base64 within the response budget across several images", async () => {
    const big = await bigJpeg();
    mockFetchAlways(big);

    const blocks = await inlineImageBlocks([
      "https://cdn.example/a.jpg",
      "https://cdn.example/b.jpg",
      "https://cdn.example/c.jpg",
    ]);

    // Three full-res photos are what broke the real tool — all three should
    // still make it through, shrunk, rather than being dropped.
    expect(blocks).toHaveLength(3);
    const total = blocks.reduce((n, b) => n + b.data.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_RESPONSE_IMAGE_BASE64_BYTES);
    expect(total).toBeLessThan(MCP_RESULT_LIMIT_BYTES);
  }, 60_000);

  it("drops images that would exceed the budget when downscaling fails", async () => {
    // Bytes with a valid JPEG magic header that Jimp cannot decode: the
    // downscale path returns null and the raw payload passes through, so the
    // cumulative budget is the only thing standing between us and a 1MB blowup.
    // Sized so exactly one fits the budget and the rest cannot.
    const undecodable = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(400 * 1024, 0x7f),
    ]);
    expect(base64Len(undecodable.byteLength)).toBeLessThan(MAX_RESPONSE_IMAGE_BASE64_BYTES);
    expect(base64Len(undecodable.byteLength) * 2).toBeGreaterThan(MAX_RESPONSE_IMAGE_BASE64_BYTES);
    mockFetchAlways(undecodable);

    const blocks = await inlineImageBlocks([
      "https://cdn.example/a.jpg",
      "https://cdn.example/b.jpg",
      "https://cdn.example/c.jpg",
    ]);

    // First fits; the other two must be dropped rather than stacked past the cap.
    expect(blocks).toHaveLength(1);
    const total = blocks.reduce((n, b) => n + b.data.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_RESPONSE_IMAGE_BASE64_BYTES);
  }, 60_000);
});
