/**
 * Contract tests for the Desktop Extension bundle manifest (mcpb/manifest.json).
 *
 * The manifest is submitted to Anthropic's extension directory, where a
 * mismatch is not a local annoyance — it ships. Three drifts were live before
 * these tests existed: the manifest declared version 2.0.0 while package.json
 * said 1.0.0 and the MCP server reported 1.1.0 to every connecting client; it
 * pinned manifest_version 0.2 after the spec moved to 0.3; and it advertised
 * ten tools that were hand-copied from an early build.
 *
 * The rules encoded here are the ones a human reviewer would otherwise have to
 * re-check by hand on every release: spec version, the fields the directory
 * requires (privacy policy, icon, repository), version parity with the server
 * the bundle actually launches, and that every advertised tool is really
 * registered under that exact name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..", "..");
const MCPB_DIR = resolve(API_ROOT, "mcpb");

const manifest = JSON.parse(readFileSync(resolve(MCPB_DIR, "manifest.json"), "utf8"));
const toolsSource = readFileSync(resolve(API_ROOT, "src", "mcp", "tools.ts"), "utf8");
const serverSource = readFileSync(resolve(API_ROOT, "src", "mcp", "server.ts"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(API_ROOT, "package.json"), "utf8"));

/** Tool names as registered at runtime: server.tool("firestarter_x", ...). */
function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const m of toolsSource.matchAll(/server\.tool\(\s*\n?\s*"([a-z0-9_]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

describe("mcpb/manifest.json — bundle contract", () => {
  it("targets the current MCPB spec version", () => {
    expect(manifest.manifest_version).toBe("0.3");
  });

  it("carries every field the extension directory requires", () => {
    // Required by the spec for any bundle.
    for (const field of ["name", "version", "description", "author", "server"]) {
      expect(manifest[field], `missing required field: ${field}`).toBeTruthy();
    }
    expect(manifest.author.name).toBeTruthy();
    // Required by the spec for extensions that handle external user data —
    // this one transmits payment, address, and order data to a remote API.
    expect(Array.isArray(manifest.privacy_policies)).toBe(true);
    expect(manifest.privacy_policies.length).toBeGreaterThan(0);
    for (const url of manifest.privacy_policies) {
      expect(url).toMatch(/^https:\/\//);
    }
    // Directory presentation: reviewers reject listings with no icon or no
    // route back to the source.
    expect(manifest.icon).toBeTruthy();
    expect(manifest.repository?.url).toMatch(/^https:\/\//);
    for (const url of [manifest.homepage, manifest.documentation, manifest.support]) {
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it("points the author at a GitHub profile, not the marketing site", () => {
    // The directory checks `author` against a real GitHub identity it can
    // attribute the submission to. A homepage URL there reads as unattributed
    // and is rejected, so the check has to be on the host, not just on https.
    expect(manifest.author.url).toMatch(/^https:\/\/github\.com\/[^/]+\/?$/);
  });

  it("declares MIT consistently across the manifest, package.json, and LICENSE", () => {
    // Listing requires MIT, and requires it to be verifiable: GitHub's license
    // detector reads the LICENSE file, reviewers read the manifest, and npm
    // reads package.json. All three drifted to ISC before this test existed —
    // any one of them disagreeing sinks the submission.
    expect(manifest.license).toBe("MIT");
    const pkg = JSON.parse(readFileSync(resolve(API_ROOT, "package.json"), "utf8"));
    expect(pkg.license).toBe("MIT");
    const licensePath = resolve(API_ROOT, "LICENSE");
    expect(existsSync(licensePath), "no LICENSE file for GitHub to detect").toBe(true);
    expect(readFileSync(licensePath, "utf8")).toMatch(/^MIT License/);
  });

  it("documents the privacy policy in README.md, not only in the manifest", () => {
    // Local connectors must carry the policy in BOTH places. The directory
    // docs are explicit that a missing README section is an immediate
    // rejection, and the manifest array alone does not satisfy it.
    // This package's README sits at its root; when the server lived in the
    // firestarter-commerce monorepo it was two levels up. Accept either so
    // the test travels with the code.
    const candidates = [resolve(API_ROOT, "README.md"), resolve(API_ROOT, "..", "..", "README.md")];
    const readme = readFileSync(candidates.find((p) => existsSync(p))!, "utf8");
    expect(readme).toMatch(/^##+ *Privacy Policy/mi);
    for (const url of manifest.privacy_policies) {
      expect(readme, "README must link the same policy URL the manifest declares").toContain(url);
    }
    // The five topics review checks for.
    const section = readme.slice(readme.search(/^##+ *Privacy Policy/mi));
    for (const topic of [/collect/i, /stored|storage/i, /shar/i, /retain|retention/i, /contact|@/i]) {
      expect(section, `privacy section does not cover ${topic}`).toMatch(topic);
    }
  });

  it("ships every icon file it references", () => {
    const refs: string[] = [manifest.icon, ...(manifest.icons ?? []).map((i: any) => i.src)];
    for (const ref of refs) {
      expect(existsSync(resolve(MCPB_DIR, ref)), `icon file missing: ${ref}`).toBe(true);
    }
    // Each icons[] entry must declare the size the host renders it at.
    for (const entry of manifest.icons ?? []) {
      expect(entry.size, `icons[] entry ${entry.src} has no size`).toMatch(/^\d+x\d+$/);
    }
  });

  it("reports the same version to clients that the bundle advertises", () => {
    // McpServer's version reaches every connecting client in the initialize
    // handshake; if it disagrees with the manifest, the installed extension
    // misreports itself and bug reports cite a version that was never shipped.
    const declared = serverSource.match(/version:\s*"([^"]+)"/)?.[1];
    expect(declared).toBe(manifest.version);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Anchored on package.json, not just on each other. Comparing these two
    // alone is a relative check: it passes when BOTH are stale, which is what
    // drift actually looks like — it stayed green through the 2.12.1 release
    // with both sitting at 2.12.0. version-parity.test.ts covers the rest.
    expect(manifest.version).toBe(pkg.version);
  });

  it("advertises only tools that are actually registered", () => {
    const registered = registeredToolNames();
    expect(registered.size).toBeGreaterThan(50); // sanity: the parse found tools
    for (const tool of manifest.tools ?? []) {
      expect(registered.has(tool.name), `manifest advertises unregistered tool: ${tool.name}`).toBe(true);
      expect(tool.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("declares tools_generated, since the server registers far more than it lists", () => {
    // The listed tools are a curated preview; the server registers the full
    // set at runtime. Without this flag a host treats the short list as
    // exhaustive and hides the rest from the model.
    const registered = registeredToolNames();
    expect(manifest.tools.length).toBeLessThan(registered.size);
    expect(manifest.tools_generated).toBe(true);
  });

  it("requests the API key as a required, masked user config value", () => {
    const key = manifest.user_config?.api_key;
    expect(key).toBeTruthy();
    expect(key.type).toBe("string");
    expect(key.required).toBe(true);
    // Without `sensitive`, the host renders the key in plaintext and stores it
    // outside the OS keychain.
    expect(key.sensitive).toBe(true);
    // The server reads it from this env var — the wiring must line up or the
    // extension installs cleanly and then fails on first call.
    expect(manifest.server.mcp_config.env.FIRESTARTER_API_KEY).toBe("${user_config.api_key}");
  });

  it("launches the entry point it bundles", () => {
    expect(manifest.server.type).toBe("node");
    const entry = manifest.server.entry_point;
    expect(manifest.server.mcp_config.args.join(" ")).toContain(entry);
  });
});

/**
 * Two entrypoints construct an McpServer, and clients see BOTH versions:
 * server.ts answers the stdio/extension handshake, route.ts answers the remote
 * HTTP and WebSocket one. The test above only ever pinned server.ts, so
 * route.ts sat at 1.1.0 while everything else moved to 2.x — meaning
 * api.firestarter.network/mcp told every remote client it was version 1.1.0
 * (confirmed against production before this was fixed).
 */
describe("every transport reports the same version", () => {
  const routeSource = readFileSync(
    resolve(API_ROOT, "src", "mcp", "route.ts"),
    "utf8",
  );

  it("route.ts advertises the manifest version, like server.ts", () => {
    const declared = routeSource.match(/version:\s*"(\d+\.\d+\.\d+)"/)?.[1];
    expect(declared, "route.ts has no McpServer version literal").toBeTruthy();
    expect(
      declared,
      "route.ts (remote HTTP/WS handshake) disagrees with the manifest — run `npm run sync-version`",
    ).toBe(manifest.version);
  });
});
