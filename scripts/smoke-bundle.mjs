#!/usr/bin/env node
/**
 * Smoke-test the PACKED extension, not the source tree.
 *
 * `npm test` exercises the source; this unzips mcpb/dist/firestarter.mcpb and
 * drives the bundled server over real stdio JSON-RPC. It catches the class of
 * failure the unit tests structurally cannot: a bundler config that drops a
 * dependency, a manifest pointing at the wrong entry point, or an artifact
 * that builds fine and then can't complete a handshake once installed.
 *
 * Asserts the directory-review invariants too — every tool needs a title and
 * the applicable read-only/destructive hint — so a regression fails CI rather
 * than a submission.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "mcpb", "dist", "firestarter.mcpb");

if (!existsSync(bundle)) {
  console.error(`No bundle at ${bundle} — run \`npm run build:mcpb\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "mcpb-smoke-"));
try {
  execFileSync("unzip", ["-q", bundle, "-d", work]);

  const request = (id, method, params) =>
    JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });

  const input = [
    request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ci-smoke", version: "1.0" },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    request(2, "tools/list"),
    request(3, "prompts/list"),
  ].join("\n") + "\n";

  const stdout = execFileSync("node", [join(work, "server", "index.mjs")], {
    input,
    encoding: "utf8",
    // A placeholder key: the server requires one at boot, and tools/list never
    // calls the API, so nothing leaves the runner.
    env: { ...process.env, FIRESTARTER_API_KEY: "fs_test_ci_smoke" },
    timeout: 60_000,
  });

  const byId = new Map();
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) byId.set(msg.id, msg);
  }

  const fail = (why) => {
    console.error(`✗ ${why}`);
    process.exitCode = 1;
  };

  const init = byId.get(1)?.result;
  if (!init) fail("no initialize response");
  else console.log(`✓ handshake: ${init.serverInfo.name} ${init.serverInfo.version}`);

  const tools = byId.get(2)?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    fail("tools/list returned nothing");
  } else {
    console.log(`✓ ${tools.length} tools`);

    const untitled = tools.filter((t) => !t.annotations?.title).map((t) => t.name);
    if (untitled.length) fail(`tools missing an annotations title: ${untitled.join(", ")}`);
    else console.log("✓ every tool has a title");

    const unhinted = tools
      .filter((t) => t.annotations?.readOnlyHint === undefined && t.annotations?.destructiveHint === undefined)
      .map((t) => t.name);
    if (unhinted.length) fail(`tools missing a read-only/destructive hint: ${unhinted.join(", ")}`);
    else console.log("✓ every tool declares a safety hint");

    const contradictory = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    if (contradictory.length) fail(`tools claiming both read-only and destructive: ${contradictory.join(", ")}`);
  }

  const prompts = byId.get(3)?.result?.prompts;
  if (!Array.isArray(prompts) || prompts.length === 0) fail("prompts/list returned nothing");
  else console.log(`✓ ${prompts.length} prompts`);

  if (process.exitCode) console.error("\nBundle smoke test FAILED");
  else console.log("\nBundle smoke test passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
