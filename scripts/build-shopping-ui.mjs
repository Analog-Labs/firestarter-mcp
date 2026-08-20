/**
 * Build step for the Firestarter "shopping results" MCP App view.
 *
 * Bundles src/mcp/ui/shopping-results.client.ts (plus the vanilla ext-apps `App`
 * client it imports) into a self-contained IIFE, inlines it with the view's CSS
 * into one HTML document, and writes that document as a committed TS module
 * (src/mcp/ui/shopping-results.generated.ts) that shopping-app.ts serves verbatim
 * from the ui:// resource.
 *
 * Why a generated, committed module (not a runtime bundle or a dist asset):
 *  - tsc compiles it like any other source, so it works in dev (tsx) and prod
 *    (node dist) with no fs reads, asset-copy step, or runtime esbuild.
 *  - The bundle rides inside resources/read, not a tool result, so it is NOT
 *    bound by the 1MB tool-result cap.
 *
 * Regenerate after editing the client: `npm run build:ui` (wired into `build`).
 */
import esbuild from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(apiRoot, "src/mcp/ui/shopping-results.client.ts");
const OUT = join(apiRoot, "src/mcp/ui/shopping-results.generated.ts");

const result = await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "none",
  write: false,
});

// Guard the closing-tag sequence so the bundle can never break out of the
// inline <script> element that hosts it.
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const css = `
  /* FOUNDATION = the original production stylesheet, verbatim where possible.
     A redesign pass (host theme variables, serif host font, padded "catalog
     tile" contain-framing) read worse than what was live — so the original
     look IS the design: system-ui sans, edge-to-edge cover photos, bordered
     cards, chip badges. On top of it, only the STRUCTURAL fixes the original
     lacked:
       1. badge row PINNED to the card bottom (badges align across a row);
       2. title reserves two lines (rows align when titles don't wrap);
       3. media images absolutely positioned (a tall intrinsic image can no
          longer stretch its square tile);
       4. page scrolls inside a host-capped iframe (no half-cropped rows);
       5. a stars row that stays collapsed until rating data exists;
       6. the firestarter_product detail view, styled from the same palette. */
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #18181b; background: transparent; overflow-y: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px; padding: 4px; }
  .card { display: flex; flex-direction: column; border: 1px solid #e4e4e7; border-radius: 12px;
    overflow: hidden; text-decoration: none; color: inherit; background: #fff;
    transition: border-color .12s, transform .12s; }
  a.card:hover, .card.link:hover { border-color: #a1a1aa; transform: translateY(-2px); }
  .media { position: relative; aspect-ratio: 1 / 1; background: #f4f4f5; min-height: 0;
    overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .media .ph { display: none; color: #a1a1aa; font-size: 12px; }
  .media.noimg .ph { display: block; }
  .body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .title { font-weight: 600; font-size: 13px; line-height: 1.3; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    min-height: calc(2 * 1.3em); }
  .stars { font-size: 12px; color: #f59e0b; }
  .stars .count { color: #71717a; }
  .stars:empty { display: none; }
  /* Mixed-rating rows: when the grid has ANY stars, unrated cards keep an
     empty stars line so price/seller rows align across the row. */
  .grid.has-stars .stars:empty { display: block; min-height: 1.4em; }
  .meta { display: flex; align-items: baseline; gap: 6px; overflow: hidden; white-space: nowrap; }
  .price { font-weight: 700; flex: none; }
  .seller { color: #71717a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .badgerow { margin-top: auto; padding-top: 4px; }
  .badge { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid transparent; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.muted { background: #f4f4f5; color: #71717a; }
  .empty { color: #71717a; text-align: center; padding: 24px; }

  /* Detail view (firestarter_product) — original palette, cover hero. */
  .detail { max-width: 460px; margin: 0 auto; padding: 4px; }
  .media.hero { border: 1px solid #e4e4e7; border-radius: 12px; }
  .thumbs { display: flex; gap: 6px; margin-top: 8px; overflow-x: auto; }
  .thumb { flex: none; width: 52px; height: 52px; padding: 0; background: #f4f4f5;
    border: 1px solid #e4e4e7; border-radius: 8px; cursor: pointer; overflow: hidden; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .thumb.sel { border-color: #a1a1aa; }
  .dbody { padding: 10px 2px; display: flex; flex-direction: column; gap: 6px; }
  .dtitle { font-weight: 600; font-size: 15px; line-height: 1.3; }

  /* Dark theme, two triggers with one palette:
     1. the HOST's explicit choice — the client stamps hostContext.theme as
        [data-theme] on :root (applyDocumentTheme), which must win in BOTH
        directions (dark app on light OS, light app on dark OS);
     2. the OS preference as fallback, guarded so an explicit light stamp
        beats a dark OS. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) body { color: #f4f4f5; }
    :root:not([data-theme="light"]) .card { background: #18181b; border-color: #3f3f46; }
    :root:not([data-theme="light"]) a.card:hover, :root:not([data-theme="light"]) .card.link:hover { border-color: #71717a; }
    :root:not([data-theme="light"]) .media { background: #27272a; }
    :root:not([data-theme="light"]) .badge.ok { background: #14532d; color: #bbf7d0; }
    :root:not([data-theme="light"]) .badge.muted { background: #27272a; color: #a1a1aa; }
    :root:not([data-theme="light"]) .media.hero, :root:not([data-theme="light"]) .thumb { border-color: #3f3f46; }
    :root:not([data-theme="light"]) .thumb { background: #27272a; }
  }
  :root[data-theme="dark"] body { color: #f4f4f5; }
  :root[data-theme="dark"] .card { background: #18181b; border-color: #3f3f46; }
  :root[data-theme="dark"] a.card:hover, :root[data-theme="dark"] .card.link:hover { border-color: #71717a; }
  :root[data-theme="dark"] .media { background: #27272a; }
  :root[data-theme="dark"] .badge.ok { background: #14532d; color: #bbf7d0; }
  :root[data-theme="dark"] .badge.muted { background: #27272a; color: #a1a1aa; }
  :root[data-theme="dark"] .media.hero, :root[data-theme="dark"] .thumb { border-color: #3f3f46; }
  :root[data-theme="dark"] .thumb { background: #27272a; }
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Firestarter shopping results</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;

const banner = "// GENERATED by scripts/build-shopping-ui.mjs — do not edit by hand.\n"
  + "// Regenerate with `npm run build:ui` after editing shopping-results.client.ts.\n";
writeFileSync(OUT, `${banner}export const SHOPPING_RESULTS_HTML = ${JSON.stringify(html)};\n`);

console.log(`[build-shopping-ui] wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)`);
