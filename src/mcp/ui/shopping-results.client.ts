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
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { badgeFor, firstImage, priceLabel, starsLabel, type ShoppingItem } from "./shopping-item.js";

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
      // http(s) only: `url` on a preview option is third-party feed data, and
      // a javascript:/data: scheme must never reach app.openLink — the host
      // mediates, but the widget shouldn't emit it in the first place.
      const link = [it.url, it.share_url].find(
        (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
      );
      const badge = badgeFor(it);
      const media = img
        ? `<img src="${esc(img)}" alt="${title}" loading="lazy"
             onerror="this.parentElement.classList.add('noimg');this.remove();" />`
        : "";
      const seller = it.seller ? `<span class="seller">${esc(it.seller)}</span>` : "";
      // Fixed anatomy — media, reserved title, stars (collapses when absent),
      // one meta row, badge PINNED to the bottom — so every card in a row has
      // identical bones and badges align regardless of title length.
      const stars = starsLabel(it);
      // No image at all → the placeholder must show immediately; the onerror
      // path only covers an image that EXISTS and fails to load.
      const card = `
        <div class="media${img ? "" : " noimg"}">${media}<span class="ph">No photo</span></div>
        <div class="body">
          <div class="title">${title}</div>
          <div class="stars">${stars ? `${esc(stars.stars)} <span class="count">${esc(stars.count)}</span>` : ""}</div>
          <div class="meta"><span class="price">${esc(priceLabel(it))}</span> ${seller}</div>
          <div class="badgerow">${badge ? `<span class="badge ${badge.cls}">${esc(badge.text)}</span>` : ""}</div>
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
  // When ANY card has a rating, every card reserves the stars line so prices
  // and sellers stay row-aligned next to rated neighbours; when none do (a
  // young catalog), the line collapses grid-wide and cards stay compact.
  const anyStars = items.some((it) => starsLabel(it) !== null);
  root.innerHTML = `<div class="grid${anyStars ? " has-stars" : ""}">${cards}</div>`;
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

/** Detail view (firestarter_product): hero + thumbnail strip + trust line.
 *  Same tokens as the grid, so it reads as the grid's sibling. */
function renderDetail(p: Record<string, unknown>): void {
  const title = esc(String(p.title ?? "Untitled"));
  const imgs = (Array.isArray(p.images) ? p.images : []).filter(
    (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
  );
  const hero = imgs[0]
    ? `<img id="hero" src="${esc(imgs[0])}" alt="${title}"
         onerror="this.parentElement.classList.add('noimg');this.remove();" />`
    : "";
  const thumbs = imgs.length > 1
    ? `<div class="thumbs">${imgs.slice(0, 8).map((u, i) =>
        `<button class="thumb${i === 0 ? " sel" : ""}" data-src="${esc(u)}"><img src="${esc(u)}" alt="" /></button>`).join("")}</div>`
    : "";
  const it = p as ShoppingItem;
  const starsInfo = starsLabel({ rating: (p as any).rating, rating_count: (p as any).rating_count });
  const sold = Number((p as any).units_sold) > 0 ? `${(p as any).units_sold} sold` : "";
  const seller = p.seller ? `${esc(String(p.seller))}${(p as any).seller_verified ? " ✓" : ""}` : "";
  root.innerHTML = `
    <div class="detail">
      <div class="media hero${imgs[0] ? "" : " noimg"}">${hero}<span class="ph">No photo</span></div>
      ${thumbs}
      <div class="dbody">
        <div class="dtitle">${title}</div>
        <div class="stars">${starsInfo ? `${esc(starsInfo.stars)} <span class="count">${esc(starsInfo.count)}</span>` : ""}${sold ? ` <span class="count">· ${esc(sold)}</span>` : ""}</div>
        <div class="meta"><span class="price">${esc(priceLabel(it))}</span> <span class="seller">${seller}</span></div>
        ${typeof (p as any).share_url === "string" && /^https?:\/\//i.test((p as any).share_url) ? `<div class="badgerow"><span class="badge ok link" data-url="${esc(String((p as any).share_url))}" role="link" tabindex="0" style="cursor:pointer">View listing page</span></div>` : ""}
      </div>
    </div>`;
  root.querySelectorAll<HTMLElement>(".thumb").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const src = b.dataset.src;
    const heroEl = document.getElementById("hero") as HTMLImageElement | null;
    if (src && heroEl) heroEl.src = src;
    root.querySelectorAll(".thumb").forEach((t) => t.classList.remove("sel"));
    b.classList.add("sel");
  }));
}

app.ontoolresult = (params) => {
  try {
    const sc = (params?.structuredContent ?? {}) as Record<string, unknown>;
    if (sc.product && typeof sc.product === "object") {
      renderDetail(sc.product as Record<string, unknown>);
      return;
    }
    // One malformed row (null / non-object) must degrade to "that row is
    // skipped", never to the WHOLE grid being replaced by an error card —
    // which is what a TypeError mid-map did.
    const items = ((Array.isArray(sc.options) ? sc.options
      : Array.isArray(sc.listings) ? sc.listings
        : []) as unknown[])
      .filter((it): it is ShoppingItem => !!it && typeof it === "object");
    render(items);
  } catch (e) {
    renderError(e instanceof Error ? e.message : String(e));
  }
};

// Adopt the HOST's theme, not the OS's. The iframe's prefers-color-scheme
// follows the system, but a Desktop user can run the app dark on a light
// system (or vice versa) — hostContext.theme is the truth when the host
// sends one, and applyDocumentTheme stamps it as [data-theme] + colorScheme
// for the stylesheet's explicit-theme selectors. No theme in hostContext →
// no stamp → the prefers-color-scheme fallback keeps working as before.
function adoptHostTheme(theme: unknown): void {
  if (theme === "dark" || theme === "light") applyDocumentTheme(theme);
}
app.addEventListener("hostcontextchanged", (ctx: any) => adoptHostTheme(ctx?.theme));

app.connect()
  .then(() => adoptHostTheme((app.getHostContext() as any)?.theme))
  .catch((e) => renderError(e instanceof Error ? e.message : String(e)));
