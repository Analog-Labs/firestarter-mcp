/**
 * Browser entry for the Firestarter "shopping results" MCP App.
 *
 * This file runs INSIDE the sandboxed iframe the host (Claude Desktop, VS Code,
 * …) renders for a tool that declares `_meta.ui.resourceUri` →
 * {@link ../shopping-app.ts SHOPPING_RESULTS_URI}. It is NOT part of the Node
 * build: esbuild bundles it (with the vanilla `App` client from ext-apps) into a
 * self-contained IIFE that `scripts/build-shopping-ui.mjs` inlines into the HTML
 * served by the resource. It is therefore excluded from the API's `tsc` via the
 * `src/**\/*.client.ts` tsconfig exclude (it uses DOM globals the Node build
 * doesn't type).
 *
 * Data flow: the host delivers the tool's result — the same `structuredContent`
 * firestarter_preview already returns — via the `ui/notifications/tool-result`
 * notification, surfaced here as `app.ontoolresult`. We render the product
 * photos in a grid; images load only from origins the resource allowlists in
 * `_meta.ui.csp.resourceDomains`, so a photo on an un-allowlisted host shows the
 * placeholder rather than a broken image.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import { badgeFor, firstImage, priceLabel, type ShoppingItem } from "./shopping-item.js";

const root = document.getElementById("root")!;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function render(items: ShoppingItem[]): void {
  if (!items.length) {
    root.innerHTML = `<p class="empty">No products to show.</p>`;
    return;
  }
  const cards = items
    .map((it) => {
      const img = firstImage(it);
      const title = esc(it.title || it.product_name || "Untitled");
      const link = it.url || it.share_url;
      const badge = badgeFor(it);
      const media = img
        ? `<img src="${esc(img)}" alt="${title}" loading="lazy"
             onerror="this.parentElement.classList.add('noimg');this.remove();" />`
        : "";
      const seller = it.seller ? `<span class="seller">${esc(it.seller)}</span>` : "";
      const card = `
        <div class="media">${media}<span class="ph">No photo</span></div>
        <div class="body">
          <div class="title">${title}</div>
          <div class="meta"><span class="price">${esc(priceLabel(it))}</span> ${seller}</div>
          ${badge ? `<span class="badge ${badge.cls}">${esc(badge.text)}</span>` : ""}
        </div>`;
      // Navigation must go through app.openLink (host-mediated): a bare
      // <a target="_blank"> inside the sandboxed iframe is blocked on hosts
      // that omit allow-popups, which turns every card into a dead link. The
      // data-url attribute feeds the delegated click/keydown handler below.
      return link
        ? `<div class="card link" data-url="${esc(link)}" role="link" tabindex="0" style="cursor:pointer">${card}</div>`
        : `<div class="card">${card}</div>`;
    })
    .join("");
  root.innerHTML = `<div class="grid">${cards}</div>`;
}

function renderError(msg: string): void {
  root.innerHTML = `<p class="empty">Couldn't display results.<br><small>${esc(msg)}</small></p>`;
}

const app = new App(
  { name: "firestarter-shopping", version: "0.1.0" },
  undefined,
  { autoResize: true },
);

// One delegated listener (render() rewrites innerHTML, dropping per-node
// listeners): a click or Enter on a data-url card asks the HOST to open the
// share link — the sanctioned way out of the sandbox. A host that declines
// resolves with isError rather than rejecting; either way the fallback is to
// do nothing and leave the grid usable.
function openCard(target: EventTarget | null): void {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-url]") : null;
  const url = el?.dataset.url;
  if (url) void app.openLink({ url }).catch(() => { /* transport failure — grid stays usable */ });
}
root.addEventListener("click", (ev) => openCard(ev.target));
root.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") openCard(ev.target);
});

app.ontoolresult = (params) => {
  try {
    const sc = (params?.structuredContent ?? {}) as Record<string, unknown>;
    const items = (Array.isArray(sc.options) ? sc.options
      : Array.isArray(sc.listings) ? sc.listings
        : []) as ShoppingItem[];
    render(items);
  } catch (e) {
    renderError(e instanceof Error ? e.message : String(e));
  }
};

app.connect().catch((e) => renderError(e instanceof Error ? e.message : String(e)));
