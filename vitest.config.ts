import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * The source is authored in NodeNext/ESM style: relative imports carry a
 * `.js` specifier (e.g. `./db/pool.js`) even though the files on disk are
 * `.ts`. That is how `tsx` runs in production. Vite's resolver does not
 * remap `.js`→`.ts` on its own, so this plugin rewrites relative `*.js`
 * specifiers to the matching `*.ts` (or `*.tsx`) sibling when one exists.
 * This mirrors how tsx loads the same modules at runtime — no build step.
 */
function tsJsResolver() {
  return {
    name: "ts-js-specifier-resolver",
    enforce: "pre" as const,
    async resolveId(source: string, importer: string | undefined) {
      if (!importer) return null;
      if (!source.startsWith(".")) return null;
      if (!source.endsWith(".js")) return null;

      const base = source.slice(0, -3); // strip ".js"
      for (const ext of [".ts", ".tsx"]) {
        const candidate = resolve(dirname(importer), base + ext);
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [tsJsResolver()],
  resolve: {
    alias: {
      // Allow `@/...` to reference the src tree from tests if desired.
      "@": resolve(root, "src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
    },
  },
});
