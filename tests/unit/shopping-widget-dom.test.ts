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

function fakeHost(overrides: Partial<Host> = {}): Host & { modes: string[]; calls: any[] } {
  const modes: string[] = [];
  const calls: any[] = [];
  return {
    modes,
    calls,
    openLink: () => {},
    callTool: async (name, args) => { calls.push({ name, args }); return null; },
    setDisplayMode: (mode) => { modes.push(mode); },
    ...overrides,
  } as Host & { modes: string[]; calls: any[] };
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
  closeDetail(fakeHost());
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

  it("asks the host for the whole surface, and gives it back on close", () => {
    const host = fakeHost();
    showDetail(root, ROW, host, {});
    expect(host.modes).toEqual(["fullscreen"]);
    closeDetail(host);
    expect(host.modes).toEqual(["fullscreen", "inline"]);
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
