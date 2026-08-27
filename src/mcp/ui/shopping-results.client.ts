/**
 * Browser entry for the Firestarter "shopping results" MCP App.
 *
 * This file runs INSIDE the sandboxed iframe a host renders for a tool that
 * declares `_meta.ui.resourceUri` → {@link ../shopping-app.ts
 * SHOPPING_RESULTS_URI}. ChatGPT and Claude Desktop both implement that same
 * MCP Apps standard, so ONE build serves both (host.client.ts holds the small
 * fallback for a ChatGPT surface that has not adopted the bridge yet).
 *
 * It is NOT part of the Node build: esbuild bundles it into a self-contained
 * IIFE that scripts/build-shopping-ui.mjs inlines into the HTML served by the
 * resource, which is why `src/**\/*.client.ts` is excluded from tsc's main
 * project (see tsconfig.client.json, which typechecks these against the DOM).
 *
 * Data flow: the host delivers the tool's `structuredContent` through the
 * bridge; a grid of products or a single product's detail view comes out.
 * Images load only from origins the resource allowlists in
 * `_meta.ui.csp.resourceDomains`, so a photo on an un-allowlisted host shows
 * the placeholder rather than a broken image.
 */
import { resetDetail, showDetail, renderDetailPage } from "./detail.client.js";
import { esc } from "./escape.js";
import { renderGrid, showShotFromBar, stopCarousels } from "./grid.client.js";
import { connectHost, type Host } from "./host.client.js";
import type { ShoppingItem } from "./shopping-item.js";

const root = document.getElementById("root")!;

/** The rows currently on screen. A card click needs the whole row object, not
 *  just what the card's markup could carry. */
let items: ShoppingItem[] = [];

function renderError(msg: string): void {
  root.innerHTML = `<p class="empty">Couldn't display results.<br><small>${esc(msg)}</small></p>`;
}

function route(sc: Record<string, unknown>): void {
  try {
    // A new tool result owns the surface: drop whatever detail view was open
    // before it repaints, without letting its back handler flash the old grid.
    resetDetail();
    if (sc.product && typeof sc.product === "object") {
      stopCarousels();
      items = [];
      renderDetailPage(root, sc.product as Record<string, unknown>);
      return;
    }
    // One malformed row (null / non-object) degrades to "that row is skipped",
    // never to the WHOLE grid being replaced by an error card.
    items = ((Array.isArray(sc.options) ? sc.options
      : Array.isArray(sc.listings) ? sc.listings
        : []) as unknown[])
      .filter((it): it is ShoppingItem => !!it && typeof it === "object");
    renderGrid(root, items);
  } catch (e) {
    renderError(e instanceof Error ? e.message : String(e));
  }
}

let host: Host | null = null;

/**
 * One delegated listener for the whole document: render() rewrites innerHTML
 * (dropping per-node listeners), and the detail sheet lives outside #root.
 *
 * Order is load-bearing. A photo bar and a link chip both sit INSIDE a card,
 * and the card itself opens the detail view — without the early returns, every
 * attempt to look at photo 2 would open the product instead.
 */
document.addEventListener("click", (ev) => {
  const el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;

  const bar = el.closest<HTMLElement>(".bar");
  if (bar) { ev.preventDefault(); ev.stopPropagation(); showShotFromBar(bar); return; }

  // Navigation OUT of the sandbox goes through the host: a bare
  // <a target="_blank"> is blocked on hosts that omit allow-popups.
  const link = el.closest<HTMLElement>("[data-url]");
  if (link?.dataset.url) { ev.stopPropagation(); host?.openLink(link.dataset.url); return; }

  const card = el.closest<HTMLElement>("[data-card]");
  if (card && host) openCard(Number(card.dataset.card));
});

/** A card opens the detail view in place; "back" rebuilds the grid it came
 *  from, carousels and all. */
function openCard(i: number): void {
  const item = items[i];
  if (!item || !host) return;
  // The grid is about to be replaced; its carousel timers must not keep
  // ticking against detached nodes.
  stopCarousels();
  showDetail(root, item as Record<string, unknown>, host, {
    onBack: () => renderGrid(root, items),
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const el = ev.target instanceof Element ? ev.target : null;
  const card = el?.closest<HTMLElement>("[data-card]");
  if (!card || !host) return;
  ev.preventDefault();
  openCard(Number(card.dataset.card));
});

connectHost({ onResult: route, onError: renderError })
  .then((h) => { host = h; })
  .catch(() => { /* renderError already painted the failure */ });
