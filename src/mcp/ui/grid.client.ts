/**
 * The product grid and its auto-carousel.
 *
 * What changed and why: the grid used to render one photo per card with a row
 * of 6px dots under it. Nobody taps a 6px target inside a chat transcript, so a
 * four-photo listing read exactly like a one-photo listing — the photos were in
 * the payload and simply never seen. Cards now rotate their photos on their
 * own, and a click opens the detail view instead of leaving for a browser.
 *
 * DOM only. Every rule about WHEN a card rotates lives in carousel.ts, and
 * every rule about what a card SAYS lives in shopping-item.ts, both of which
 * Node can test; this file owns elements and timers.
 */
import { autoAdvances, nextIndex, startDelay, SLIDE_MS } from "./carousel.js";
import { videosOf } from "./detail.js";
import { esc } from "./escape.js";
import { badgeFor, galleryImages, mediaCountLabel, priceLabel, starsLabel, type ShoppingItem } from "./shopping-item.js";

/** Scheduler resolution. One timer for the whole grid rather than one per card:
 *  a 50-result grid would otherwise run 50 interval timers that all wake even
 *  when the widget is off screen. */
const TICK_MS = 200;

interface Cell {
  media: HTMLElement;
  shots: string[];
  imgs: HTMLImageElement[];
  bars: HTMLElement[];
  /** Which of the two stacked <img> layers is currently visible. */
  layer: 0 | 1;
  index: number;
  onscreen: boolean;
  /** Per-card offset so a row of cards does not flip on the same frame. */
  stagger: number;
  dueAt: number;
}

let cells: Cell[] = [];
let byMedia = new WeakMap<Element, Cell>();
let ticker: number | null = null;
let observer: IntersectionObserver | null = null;
let reducedMotion = false;

function mediaHtml(it: ShoppingItem): string {
  const shots = galleryImages(it);
  const chip = mediaCountLabel(shots, videosOf(it.videos));
  const first = shots[0];
  // Two layers: the visible one, and the one the carousel loads the next photo
  // into before swapping. Without the second layer a photo change is a flash of
  // empty tile while the next file decodes.
  const layers = first
    ? `<img class="shot on" src="${esc(first)}" alt="" loading="lazy"
         onerror="this.closest('.media').classList.add('noimg');this.remove();" /><img class="shot" alt="" aria-hidden="true" />`
    : "";
  const bars = shots.length > 1
    ? `<div class="bars">${shots.map((_, i) =>
        `<button class="bar${i === 0 ? " on" : ""}" data-shot="${i}" aria-label="Show photo ${i + 1} of ${shots.length}"><span class="fill"></span></button>`).join("")}</div>`
    : "";
  return `<div class="media${first ? "" : " noimg"}"${shots.length > 1 ? ` data-shots="${esc(JSON.stringify(shots))}" style="--slide:${SLIDE_MS}ms"` : ""}>${layers}<span class="ph">No photo</span>${chip ? `<span class="mcount">${esc(chip)}</span>` : ""}${bars}</div>`;
}

/**
 * One card. The anatomy is fixed — media, two-line title, stars (collapsing
 * when absent), one meta row, badge pinned to the bottom — so every card in a
 * row has identical bones and badges align regardless of title length.
 */
function cardHtml(it: ShoppingItem, i: number): string {
  const title = esc(it.title || it.product_name || "Untitled");
  const badge = badgeFor(it);
  const stars = starsLabel(it);
  const seller = it.seller ? `<span class="seller">${esc(it.seller)}</span>` : "";
  return `<div class="card link" data-card="${i}" role="button" tabindex="0" aria-label="View ${title} details">
    ${mediaHtml(it)}
    <div class="body">
      <div class="title">${title}</div>
      <div class="stars">${stars ? `${esc(stars.stars)} <span class="count">${esc(stars.count)}</span>` : ""}</div>
      <div class="meta"><span class="price">${esc(priceLabel(it))}</span> ${seller}</div>
      <div class="badgerow">${badge ? `<span class="badge ${badge.cls}">${esc(badge.text)}</span>` : ""}</div>
    </div>
  </div>`;
}

export function renderGrid(root: HTMLElement, items: ShoppingItem[]): void {
  if (!items.length) {
    stopCarousels();
    root.innerHTML = `<p class="empty">No products to show.</p>`;
    return;
  }
  // When ANY card has a rating, every card reserves the stars line so prices
  // stay row-aligned next to rated neighbours; when none do, it collapses.
  const anyStars = items.some((it) => starsLabel(it) !== null);
  root.innerHTML = `<div class="grid${anyStars ? " has-stars" : ""}">${items.map(cardHtml).join("")}</div>`;
  startCarousels(root);
}

export function stopCarousels(): void {
  if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
  observer?.disconnect();
  observer = null;
  cells = [];
  byMedia = new WeakMap();
}

function startCarousels(root: HTMLElement): void {
  stopCarousels();
  reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const now = Date.now();
  root.querySelectorAll<HTMLElement>(".media[data-shots]").forEach((media, i) => {
    let shots: string[] = [];
    try {
      shots = JSON.parse(media.dataset.shots || "[]");
    } catch {
      shots = [];
    }
    const imgs = Array.from(media.querySelectorAll<HTMLImageElement>("img.shot"));
    if (shots.length < 2 || imgs.length < 2) return;
    const stagger = startDelay(i);
    const cell: Cell = {
      media,
      shots,
      imgs,
      bars: Array.from(media.querySelectorAll<HTMLElement>(".bar")),
      layer: 0,
      index: 0,
      onscreen: true,
      stagger,
      dueAt: now + SLIDE_MS + stagger,
    };
    cells.push(cell);
    byMedia.set(media, cell);
  });
  if (!cells.length) return;

  // A card nobody can see must not fetch photos or run animations.
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const cell = byMedia.get(e.target);
        if (cell) cell.onscreen = e.isIntersecting;
      }
    }, { rootMargin: "80px" });
    for (const c of cells) observer.observe(c.media);
  }
  ticker = window.setInterval(tick, TICK_MS);
}

function tick(): void {
  const now = Date.now();
  const hidden = document.hidden === true;
  for (const c of cells) {
    const hovered = c.media.matches(":hover");
    const running = autoAdvances({
      count: c.shots.length,
      reducedMotion,
      hidden,
      hovered,
      onscreen: c.onscreen,
    });
    c.media.classList.toggle("running", running);
    if (!running) {
      // Re-arm rather than accumulate: an unhovered card should show its
      // current photo for a full interval, not flip the instant the pointer
      // leaves. The stagger is kept so a row scrolling into view together
      // still de-synchronises.
      c.dueAt = now + SLIDE_MS + c.stagger;
      continue;
    }
    if (now >= c.dueAt) show(c, nextIndex(c.index, c.shots.length), now);
  }
}

/** Cross-fade the card to photo `i`. */
function show(c: Cell, i: number, now: number): void {
  // Scheduled before the load resolves: a photo that 404s must cost one beat,
  // not stall the rotation for good.
  c.dueAt = now + SLIDE_MS;
  if (i === c.index) return;
  const url = c.shots[i];
  const incoming = c.imgs[1 - c.layer];
  const outgoing = c.imgs[c.layer];
  const swap = () => {
    incoming.classList.add("on");
    outgoing.classList.remove("on");
    c.layer = (1 - c.layer) as 0 | 1;
    c.index = i;
    c.bars.forEach((b, n) => b.classList.toggle("on", n === i));
  };
  if (incoming.getAttribute("src") === url && incoming.complete) { swap(); return; }
  incoming.onload = swap;
  // A photo that will not load leaves the current one up — better than a blank
  // tile mid-rotation. The next tick moves on to the photo after it.
  incoming.onerror = null;
  incoming.src = url;
}

/** A bar was clicked: jump to that photo and give it a full interval. */
export function showShotFromBar(bar: HTMLElement): void {
  const media = bar.closest(".media");
  const cell = media ? byMedia.get(media) : null;
  if (!cell) return;
  const i = Number(bar.dataset.shot);
  if (!Number.isInteger(i) || i < 0 || i >= cell.shots.length) return;
  show(cell, i, Date.now());
}
