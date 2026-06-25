/**
 * fetchImageAsBase64 — MCP image blocks must only carry model-supported MIME
 * types. The original code passed any content-type through (defaulting to
 * image/jpeg), so a listing image served as svg/avif/octet-stream — or an HTML
 * error page returned with 200 — produced an image block the model rejected
 * with "unsupported image format", breaking the WHOLE tool response
 * (firestarter_approve / firestarter_status). These tests pin that only
 * supported formats are emitted, with a magic-byte fallback when the header is
 * missing or wrong, and everything else is skipped (null).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchImageAsBase64 } from "../../src/mcp/tools.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const HTML = new TextEncoder().encode("<!doctype html><html><body>nope</body></html>");

function mockFetchOnce(bytes: Uint8Array, contentType?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: contentType ? { "Content-Type": contentType } : {},
      })
    )
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchImageAsBase64 — supported-format gating", () => {
  it("returns the image when the header is a supported type", async () => {
    mockFetchOnce(PNG, "image/png");
    const r = await fetchImageAsBase64("https://img.test/a.png");
    expect(r?.mimeType).toBe("image/png");
    expect(r?.data).toBe(Buffer.from(PNG).toString("base64"));
  });

  it("strips charset params from the content-type", async () => {
    mockFetchOnce(JPEG, "image/jpeg; charset=binary");
    const r = await fetchImageAsBase64("https://img.test/a.jpg");
    expect(r?.mimeType).toBe("image/jpeg");
  });

  it("sniffs magic bytes when the header is missing", async () => {
    mockFetchOnce(GIF);
    const r = await fetchImageAsBase64("https://img.test/a");
    expect(r?.mimeType).toBe("image/gif");
  });

  it("sniffs WEBP and overrides a wrong/unsupported header", async () => {
    mockFetchOnce(WEBP, "application/octet-stream");
    const r = await fetchImageAsBase64("https://img.test/a.bin");
    expect(r?.mimeType).toBe("image/webp");
  });

  it("skips an unsupported format (svg header, not sniffable) → null", async () => {
    mockFetchOnce(new TextEncoder().encode("<svg/>"), "image/svg+xml");
    const r = await fetchImageAsBase64("https://img.test/a.svg");
    expect(r).toBeNull();
  });

  it("skips an HTML error page returned with 200 → null", async () => {
    mockFetchOnce(HTML, "text/html");
    const r = await fetchImageAsBase64("https://img.test/missing");
    expect(r).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const r = await fetchImageAsBase64("https://img.test/404");
    expect(r).toBeNull();
  });
});
