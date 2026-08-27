/**
 * Every file that states the version agrees with package.json.
 *
 * package.json is the single source of truth: the release tag, the npm
 * publish and the tarball filename are all derived from it, so anything that
 * disagrees is by definition the thing that is wrong.
 *
 * This exists because the guard that was supposed to cover it did not. The
 * 2.12.1 release shipped with five of six files still saying 2.12.0 — the bump
 * hand-edited package.json instead of running `npm version`, which is the only
 * thing that fires scripts/sync-version.mjs. Exactly one test caught it
 * (mcp-initialize-icon, via route.ts). mcpb-manifest.test.ts did not, because
 * it compares server.ts against mcpb/manifest.json — a RELATIVE check that
 * passes happily when both are stale together, which is precisely what drift
 * looks like. The two mcp.json manifests had no version assertion at all.
 *
 * So: anchor on package.json, and cover every file sync-version.mjs writes.
 * Keep this list in step with that script's.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const expected = JSON.parse(read("package.json")).version as string;

/** The JSON manifests, and what each one's version is read by. */
const JSON_MANIFESTS = [
  ["mcpb/manifest.json", "what an installed Desktop Extension reports"],
  ["mcp.json", "the published server manifest"],
  ["src/mcp/mcp.json", "the in-tree copy the bundle ships"],
] as const;

/** The two McpServer constructors, and which clients read each handshake. */
const SERVER_SOURCES = [
  ["src/mcp/server.ts", "the stdio/extension handshake"],
  ["src/mcp/route.ts", "the remote HTTP + WebSocket handshake"],
] as const;

describe("the declared version agrees with package.json everywhere", () => {
  it("package.json itself states a plain x.y.z", () => {
    // A prerelease or range would make every comparison below vacuous.
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(JSON_MANIFESTS)("%s — %s", (path) => {
    expect(JSON.parse(read(path)).version).toBe(expected);
  });

  it.each(SERVER_SOURCES)("%s — %s", (path) => {
    // sync-version.mjs rewrites exactly one literal per file and bails if that
    // stops being true; assert the same shape so the two cannot disagree about
    // what they are matching.
    const matches = read(path).match(/version: "\d+\.\d+\.\d+"/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(`version: "${expected}"`);
  });
});
