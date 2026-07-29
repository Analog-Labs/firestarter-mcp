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

/** The subset of a preview option / catalog listing this view renders. Kept
 *  loose on purpose — the structured payload evolves server-side and a missing
 *  field must degrade to "not shown", never throw. */
interface ShoppingItem {
  title?: string;
  product_name?: string;
  image_url?: string;
  image?: string;
  images?: unknown;
  price_usd?: number;
  current_price?: number;
  price?: { amount_minor?: number; currency?: string } | null;
  currency?: string;
  url?: string;
  share_url?: string;
  seller?: string;
  purchasable?: boolean;
  buyable?: boolean;
  eligible?: boolean;
}

const root = document.getElementById("root")!;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function firstImage(it: ShoppingItem): string | null {
  const direct = it.image_url ?? it.image;
  if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct;
  if (Array.isArray(it.images)) {
    const u = it.images.find((x) => typeof x === "string" && /^https?:\/\//i.test(x));
    if (typeof u === "string") return u;
  }
  return null;
}

function priceLabel(it: ShoppingItem): string {
  const currency = it.currency || it.price?.currency || "USD";
  const amount =
    typeof it.price_usd === "number" ? it.price_usd
      : typeof it.current_price === "number" ? it.current_price
        : typeof it.price?.amount_minor === "number" ? it.price.amount_minor / 100
          : null;
  return amount == null ? "" : `${currency} ${amount.toFixed(2)}`;
}

function buyLabel(it: ShoppingItem): { text: string; cls: string } {
  const buyable = it.purchasable ?? it.buyable;
  if (buyable && it.eligible !== false) return { text: "Buyable now", cls: "ok" };
  if (buyable) return { text: "Buyable", cls: "ok" };
  return { text: "Browse-only", cls: "muted" };
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
      const badge = buyLabel(it);
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
          <span class="badge ${badge.cls}">${badge.text}</span>
        </div>`;
      return link
        ? `<a class="card" href="${esc(link)}" target="_blank" rel="noreferrer noopener">${card}</a>`
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
