#!/usr/bin/env node
/**
 * Build the Firestarter Desktop Extension (.mcpb) for one-click install in
 * Claude Desktop and other MCP hosts that support Desktop Extensions.
 *
 * Steps:
 *   1. Bundle the stdio MCP server (src/mcp/server.ts) into a single,
 *      self-contained ESM file with esbuild (SDK + zod inlined).
 *   2. Stage it next to the manifest.
 *   3. Pack the staging dir into firestarter.mcpb with @anthropic-ai/mcpb.
 *
 * Output: mcpb/dist/firestarter.mcpb
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const mcpbDir = join(root, "mcpb");
const stageDir = join(mcpbDir, "build");
const distDir = join(mcpbDir, "dist");
const outFile = join(distDir, "firestarter.mcpb");

// 1. Clean + recreate staging dir.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(join(stageDir, "server"), { recursive: true });
mkdirSync(distDir, { recursive: true });

// 2. Bundle the stdio server into one file.
await build({
  entryPoints: [join(root, "src/mcp/server.ts")],
  outfile: join(stageDir, "server/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // Banner keeps require/__filename/__dirname available for any CJS deps esbuild inlines.
  banner: {
    js: "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'node:url';import{dirname as ___d}from'node:path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);",
  },
  logLevel: "info",
});

// 3. Copy the manifest next to the bundle.
cpSync(join(mcpbDir, "manifest.json"), join(stageDir, "manifest.json"));

// 4. Pack into a .mcpb (zip) with the official tool.
const mcpbBin = join(root, "node_modules", ".bin", existsSync(join(root, "node_modules", ".bin", "mcpb.cmd")) ? "mcpb.cmd" : "mcpb");
execFileSync(mcpbBin, ["pack", stageDir, outFile], { stdio: "inherit" });

console.log(`\n✓ Built ${outFile}`);
