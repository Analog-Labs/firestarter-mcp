/**
 * The detail view — one markup, two mounts.
 *
 * `firestarter_product` returns a complete product, and this renders it as the
 * page. A clicked grid card has only a search row (no description, no reviews,
 * and no seller at all on catalog rows), so the same markup opens as a sheet
 * over the grid and a lazy firestarter_product call fills the gaps a moment
 * later. Both read identically because both are built from detailModel().
 *
 * The sheet asks the host for the whole surface first. A widget iframe is often
 * ~400px tall inline, and a "modal" inside that is a letterbox; when the host
 * declines, the sheet still covers the widget's own viewport and scrolls, with
 * a back button rather than a cramped overlay.
 *
 * DOM only — every content decision lives in detail.ts, which Node tests.
 */
import { detailFetchId, detailModel, type DetailModel, type FetchedDetail } from "./detail.js";
import { esc } from "./escape.js";
import type { Host } from "./host.client.js";

/** Section markup for the parts the lazy call fills, so a modal that is still
 *  loading looks like it is loading rather than like a product with nothing to
 *  say. On failure the skeletons are simply replaced by nothing. */
const SKELETON = `<div class="skel"></div><div class="skel w60"></div><div class="skel w40"></div>`;

function heroHtml(m: DetailModel): string {
  const first = m.images[0];
  const many = m.images.length > 1;
  return `<div class="hero${first ? "" : " noimg"}">
    ${first ? `<img id="hero" src="${esc(first)}" alt="${esc(m.title)}"
        onerror="this.closest('.hero').classList.add('noimg');this.remove();" />` : ""}
    <span class="ph">No photo</span>
    ${many ? `<button class="nav prev" data-step="-1" aria-label="Previous photo">‹</button>
      <button class="nav next" data-step="1" aria-label="Next photo">›</button>
      <span class="hpos" data-hpos>1 / ${m.images.length}</span>` : ""}
  </div>
  ${many ? `<div class="thumbs">${m.images.map((u, i) =>
    `<button class="thumb${i === 0 ? " sel" : ""}" data-thumb="${i}" aria-label="Photo ${i + 1}"><img src="${esc(u)}" alt="" loading="lazy" /></button>`).join("")}</div>` : ""}`;
}

function reviewsHtml(m: DetailModel, pending: boolean): string {
  if (!m.reviews.length) {
    // Pending → skeleton. Settled with nothing → the section disappears: an
    // empty "Reviews (0)" makes a new listing look rejected rather than new.
    return pending ? `<div class="sec"><h3 class="sech">What buyers say</h3>${SKELETON}</div>` : "";
  }
  const n = m.reviewCount || m.reviews.length;
  return `<div class="sec"><h3 class="sech">What buyers say (${n})</h3>${m.reviews.map((r) => {
    const stars = "★".repeat(Math.max(1, Math.min(5, Math.round(r.rating))));
    const date = r.created_at ? esc(String(r.created_at).slice(0, 10)) : "";
    return `<div class="rev">
      <div class="revhead"><span class="revstars">${stars}</span><span>Verified buyer</span>${date ? `<span>· ${date}</span>` : ""}</div>
      <p class="revtext">${esc(r.comment)}</p>
    </div>`;
  }).join("")}</div>`;
}

function mediaLinksHtml(m: DetailModel): string {
  const chips = [
    ...m.videos.map((v, i) => `<button class="chip" data-url="${esc(v.url)}">▶ Video ${i + 1}</button>`),
    ...m.photoLinks.map((p) => `<button class="chip" data-url="${esc(p.url)}">${esc(p.label)}</button>`),
  ];
  if (!chips.length) return "";
  // Links, never an inline <video>: this runs in a sandboxed iframe inside
  // someone else's client, and autoplaying a seller-supplied 25MB file there is
  // not ours to decide (#774 D11).
  return `<div class="sec"><h3 class="sech">Photos &amp; video</h3><div class="links">${chips.join("")}</div></div>`;
}

function videoStripHtml(m: DetailModel): string {
  if (!m.videos.length) return "";
  return `<div class="vids">${m.videos.map((v) =>
    `<span class="vid" data-url="${esc(v.url)}" role="button" tabindex="0">${
      v.poster_url ? `<img src="${esc(v.poster_url)}" alt="" loading="lazy" />` : ""
    }<span class="playchip">▶ video</span></span>`).join("")}</div>`;
}

export function detailHtml(m: DetailModel, opts: { pending: boolean }): string {
  const stars = m.rating
    ? `<div class="stars">${esc(m.rating.stars)} <span class="count">${esc(m.rating.count)}</span>${
        m.rating.label ? ` <span class="rlabel">${esc(m.rating.label)}</span>` : ""
      }${m.soldLabel ? ` <span class="count">· ${esc(m.soldLabel)}</span>` : ""}</div>`
    : m.soldLabel ? `<div class="stars"><span class="count">${esc(m.soldLabel)}</span></div>` : "";
  const seller = m.seller
    ? `<div class="sellerline">Sold by <strong>${esc(m.seller.name)}</strong>${m.seller.verified ? ` <span class="verified" title="Verified seller">✓ verified</span>` : ""}</div>`
    : opts.pending ? `<div class="skel w40"></div>` : "";
  const desc = m.description
    ? `<p class="desc">${esc(m.description)}</p>`
    : opts.pending ? SKELETON : "";
  const links = m.links.length
    ? `<div class="sec"><div class="links">${m.links.map((l, i) =>
        `<button class="chip${i === 0 ? " primary" : ""}" data-url="${esc(l.url)}">${esc(l.label)}</button>`).join("")}</div></div>`
    : "";
  return `${heroHtml(m)}
    ${videoStripHtml(m)}
    <div class="dbody">
      <div class="dtitle">${esc(m.title)}</div>
      ${stars}
      <div class="meta"><span class="dprice">${esc(m.price)}</span>${
        m.badge ? ` <span class="badge ${m.badge.cls}">${esc(m.badge.text)}</span>` : ""
      }</div>
      ${seller}
      ${desc}
    </div>
    ${links}
    ${reviewsHtml(m, opts.pending)}
    ${mediaLinksHtml(m)}`;
}

/** Hero navigation for whichever detail view is mounted in `container`. */
function wireHero(container: HTMLElement, images: string[]): void {
  if (images.length < 2) return;
  let index = 0;
  const paint = (i: number) => {
    index = (i + images.length) % images.length;
    const hero = container.querySelector<HTMLImageElement>("#hero");
    if (hero) hero.src = images[index];
    container.querySelectorAll<HTMLElement>(".thumb").forEach((t, n) => t.classList.toggle("sel", n === index));
    const pos = container.querySelector<HTMLElement>("[data-hpos]");
    if (pos) pos.textContent = `${index + 1} / ${images.length}`;
  };
  container.addEventListener("click", (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    const nav = el?.closest<HTMLElement>(".nav");
    if (nav) { ev.stopPropagation(); paint(index + Number(nav.dataset.step || 1)); return; }
    const thumb = el?.closest<HTMLElement>(".thumb");
    if (thumb) { ev.stopPropagation(); paint(Number(thumb.dataset.thumb || 0)); }
  });
  container.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowRight") paint(index + 1);
    else if (ev.key === "ArrowLeft") paint(index - 1);
  });
}

/** The firestarter_product mount: the tool result IS the whole product. */
export function renderDetailPage(root: HTMLElement, product: Record<string, unknown>): void {
  const model = detailModel(product, product as FetchedDetail);
  root.innerHTML = `<div class="detail page">${detailHtml(model, { pending: false })}</div>`;
  wireHero(root, model.images);
}

let sheet: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

/** Tear the sheet down without touching the display mode. Opening a second
 *  product goes through here rather than closeSheet: asking the host to shrink
 *  back to inline and immediately expand again makes it animate a collapse the
 *  buyer never asked for, between two views that both want the full surface. */
function dismiss(): void {
  sheet?.remove();
  sheet = null;
  if (onKey) { window.removeEventListener("keydown", onKey); onKey = null; }
}

export function closeSheet(host: Host): void {
  if (!sheet) return;
  dismiss();
  // Give the surface back — the grid is a browsing view and does not want the
  // whole window.
  host.setDisplayMode("inline");
}

/**
 * Open the detail view over the grid for a clicked card, then top it up.
 *
 * Renders from the row on the first frame — a modal that waits for a network
 * round trip before showing anything is a modal that feels broken — and
 * re-renders once firestarter_product answers with the description, seller and
 * review quotes the row never carried. An external result (no listing id) skips
 * the call entirely rather than spending a round trip to earn a 404.
 */
export function openSheet(item: Record<string, unknown>, host: Host): void {
  dismiss();
  host.setDisplayMode("fullscreen");

  const fetchId = detailFetchId(item);
  const paint = (fetched: FetchedDetail | null, pending: boolean) => {
    const model = detailModel(item, fetched);
    const body = `<div class="sheetbar">
        <button class="back" data-close aria-label="Back to results">‹ Back to results</button>
      </div>
      <div class="detail sheet">${detailHtml(model, { pending })}</div>`;
    if (!sheet) return;
    sheet.innerHTML = body;
    wireHero(sheet, model.images);
  };

  sheet = document.createElement("div");
  sheet.className = "sheetwrap";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  document.body.appendChild(sheet);
  paint(null, fetchId !== null);
  sheet.querySelector<HTMLElement>(".back")?.focus();

  onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSheet(host); };
  window.addEventListener("keydown", onKey);

  if (!fetchId) return;
  // Stamped BEFORE the call so the in-flight guard below can never race it.
  sheet.dataset.for = fetchId;
  void host.callTool("firestarter_product", { listing_id: fetchId }).then((sc) => {
    // The sheet may have been closed, or a different card opened, while the
    // call was in flight — repainting then would replace one product's detail
    // with another's.
    if (!sheet || sheet.dataset.for !== fetchId) return;
    const product = sc?.product;
    paint(product && typeof product === "object" ? (product as FetchedDetail) : null, false);
  });
}
