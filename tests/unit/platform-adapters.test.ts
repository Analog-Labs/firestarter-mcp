/**
 * Platform adapters — the seam that lets the Firestarter API keep its
 * database-backed image reads while the standalone package ships without a
 * database driver.
 *
 * The behaviour that matters in both directions:
 *   - injected: listing image blobs are read straight from Postgres, as they
 *     are today inside the API;
 *   - not injected: the read is skipped and the caller falls back to fetching
 *     over HTTP, which is what the stdio desktop extension already does.
 *
 * Getting this wrong is silent — images would still render, just fetched the
 * slow way (or not at all) — so it is pinned here rather than left to review.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setPlatformAdapters, getPlatformAdapters, resetPlatformAdapters } from "../../src/platform.js";
import { fetchImageAsBase64 } from "../../src/mcp/tools.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(() => {
  resetPlatformAdapters();
  vi.unstubAllGlobals();
});

describe("platform adapters", () => {
  it("starts empty, so a standalone install carries no database driver", () => {
    expect(getPlatformAdapters()).toEqual({});
  });

  it("merges registrations instead of replacing them", () => {
    const pool = { query: async () => ({ rows: [] }) };
    const imageStore = { getOrCreateThumb: async () => null };

    setPlatformAdapters({ pool });
    setPlatformAdapters({ imageStore });

    // A host registering one adapter must not silently drop the other.
    expect(getPlatformAdapters().pool).toBe(pool);
    expect(getPlatformAdapters().imageStore).toBe(imageStore);
  });
});

describe("blob reads through the injected pool", () => {
  // Firestarter-hosted blob: /v1/img/<32 hex>. Only this shape takes the
  // direct-read path; anything else goes straight to HTTP.
  const BLOB_URL = "https://api.firestarter.network/v1/img/0123456789abcdef0123456789abcdef";

  it("reads the blob from the database when a pool is injected", async () => {
    const query = vi.fn(async () => ({
      rows: [{ content_type: "image/png", bytes: PNG_1PX }],
    }));
    setPlatformAdapters({ pool: { query } });
    // Any HTTP fetch would mean the database path was skipped.
    const fetchSpy = vi.fn(async () => new Response(PNG_1PX, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchImageAsBase64(BLOB_URL);

    expect(query).toHaveBeenCalled();
    expect(result?.mimeType).toBe("image/png");
    expect(result?.data).toBe(PNG_1PX.toString("base64"));
    expect(fetchSpy, "should not fall back to HTTP when the DB served it").not.toHaveBeenCalled();
  });

  it("prefers a cached thumbnail over the full blob when the image store is injected", async () => {
    const getOrCreateThumb = vi.fn(async () => ({ contentType: "image/jpeg", bytes: PNG_1PX }));
    const query = vi.fn(async () => ({ rows: [] }));
    setPlatformAdapters({ pool: { query }, imageStore: { getOrCreateThumb } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PNG_1PX, { status: 200 })));

    const result = await fetchImageAsBase64(BLOB_URL);

    expect(getOrCreateThumb).toHaveBeenCalled();
    // The thumbnail is the whole point — it is ~10x smaller than the original.
    expect(query, "full blob should not be read when a thumb exists").not.toHaveBeenCalled();
    expect(result?.mimeType).toBe("image/jpeg");
  });

  it("falls back to HTTP when nothing is injected (standalone / stdio)", async () => {
    const fetchSpy = vi.fn(async () => new Response(PNG_1PX, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchImageAsBase64(BLOB_URL);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.mimeType).toBe("image/png");
  });

  it("falls back to HTTP when the injected pool throws", async () => {
    setPlatformAdapters({
      pool: { query: async () => { throw new Error("connection refused"); } },
    });
    const fetchSpy = vi.fn(async () => new Response(PNG_1PX, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    // A database blip must degrade to the slow path, never fail the tool call.
    const result = await fetchImageAsBase64(BLOB_URL);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.mimeType).toBe("image/png");
  });
});
