/**
 * The browser-side photo downsizer (commerce#1090/#1074/#1111/#1118).
 *
 * The bound being honoured is the chat HOST's tool-call payload, not our 6 MB
 * server cap: a full-size phone photo as image_base64 is a multi-MB JSON-RPC
 * message the host has to carry in one argument. These pin the decisions:
 *  - under budget → the ORIGINAL bytes, untouched (quality is never spent
 *    where it isn't needed);
 *  - GIFs are never re-encoded (an animation would lose all but one frame);
 *  - over budget → step the longest edge down and the quality down until the
 *    encode fits, never upscaling, and rename to .jpg since the bytes are JPEG;
 *  - nothing fits → the smallest re-encode still ships if it beats the original;
 *  - every failure (no decoder, decode throws, encoder returns null) → original.
 *
 * The I/O is faked: jsdom has neither createImageBitmap nor a real canvas, and
 * the logic under test is the stepping, not the browser's encoder.
 */
import { describe, it, expect } from "vitest";
import {
  BRIDGE_PHOTO_BUDGET_BYTES,
  canShrinkHere,
  jpegName,
  shouldShrink,
  shrinkPhoto,
  type DecodedImage,
  type ShrinkIO,
} from "../../src/mcp/ui/shrink-image.js";

function file(bytes: number, name = "IMG_0001.HEIC.jpeg", type = "image/jpeg"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** An encoder whose output size is a deterministic function of pixels × quality,
 *  so the test can predict which step first fits the budget. */
function fakeIO(width: number, height: number, bytesPerPixelAtQ1 = 0.5) {
  const encodes: { w: number; h: number; type: string; q: number }[] = [];
  let closed = 0;
  const io: ShrinkIO = {
    decode: async () => ({ width, height, close: () => { closed++; } }),
    encode: async (_img: DecodedImage, w, h, type, q) => {
      encodes.push({ w, h, type, q });
      return new Blob([new Uint8Array(Math.round(w * h * bytesPerPixelAtQ1 * q))], { type });
    },
  };
  return { io, encodes, closed: () => closed };
}

describe("shouldShrink", () => {
  it("leaves anything at or under the budget alone", () => {
    expect(shouldShrink(file(BRIDGE_PHOTO_BUDGET_BYTES))).toBe(false);
    expect(shouldShrink(file(300 * 1024))).toBe(false);
  });
  it("wants to shrink a big JPEG/PNG/WebP", () => {
    expect(shouldShrink(file(3 * 1024 * 1024))).toBe(true);
    expect(shouldShrink(file(3 * 1024 * 1024, "a.png", "image/png"))).toBe(true);
  });
  it("never re-encodes a GIF, however big", () => {
    expect(shouldShrink(file(3 * 1024 * 1024, "a.gif", "image/gif"))).toBe(false);
  });
});

describe("jpegName", () => {
  it("swaps the extension for .jpg and survives odd names", () => {
    expect(jpegName("IMG_0001.HEIC.jpeg")).toBe("IMG_0001.HEIC.jpg");
    expect(jpegName("photo.PNG")).toBe("photo.jpg");
    expect(jpegName("noext")).toBe("noext.jpg");
    expect(jpegName(".png")).toBe("photo.jpg");
  });
});

describe("shrinkPhoto", () => {
  it("returns the original bytes untouched when under budget — no decode at all", async () => {
    const f = file(200 * 1024);
    let decoded = 0;
    const io: ShrinkIO = {
      decode: async () => { decoded++; return { width: 10, height: 10 }; },
      encode: async () => null,
    };
    const r = await shrinkPhoto(f, undefined, io);
    expect(r.shrunk).toBe(false);
    expect(r.blob).toBe(f);
    expect(r.filename).toBe(f.name);
    expect(decoded).toBe(0);
  });

  it("steps the longest edge down to 2048 first, never upscaling, and stops at the first fit", async () => {
    // 4000×3000 at 0.5 B/px·q → 2048×1536 @ q0.85 ≈ 1.34 MB (too big),
    // @ q0.75 ≈ 1.18 MB (too big), 1600×1200 @ q0.85 ≈ 816 KB → fits.
    const { io, encodes, closed } = fakeIO(4000, 3000);
    const r = await shrinkPhoto(file(5 * 1024 * 1024), undefined, io);
    expect(r.shrunk).toBe(true);
    expect(r.filename).toBe("IMG_0001.HEIC.jpg");
    expect(r.toBytes).toBeLessThanOrEqual(BRIDGE_PHOTO_BUDGET_BYTES);
    expect(encodes.map((e) => `${e.w}x${e.h}@${e.q}`)).toEqual([
      "2048x1536@0.85", "2048x1536@0.75", "1600x1200@0.85",
    ]);
    expect(encodes.every((e) => e.type === "image/jpeg")).toBe(true);
    expect(closed()).toBe(1);
  });

  it("does not upscale a small-but-heavy photo: the first pass is a pure re-encode at native size", async () => {
    const { io, encodes } = fakeIO(1200, 900, 0.05);
    const r = await shrinkPhoto(file(2 * 1024 * 1024), undefined, io);
    expect(r.shrunk).toBe(true);
    expect(encodes[0]).toMatchObject({ w: 1200, h: 900, q: 0.85 });
    expect(encodes).toHaveLength(1);
  });

  it("ships the smallest re-encode when nothing fits the budget but it still beats the original", async () => {
    // Absurd density: every step is over budget; the 1024-edge @ q0.75 is the
    // smallest and is under the 5 MB original.
    const { io, encodes } = fakeIO(8000, 8000, 5);
    const r = await shrinkPhoto(file(5 * 1024 * 1024), undefined, io);
    expect(encodes).toHaveLength(8);
    expect(r.shrunk).toBe(true);
    expect(r.toBytes).toBe(Math.round(1024 * 1024 * 5 * 0.75));
    expect(r.toBytes).toBeLessThan(5 * 1024 * 1024);
  });

  it("keeps the original when every re-encode would be BIGGER", async () => {
    // A tiny-but-over-budget file with an encoder that can only make it larger.
    const budget = 1000;
    const { io } = fakeIO(100, 100, 5); // 100*100*5*0.75 = 37,500 > 2,000
    const f = file(2000);
    const r = await shrinkPhoto(f, budget, io);
    expect(r.shrunk).toBe(false);
    expect(r.blob).toBe(f);
  });

  it("falls back to the original when the decoder throws", async () => {
    const f = file(3 * 1024 * 1024);
    const io: ShrinkIO = { decode: async () => { throw new Error("not an image"); }, encode: async () => null };
    const r = await shrinkPhoto(f, undefined, io);
    expect(r).toMatchObject({ shrunk: false, blob: f, filename: f.name });
  });

  it("falls back to the original when the encoder declines every time", async () => {
    const f = file(3 * 1024 * 1024);
    const io: ShrinkIO = { decode: async () => ({ width: 4000, height: 3000 }), encode: async () => null };
    const r = await shrinkPhoto(f, undefined, io);
    expect(r).toMatchObject({ shrunk: false, blob: f });
  });

  it("falls back to the original on a zero-sized decode", async () => {
    const f = file(3 * 1024 * 1024);
    const io: ShrinkIO = { decode: async () => ({ width: 0, height: 0 }), encode: async () => new Blob([new Uint8Array(1)]) };
    const r = await shrinkPhoto(f, undefined, io);
    expect(r.shrunk).toBe(false);
  });
});

describe("canShrinkHere", () => {
  it("is false in jsdom, which has no createImageBitmap — so the widget sends the original there", () => {
    expect(typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap).toBe("undefined");
    expect(canShrinkHere()).toBe(false);
  });
});
