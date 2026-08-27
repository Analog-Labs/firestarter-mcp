// @vitest-environment jsdom
/**
 * The widget's DOM behaviour — the two things a buyer actually sees.
 *
 * The pure modules pin the RULES (when a card rotates, what the detail view
 * says); these pin the WIRING that acts on them, which is where a silent
 * failure would hide: a card that renders one photo and never advances, or a
 * sheet that opens on a skeleton and never fills.
 *
 * jsdom, not a real browser, so the two things jsdom cannot do are done by
 * hand: an <img> never loads (its onload is fired explicitly, which is exactly
 * what the cross-fade waits for), and there is no IntersectionObserver (the
 * carousel treats every card as on screen, which is what it does on a host
 * without one too).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderGrid, showShotFromBar, stopCarousels } from "../../src/mcp/ui/grid.client.js";
import { showDetail, closeDetail, renderDetailPage } from "../../src/mcp/ui/detail.client.js";
import { SLIDE_MS } from "../../src/mcp/ui/carousel.js";
import type { Host } from "../../src/mcp/ui/host.client.js";

const PHOTOS = ["https://img.test/1.jpg", "https://img.test/2.jpg", "https://img.test/3.jpg"];

const ROW = {
  id: "lst_abc123",
  product_name: "Leather conditioner",
  current_price: 24,
  currency: "USD",
  images: PHOTOS,
  videos: [{ url: "https://img.test/clip.mp4", poster_url: null }],
  buyable: true,
  share_url: "https://firestarter.network/l/lst_abc123",
  rating: 4.6,
  rating_count: 12,
};

const EXTERNAL = {
  id: "gs_77",
  title: "Leather conditioner",
  source: "google_shopping",
  price_usd: 19.5,
  currency: "USD",
  image_url: "https://img.test/ext.jpg",
  url: "https://shop.example.com/p/1",
};

let root: HTMLElement;

function fakeHost(overrides: Partial<Host> = {}): Host & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    openLink: () => {},
    callTool: async (name, args) => { calls.push({ name, args }); return null; },
    ...overrides,
  } as Host & { calls: any[] };
}

/** jsdom never loads an image; the carousel waits for onload before swapping. */
function finishLoad(img: HTMLImageElement): void {
  img.onload?.(new Event("load"));
}

beforeEach(() => {
  document.body.innerHTML = `<div id="root"></div>`;
  root = document.getElementById("root")!;
});

afterEach(() => {
  stopCarousels();
  closeDetail();
  vi.useRealTimers();
});

describe("the grid", () => {
  it("gives a multi-photo card two layers, a bar per photo, and a media count", () => {
    renderGrid(root, [ROW]);
    const media = root.querySelector(".media")!;
    expect(media.querySelectorAll("img.shot")).toHaveLength(2);
    expect(media.querySelectorAll(".bar")).toHaveLength(3);
    expect(media.querySelector(".mcount")?.textContent).toBe("📷 3 · ▶ 1");
  });

  it("leaves a single-photo card with no carousel at all", () => {
    // No bars, no second layer, no timer: there is nothing to rotate.
    renderGrid(root, [{ ...ROW, images: ["https://img.test/only.jpg"], videos: [] }]);
    const media = root.querySelector(".media")!;
    expect(media.querySelectorAll(".bar")).toHaveLength(0);
    expect(media.hasAttribute("data-shots")).toBe(false);
    expect(media.querySelector(".mcount")).toBeNull();
  });

  it("shows the placeholder for a row with no photo", () => {
    renderGrid(root, [{ ...ROW, images: [], image_url: null }]);
    expect(root.querySelector(".media")?.classList.contains("noimg")).toBe(true);
  });

  it("says so when there is nothing to show", () => {
    renderGrid(root, []);
    expect(root.textContent).toContain("No products to show");
  });
});

describe("the auto-carousel", () => {
  it("cross-fades to the next photo on its own", () => {
    // THE feature. Without the swap a four-photo listing looks identical to a
    // one-photo listing, which is the bug the dots failed to solve.
    vi.useFakeTimers();
    renderGrid(root, [ROW]);
    const media = root.querySelector(".media")!;
    const [first, second] = Array.from(media.querySelectorAll<HTMLImageElement>("img.shot"));
    expect(first.classList.contains("on")).toBe(true);

    vi.advanceTimersByTime(SLIDE_MS + 400);
    expect(second.getAttribute("src")).toBe(PHOTOS[1]);
    // Still on the first photo until the next one has actually decoded — a
    // swap before load is a flash of empty tile.
    expect(first.classList.contains("on")).toBe(true);

    finishLoad(second);
    expect(second.classList.contains("on")).toBe(true);
    expect(first.classList.contains("on")).toBe(false);
    expect(media.querySelectorAll(".bar")[1].classList.contains("on")).toBe(true);
  });

  it("holds still while the tab is hidden", () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderGrid(root, [ROW]);
    const media = root.querySelector(".media")!;
    const second = media.querySelectorAll<HTMLImageElement>("img.shot")[1];

    vi.advanceTimersByTime(SLIDE_MS * 3);

    expect(second.getAttribute("src")).toBeNull();
    expect(media.classList.contains("running")).toBe(false);
    hidden.mockRestore();
  });

  it("jumps to the photo whose bar was clicked", () => {
    renderGrid(root, [ROW]);
    const media = root.querySelector(".media")!;
    const bars = Array.from(media.querySelectorAll<HTMLElement>(".bar"));
    const [first, second] = Array.from(media.querySelectorAll<HTMLImageElement>("img.shot"));

    showShotFromBar(bars[2]);
    expect(second.getAttribute("src")).toBe(PHOTOS[2]);
    finishLoad(second);

    expect(second.classList.contains("on")).toBe(true);
    expect(first.classList.contains("on")).toBe(false);
    expect(bars[2].classList.contains("on")).toBe(true);
  });
});

describe("the detail view", () => {
  it("replaces the grid in place rather than floating over it", () => {
    // A fixed overlay only ever covers the widget's own viewport, and the host
    // draws its composer on top of that — which is how the seller line and the
    // photo links ended up permanently behind the message box. In flow, the
    // host lays the detail out like any other widget content and autoResize
    // sizes the frame to it.
    const host = fakeHost();
    renderGrid(root, [ROW]);
    showDetail(root, ROW, host, {});

    expect(root.querySelector(".detail")).not.toBeNull();
    expect(root.querySelector(".grid")).toBeNull();
    expect(document.querySelector(".sheetwrap")).toBeNull();
  });

  it("shows the product from the row on the frame it opens", () => {
    // A detail view that waits for a network round trip before showing
    // anything reads as broken.
    const host = fakeHost();
    showDetail(root, ROW, host, {});
    expect(root.textContent).toContain("Leather conditioner");
    expect(root.textContent).toContain("USD 24.00");
    expect(root.querySelector(".hero img")?.getAttribute("src")).toBe(PHOTOS[0]);
  });

  it("stays in the chat: nothing in the client can ask the host for a panel or fullscreen", () => {
    // Asking for a display mode on open is what made Claude Desktop show the
    // same product a second time as a modal over the transcript. The request
    // lived in host.client.ts, which no jsdom test can exercise (it needs the
    // host bridge), so the guard is on the source: a regression that re-adds
    // the request has to re-add these identifiers to do it.
    const ui = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/mcp/ui");
    for (const file of ["host.client.ts", "detail.client.ts", "shopping-results.client.ts", "grid.client.ts"]) {
      const src = readFileSync(resolve(ui, file), "utf8");
      expect(`${file}: ${src.match(/requestDisplayMode|availableDisplayModes|setDisplayMode/g) ?? "clean"}`).toBe(`${file}: clean`);
    }
  });

  it("offers the way back at the bottom as well as the top", () => {
    // Inline, nothing can pin the top bar (the frame does not scroll on its
    // own), and a touch host has no Escape key: a buyer who has read to the
    // bottom of a phone-width view needs a way out from there.
    const onBack = vi.fn();
    showDetail(root, ROW, fakeHost(), { onBack });
    const exits = root.querySelectorAll<HTMLElement>("[data-close]");
    expect(exits).toHaveLength(2);
    expect(root.querySelector(".detail")!.lastElementChild!.contains(exits[1])).toBe(true);
    exits[1].click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does not let a previous product's gallery answer arrow keys in the next one", () => {
    // The gallery listeners used to be added to the persistent #root on every
    // paint and never removed. A one-photo product has no gallery of its own,
    // so ArrowRight there ran the PREVIOUS product's closure: its hero and
    // zoom link swapped to a photo of a different product, with no thumbnails
    // to recover from it.
    const onBack = vi.fn(() => { root.innerHTML = ""; });
    showDetail(root, ROW, fakeHost(), { onBack });
    closeDetail();
    const single = { ...ROW, id: "lst_single", product_name: "Single photo", images: ["https://img.test/solo.jpg"] };
    showDetail(root, single, fakeHost(), {});

    root.querySelector<HTMLElement>(".back")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(root.querySelector<HTMLImageElement>("#hero")?.getAttribute("src")).toBe("https://img.test/solo.jpg");
    expect(root.querySelector(".zoom")?.getAttribute("data-url")).toBe("https://img.test/solo.jpg");
  });

  it("keeps the zoom button through a photo that fails to load, and moves on with the gallery", () => {
    // One purged CDN object used to delete the button that carries the url,
    // so photos 2..N paged through the counter with nothing in the hero and
    // nothing to click. The chips this replaced never had that failure mode.
    showDetail(root, ROW, fakeHost(), {});
    const hero = root.querySelector<HTMLImageElement>("#hero")!;
    // jsdom does not run inline handler attributes; execute the attribute body
    // the way the browser would, as the image's own handler.
    new Function(hero.getAttribute("onerror")!).call(hero);

    const box = root.querySelector(".hero")!;
    expect(box.classList.contains("noimg")).toBe(true);
    expect(root.querySelector(".hero .zoom")).not.toBeNull();

    (root.querySelector(".nav.next") as HTMLElement).click();
    expect(box.classList.contains("noimg")).toBe(false);
    expect(hero.getAttribute("src")).toBe(PHOTOS[1]);
    expect(root.querySelector(".zoom")?.getAttribute("data-url")).toBe(PHOTOS[1]);
  });

  it("opens the photo on screen at full size from the hero, and follows the gallery", () => {
    // The hero IS the way to enlarge a photo — the row of "Photo 1 / Photo 2"
    // chips it replaces sat at the bottom of the view, nowhere near the photo
    // a buyer would be squinting at. It carries data-url so the document-level
    // link handler opens it through the host like any other outbound link,
    // and the url must move with the hero or the buyer enlarges the wrong shot.
    showDetail(root, ROW, fakeHost(), {});
    const zoom = root.querySelector<HTMLElement>(".hero .zoom")!;
    expect(zoom.tagName).toBe("BUTTON");
    expect(zoom.getAttribute("data-url")).toBe(PHOTOS[0]);
    expect(zoom.querySelector("img")?.getAttribute("src")).toBe(PHOTOS[0]);

    (root.querySelector(".nav.next") as HTMLElement).click();
    expect(zoom.getAttribute("data-url")).toBe(PHOTOS[1]);
    expect(zoom.getAttribute("aria-label")).toContain("2 of 3");

    (root.querySelectorAll(".thumb")[2] as HTMLElement).click();
    expect(zoom.getAttribute("data-url")).toBe(PHOTOS[2]);
  });

  it("no longer lists the photos as link chips", () => {
    showDetail(root, ROW, fakeHost(), {});
    expect(root.textContent).not.toContain("Open a photo at full size");
    expect(root.textContent).not.toContain("Photo 1");
  });

  it("opens nothing from a hero that has no photo", () => {
    showDetail(root, { ...ROW, images: [], image_url: null }, fakeHost(), {});
    expect(root.querySelector(".hero")?.classList.contains("noimg")).toBe(true);
    expect(root.querySelector(".hero [data-url]")).toBeNull();
  });

  it("goes back to the results it came from", () => {
    const host = fakeHost();
    const onBack = vi.fn();
    showDetail(root, ROW, host, { onBack });
    (root.querySelector("[data-close]") as HTMLElement).click();
    expect(onBack).toHaveBeenCalled();
  });

  it("fills in the description, seller and reviews the row never carried", async () => {
    const host = fakeHost({
      callTool: async () => ({
        product: {
          description: "Restores dry leather.",
          seller: "Wax & Hide",
          seller_verified: true,
          images: PHOTOS,
          reviews: { count: 9, top: [{ rating: 5, comment: "Works well", created_at: "2026-08-01" }] },
        },
      }),
    });
    showDetail(root, ROW, host, {});
    expect(root.querySelectorAll(".skel").length).toBeGreaterThan(0);

    await vi.waitFor(() => expect(root.textContent).toContain("Works well"));
    expect(root.textContent).toContain("Restores dry leather.");
    expect(root.textContent).toContain("Wax & Hide");
    expect(root.textContent).toContain("What buyers say (9)");
    expect(root.querySelectorAll(".skel")).toHaveLength(0);
  });

  it("never calls the product tool for an external result", async () => {
    const host = fakeHost();
    showDetail(root, EXTERNAL, host, {});
    expect(host.calls).toEqual([]);
    expect(root.textContent).toContain("Open on shop.example.com");
  });

  it("closes on Escape", () => {
    const host = fakeHost();
    const onBack = vi.fn();
    showDetail(root, ROW, host, { onBack });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("drops a stale fetch when another product was opened meanwhile", async () => {
    let release: (v: any) => void = () => {};
    const slow = new Promise<any>((r) => { release = r; });
    const host = fakeHost({
      callTool: async (_name, args) => (args.listing_id === "lst_abc123" ? slow : new Promise(() => {})),
    });
    showDetail(root, ROW, host, {});
    showDetail(root, { ...ROW, id: "lst_other", product_name: "Something else" }, host, {});
    release({ product: { description: "Belongs to the first product." } });
    await slow;
    await new Promise((r) => setTimeout(r, 0));

    expect(root.textContent).not.toContain("Belongs to the first product.");
  });
});

describe("video", () => {
  const host = () => fakeHost();

  it("plays the clip in place instead of sending the buyer out to a browser", () => {
    // Reported as "videos not playing": a poster that opens a URL is a link,
    // not a player, and in a desktop client it dumps you into a browser tab.
    // The clips are on our own blob origin, which the resource already
    // allowlists in csp.resourceDomains, so they can simply play here.
    showDetail(root, ROW, host(), {});
    (root.querySelector(".vid") as HTMLElement).click();

    const video = root.querySelector<HTMLVideoElement>(".hero video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("src")).toBe("https://img.test/clip.mp4");
    expect(video!.hasAttribute("controls")).toBe(true);
  });

  it("goes back to the photos when a thumbnail is picked", () => {
    showDetail(root, ROW, host(), {});
    (root.querySelector(".vid") as HTMLElement).click();
    (root.querySelectorAll(".thumb")[1] as HTMLElement).click();

    expect(root.querySelector(".hero video")).toBeNull();
    expect(root.querySelector<HTMLImageElement>(".hero img")?.getAttribute("src")).toBe(PHOTOS[1]);
  });

  it("offers a way out when the clip will not play here", () => {
    // Codec the host cannot decode, or a blob that 404s. Leaving a dead black
    // rectangle is the one outcome with no way forward.
    showDetail(root, ROW, host(), {});
    (root.querySelector(".vid") as HTMLElement).click();
    const video = root.querySelector<HTMLVideoElement>(".hero video")!;
    video.dispatchEvent(new Event("error"));

    expect(root.querySelector(".hero video")).toBeNull();
    expect(root.querySelector(".hero .playfail")?.getAttribute("data-url")).toBe("https://img.test/clip.mp4");
    // And the photo is back to being the way to open the photo, not the clip.
    expect(root.querySelector(".hero .zoom")?.getAttribute("data-url")).toBe(PHOTOS[0]);
  });
});

describe("the firestarter_product page", () => {
  it("renders the full product, its reviews and its links", () => {
    renderDetailPage(root, {
      title: "Leather conditioner",
      images: PHOTOS,
      price: 24,
      currency: "USD",
      description: "Restores dry leather.",
      seller: "Wax & Hide",
      seller_verified: true,
      share_url: "https://firestarter.network/l/lst_abc123",
      videos: [{ url: "https://img.test/clip.mp4", poster_url: null }],
      reviews: { count: 2, top: [{ rating: 5, comment: "Works well", created_at: "2026-08-01" }] },
      rating: 4.6,
      rating_count: 12,
      rating_is_seller_level: true,
      units_sold: 31,
    });
    const text = root.textContent!;
    expect(text).toContain("Works well");
    expect(text).toContain("View listing page");
    expect(text).toContain("31 sold");
    // The fallback must be labelled: unlabelled seller stars read as this
    // product's own.
    expect(text).toContain("seller rating");
    expect(root.querySelectorAll(".vid")).toHaveLength(1);
    expect(root.querySelectorAll(".thumb")).toHaveLength(3);
  });
});
