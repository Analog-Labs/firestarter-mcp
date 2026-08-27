/**
 * What a seller can upload must be what an agent can display.
 *
 * The two allowlists live in different repos: commerce's image-store decides
 * what may be STORED, and this package's SUPPORTED_IMAGE_MIME decides what may
 * be INLINED into an agent's context. They agree today, and nothing was holding
 * them there — a format added on one side alone means either a seller uploads a
 * photo no agent can render, or the MCP tries to inline bytes the store would
 * never have accepted.
 *
 * Kept as a literal list rather than an import: the two repos ship
 * independently, so this file is the contract, and CHANGING it is the moment to
 * check the other side.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** commerce apps/api/src/services/image-store.ts — ALLOWED_IMAGE_MIMES. */
const COMMERCE_UPLOAD_IMAGE_MIMES = ["image/gif", "image/jpeg", "image/png", "image/webp"];
/** commerce apps/api/src/services/image-store.ts — ALLOWED_VIDEO_MIMES. */
const COMMERCE_UPLOAD_VIDEO_MIMES = ["video/mp4", "video/webm"];

const TOOLS = readFileSync(resolve(__dirname, "../../src/mcp/tools.ts"), "utf8");

function declaredSet(name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*new Set\\(\\[([^\\]]+)\\]`).exec(TOOLS);
  if (!m) throw new Error(`${name} not found in tools.ts`);
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean).sort();
}

describe("upload formats and display formats agree", () => {
  it("every image format the store accepts, the MCP can inline", () => {
    // Otherwise a seller uploads a photo that renders as a broken link in
    // every agent surface, having been told the upload succeeded.
    expect(declaredSet("SUPPORTED_IMAGE_MIME")).toEqual(COMMERCE_UPLOAD_IMAGE_MIMES);
  });

  it("the video formats are the ones <video> plays natively", () => {
    // v1 does no transcoding, so the upload allowlist IS the playback
    // allowlist. Adding a container here without a transcoder would accept
    // files nothing can play.
    expect(COMMERCE_UPLOAD_VIDEO_MIMES).toEqual(["video/mp4", "video/webm"]);
  });

  it("SVG is excluded from both, deliberately", () => {
    // An SVG served from our own blob host can carry inline script and become
    // stored XSS. It is not an oversight and must not be "fixed" by adding it.
    expect(declaredSet("SUPPORTED_IMAGE_MIME")).not.toContain("image/svg+xml");
    expect(COMMERCE_UPLOAD_IMAGE_MIMES).not.toContain("image/svg+xml");
  });
});
