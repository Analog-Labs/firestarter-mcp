/**
 * The product detail view — one renderer, one mount, in the chat.
 *
 * It used to be a `position: fixed` sheet appended to document.body. That only
 * ever covers the widget's OWN viewport, and the host draws its chat composer
 * on top of that viewport — so the tail of the view (seller line, photo and
 * video links) sat behind the message box with no way to scroll clear of it.
 * Inline, where the frame is a few hundred pixels tall, the same overlay was a
 * letterbox.
 *
 * Now it renders IN FLOW, replacing the grid inside #root, and stays in the
 * inline frame: the host lays it out like any other widget content and sizes
 * the frame to it. It no longer asks the host for a panel or fullscreen on
 * open — on Claude Desktop that request opened the same product a second time
 * as a modal over the chat, and a product page that appears twice in two
 * shapes reads as two different things. Should a host move the widget
 * fullscreen on its own, the stylesheet still reserves room for the host's
 * chrome through [data-display] — see safe-area.ts.
 *
 * Content decisions live in detail.ts, which Node tests; this owns elements.
 */
import { detailFetchId, detailModel, type DetailModel, type FetchedDetail } from "./detail.js";
import { esc } from "./escape.js";
import type { Host } from "./host.client.js";

/** Placeholder lines for the sections the lazy firestarter_product call fills,
 *  so a view that is still loading looks like it is loading rather than like a
 *  product with nothing to say. */
const SKELETON = `<div class="skel"></div><div class="skel w60"></div><div class="skel w40"></div>`;

function zoomLabel(index: number, count: number): string {
  return count > 1 ? `Open photo ${index + 1} of ${count} at full size` : "Open photo at full size";
}

/**
 * The gallery. The hero is a button: clicking the photo opens the file the
 * buyer is looking at, at full size, through the host — which on a desktop
 * client is a browser tab, the one place a sandboxed iframe can show a
 * 2000px photo. It replaces the row of "Photo 1 / Photo 2" chips that used to
 * sit at the bottom of the view, where a buyer inspecting the photo would not
 * think to look for a way to enlarge it. The button carries `data-url` so the
 * document-level link handler in shopping-results.client.ts routes it like any
 * other outbound link, and wireHero rewrites that url as the photo changes.
 *
 * A photo that fails to load (a purged CDN object, an origin the CSP does not
 * allowlist) marks the hero `noimg` and is left in place: the stylesheet hides
 * the button so a dead url cannot be opened, and the next paint clears the
 * mark. Removing the button instead took the whole gallery's only way to open
 * a photo with it — photos 2..N would still page through the counter and the
 * thumbnails, with nothing in the hero and nothing to click.
 */
function mediaColumn(m: DetailModel): string {
  const first = m.images[0];
  const many = m.images.length > 1;
  return `<div class="dmedia">
    <div class="hero${first ? "" : " noimg"}">
      ${first ? `<button type="button" class="zoom" data-url="${esc(first)}" aria-label="${esc(zoomLabel(0, m.images.length))}">
          <img id="hero" src="${esc(first)}" alt="${esc(m.title)}"
            onerror="this.closest('.hero').classList.add('noimg');" />
        </button>
        <span class="zoomhint" aria-hidden="true">⤢ Full size</span>` : ""}
      <span class="ph">No photo</span>
      ${many ? `<button type="button" class="nav prev" data-step="-1" aria-label="Previous photo">‹</button>
        <button type="button" class="nav next" data-step="1" aria-label="Next photo">›</button>
        <span class="hpos" data-hpos>1 / ${m.images.length}</span>` : ""}
    </div>
    ${many ? `<div class="thumbs">${m.images.map((u, i) =>
      `<button class="thumb${i === 0 ? " sel" : ""}" data-thumb="${i}" aria-label="Photo ${i + 1}"><img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()" /></button>`).join("")}</div>` : ""}
    ${m.videos.length ? `<div class="vids">${m.videos.map((v, i) =>
      `<span class="vid" data-video="${esc(v.url)}" role="button" tabindex="0" aria-label="Play video ${i + 1}">${
        v.poster_url ? `<img src="${esc(v.poster_url)}" alt="" loading="lazy" onerror="this.remove()" />` : ""
      }<span class="playchip">▶ Play</span></span>`).join("")}</div>` : ""}
  </div>`;
}

function reviewsHtml(m: DetailModel, pending: boolean): string {
  if (!m.reviews.length) {
    if (pending) return `<section class="sec"><h3 class="sech">What buyers say</h3>${SKELETON}</section>`;
    // Rated but unwritten-about: the count is real and the section stays, or a
    // product nine buyers scored reads exactly like one nobody has touched.
    if (m.reviewsNote) {
      return `<section class="sec"><h3 class="sech">What buyers say</h3>
        <p class="revnote">${esc(m.reviewsNote)}</p></section>`;
    }
    // Settled with nothing → the section disappears. An empty "Reviews (0)"
    // makes a new listing look rejected rather than new.
    return "";
  }
  const n = m.reviewCount || m.reviews.length;
  return `<section class="sec"><h3 class="sech">What buyers say (${n})</h3>${m.reviews.map((r) => {
    const stars = "★".repeat(Math.max(1, Math.min(5, Math.round(r.rating))));
    const date = r.created_at ? esc(String(r.created_at).slice(0, 10)) : "";
    return `<article class="rev">
      <div class="revhead"><span class="revstars">${stars}</span><span>Verified buyer</span>${date ? `<span>· ${date}</span>` : ""}</div>
      <p class="revtext">${esc(r.comment)}</p>
    </article>`;
  }).join("")}</section>`;
}

function infoColumn(m: DetailModel, pending: boolean): string {
  const rating = m.rating
    ? `<div class="drating">${esc(m.rating.stars)} <span class="count">${esc(m.rating.count)}</span>${
        m.rating.label ? `<span class="rlabel">${esc(m.rating.label)}</span>` : ""
      }${m.soldLabel ? `<span class="count">· ${esc(m.soldLabel)}</span>` : ""}</div>`
    : m.soldLabel ? `<div class="drating"><span class="count">${esc(m.soldLabel)}</span></div>` : "";
  const seller = m.seller
    ? `<div class="sellerline">Sold by <strong>${esc(m.seller.name)}</strong>${
        m.seller.verified ? `<span class="verified">✓ verified</span>` : ""
      }</div>`
    : pending ? `<div class="skel w40"></div>` : "";
  const desc = m.description
    ? `<p class="desc">${esc(m.description)}</p>`
    : pending ? SKELETON : "";
  const actions = m.links.length
    ? `<div class="actions">${m.links.map((l, i) =>
        `<button class="chip${i === 0 ? " primary" : ""}" data-url="${esc(l.url)}">${esc(l.label)}</button>`).join("")}</div>`
    : "";
  return `<div class="dinfo">
    ${rating}
    ${seller}
    ${actions}
    ${desc ? `<section class="sec">${desc}</section>` : ""}
    ${reviewsHtml(m, pending)}
  </div>`;
}

/** The whole view. `back` is omitted for the firestarter_product mount, where
 *  the tool result IS the product and there are no results to go back to.
 *
 *  With `back`, the way out is offered twice: at the top, and again after the
 *  reviews. Inline, the frame does not scroll on its own, so nothing can pin
 *  the top bar — a buyer who has read to the bottom of a phone-width view is a
 *  thousand pixels from it, and a touch host has no Escape key to fall back
 *  on. */
function detailHtml(m: DetailModel, opts: { pending: boolean; back: boolean }): string {
  // Name and price lead, above the gallery. In a chat-sized frame a full-width
  // hero pushed them under the fold, so opening a product showed a photo and
  // nothing that said WHICH product — and in two columns a title spanning the
  // top is the ordinary shape of a product page anyway.
  return `<div class="detail">
    ${opts.back ? `<div class="dbar"><button class="back" data-close aria-label="Back to results">‹ Back to results</button></div>` : ""}
    <header class="dhead">
      <h2 class="dtitle">${esc(m.title)}</h2>
      <div class="pricerow">
        <span class="dprice">${esc(m.price)}</span>
        ${m.badge ? `<span class="badge ${m.badge.cls}">${esc(m.badge.text)}</span>` : ""}
      </div>
    </header>
    <div class="dgrid">
      ${mediaColumn(m)}
      ${infoColumn(m, opts.pending)}
    </div>
    ${opts.back ? `<div class="dfoot"><button class="back" data-close aria-label="Back to results">‹ Back to results</button></div>` : ""}
  </div>`;
}

/**
 * Play a clip in the hero.
 *
 * It used to be a poster that opened the file through the host, which on a
 * desktop client means a browser tab — reported, fairly, as "videos not
 * playing". The clips live on our own blob origin, which the resource already
 * allowlists in csp.resourceDomains, so they can just play here.
 *
 * `playsinline` and an explicit `controls` rather than autoplay-with-sound: a
 * widget in someone else's chat client does not get to make noise unasked.
 */
function playVideo(container: HTMLElement, url: string): void {
  const hero = container.querySelector<HTMLElement>(".hero");
  if (!hero) return;
  hero.querySelector("video")?.remove();
  hero.querySelector(".playfail")?.remove();
  const video = document.createElement("video");
  video.className = "heroplayer";
  video.setAttribute("src", url);
  video.setAttribute("controls", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("preload", "metadata");
  // A codec this host cannot decode, or a blob that 404s. A dead black
  // rectangle is the one outcome with no way forward, so hand back the link.
  video.addEventListener("error", () => {
    video.remove();
    hero.classList.remove("playing");
    const out = document.createElement("button");
    out.className = "chip playfail";
    out.setAttribute("data-url", url);
    out.textContent = "Couldn't play it here — open the video";
    hero.appendChild(out);
  });
  hero.classList.add("playing");
  hero.appendChild(video);
  // play() is SPECIFIED to return a promise and does not always return one —
  // jsdom returns undefined, and so do older WebViews. Chaining .catch onto
  // that throws, which surfaced as three unhandled errors in CI.
  const started = video.play?.();
  if (started && typeof started.catch === "function") {
    started.catch(() => { /* the controls are right there */ });
  }
}

function stopVideo(container: HTMLElement): void {
  const hero = container.querySelector<HTMLElement>(".hero");
  if (!hero) return;
  hero.querySelector("video")?.remove();
  hero.querySelector(".playfail")?.remove();
  hero.classList.remove("playing");
}

/**
 * Gallery behaviour: photo navigation, and playing a clip in the hero.
 *
 * `container` must be the `.detail` element of THIS paint, never the
 * persistent #root: the listeners live as long as their element does, and on
 * #root they outlived the view. Every paint (a second one lands when the
 * product fetch resolves) and every product opened added another set, each
 * closed over its own `images` — so an arrow key in a one-photo product, which
 * has no gallery of its own, ran the previous product's closure and swapped
 * in that product's photo, with the zoom button now pointing at its file.
 * Scoped to the element that innerHTML discards, a paint starts clean.
 */
function wireHero(container: HTMLElement, images: string[]): void {
  container.addEventListener("click", (ev) => {
    const tile = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-video]") : null;
    if (!tile?.dataset.video) return;
    ev.stopPropagation();
    playVideo(container, tile.dataset.video);
  });
  container.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const tile = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-video]") : null;
    if (!tile?.dataset.video) return;
    ev.preventDefault();
    playVideo(container, tile.dataset.video);
  });
  if (images.length < 2) return;
  let index = 0;
  const paint = (i: number) => {
    stopVideo(container);
    index = (i + images.length) % images.length;
    const hero = container.querySelector<HTMLImageElement>("#hero");
    if (hero) {
      // A previous photo's failure is not this photo's: unmark, and let the
      // onerror attribute re-mark if this one fails too.
      hero.closest(".hero")?.classList.remove("noimg");
      hero.src = images[index];
    }
    // The zoom button opens the photo ON SCREEN, so it follows the hero.
    const zoom = container.querySelector<HTMLElement>(".zoom");
    if (zoom) {
      zoom.setAttribute("data-url", images[index]);
      zoom.setAttribute("aria-label", zoomLabel(index, images.length));
    }
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

/** The element a paint just wrote, for wireHero to scope its listeners to. */
function detailEl(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>(".detail") ?? root;
}

/** The firestarter_product mount: the tool result IS the whole product. */
export function renderDetailPage(root: HTMLElement, product: Record<string, unknown>): void {
  const model = detailModel(product, product as FetchedDetail);
  root.innerHTML = detailHtml(model, { pending: false, back: false });
  wireHero(detailEl(root), model.images);
}

/** Which view is open, and which fetch is allowed to paint into it. Two clicks
 *  in quick succession must not land product A's reviews in product B's view. */
let openToken = 0;
let onKey: ((e: KeyboardEvent) => void) | null = null;
let onBackHandler: (() => void) | null = null;

function detachKey(): void {
  if (onKey) { window.removeEventListener("keydown", onKey); onKey = null; }
}

/** Drop any open view WITHOUT restoring anything: a fresh tool result is about
 *  to repaint #root, and running the back handler first would render the old
 *  results for a frame before the new ones land. */
export function resetDetail(): void {
  openToken += 1;
  detachKey();
  onBackHandler = null;
}

/** Leave the detail view and let the caller restore whatever it was showing
 *  before. */
export function closeDetail(): void {
  openToken += 1;
  detachKey();
  const back = onBackHandler;
  onBackHandler = null;
  back?.();
}

/**
 * Open the detail view for a clicked card, in place, then top it up.
 *
 * Renders from the row on the first frame — a view that waits for a network
 * round trip before showing anything reads as broken — and re-renders once
 * firestarter_product answers with the description, seller and review quotes
 * the row never carried. An external result (no listing id) skips the call
 * rather than spending a round trip to earn a 404.
 */
export function showDetail(
  root: HTMLElement,
  item: Record<string, unknown>,
  host: Host,
  opts: { onBack?: () => void },
): void {
  detachKey();
  const token = ++openToken;
  onBackHandler = opts.onBack ?? null;

  const fetchId = detailFetchId(item);
  const paint = (fetched: FetchedDetail | null, pending: boolean) => {
    const model = detailModel(item, fetched);
    root.innerHTML = detailHtml(model, { pending, back: true });
    wireHero(detailEl(root), model.images);
    root.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeDetail();
    }));
  };
  paint(null, fetchId !== null);
  // A plain focus, which scrolls: the view replaced a grid the buyer had
  // scrolled into, and a card from the bottom row would otherwise open with
  // the name, price, photo and this button all above the fold — a keyboard
  // user focused on something they cannot see.
  root.querySelector<HTMLElement>(".back")?.focus();

  onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
  window.addEventListener("keydown", onKey);

  if (!fetchId) return;
  void host.callTool("firestarter_product", { listing_id: fetchId }).then((sc) => {
    // Closed, or a different product opened, while the call was in flight.
    if (token !== openToken) return;
    const product = sc?.product;
    paint(product && typeof product === "object" ? (product as FetchedDetail) : null, false);
  });
}
