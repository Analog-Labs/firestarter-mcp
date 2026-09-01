// @vitest-environment jsdom
/**
 * The photo drop zone's DOM behaviour — the seller-side path where a silent
 * failure costs a listing its photos.
 *
 * Pinned here, because each was a deliberate design decision:
 *  - attach and activate are SEPARATE update_listing calls, so a refused
 *    activation (verification gate, price gate) can never take the just-
 *    attached photos down with it;
 *  - the attach call carries existing_image_urls + the new uploads — because
 *    image_urls replaces the gallery wholesale (commerce#775), forgetting the
 *    existing photos would DELETE them;
 *  - a bad file (wrong type, > 6MB) is reported and skipped without blocking
 *    the good ones in the same drop;
 *  - every outcome is mirrored to the model via tellModel.
 *
 * Files enter through the hidden input's change event: jsdom has no
 * DataTransfer constructor, and the drop handler and the input handler feed
 * the same handleFiles().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderUploader, renderListingCard } from "../../src/mcp/ui/uploader.client.js";
import type { Host } from "../../src/mcp/ui/host.client.js";

let root: HTMLElement;

type FullResult = { ok: boolean; text: string; structured: Record<string, unknown> | null };

function fakeHost(script: (name: string, args: Record<string, unknown>) => FullResult | null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const told: string[] = [];
  const host: Host = {
    openLink: () => {},
    callTool: async () => null,
    callToolFull: async (name, args) => {
      calls.push({ name, args });
      return script(name, args);
    },
    tellModel: async (text) => { told.push(text); },
  };
  return { host, calls, told };
}

function imageFile(name: string, bytes = 64, type = "image/jpeg"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Push files through the hidden input, then wait for the async pipeline. */
async function dropFiles(files: File[]): Promise<void> {
  const input = root.querySelector<HTMLInputElement>("#dzf")!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
  // The pipeline is FileReader + sequential bridge calls; poll the status
  // line until it settles on a terminal message.
  await vi.waitFor(() => {
    const s = root.querySelector("#dzs")!.textContent ?? "";
    if (!s || /Uploading|Attaching|Activating/.test(s)) throw new Error("still busy");
  }, { timeout: 3000 });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById("root")!;
});

const UPLOAD_OK: FullResult = {
  ok: true,
  text: "uploaded",
  structured: { url: "https://api.test/v1/img/new1" },
};

describe("drop zone: upload → attach → activate", () => {
  it("attaches existing + new photos, then activates, and tells the model", async () => {
    const { host, calls, told } = fakeHost((name) => {
      if (name === "firestarter_upload_image") return UPLOAD_OK;
      return { ok: true, text: "updated", structured: null };
    });
    renderUploader(root, {
      listing_id: "lst_1",
      product_name: "Walnut Desk Lamp",
      existing_image_urls: ["https://api.test/v1/img/old1"],
      activate: true,
    }, undefined, () => host);

    expect(root.textContent).toContain("Walnut Desk Lamp");
    await dropFiles([imageFile("lamp.jpg")]);

    expect(calls.map((c) => c.name)).toEqual([
      "firestarter_upload_image",
      "firestarter_update_listing",
      "firestarter_update_listing",
    ]);
    // The attach call must carry the WHOLE gallery — old photo kept.
    expect(calls[1].args).toEqual({
      listing_id: "lst_1",
      image_urls: ["https://api.test/v1/img/old1", "https://api.test/v1/img/new1"],
    });
    // Activation is its own call, with no image payload to lose.
    expect(calls[2].args).toEqual({ listing_id: "lst_1", status: "active" });
    expect(root.querySelector("#dzs")!.textContent).toContain("live");
    expect(told.join(" ")).toContain("activated");
  });

  it("keeps the photos and surfaces the reason when activation is refused", async () => {
    const { host, calls, told } = fakeHost((name, args) => {
      if (name === "firestarter_upload_image") return UPLOAD_OK;
      if (args.status === "active") return { ok: false, text: "Cannot activate: possession verification required (FS-1234).", structured: null };
      return { ok: true, text: "updated", structured: null };
    });
    renderUploader(root, { listing_id: "lst_1", existing_image_urls: [], activate: true }, undefined, () => host);

    await dropFiles([imageFile("a.jpg")]);

    // Attach happened and is not rolled into the failed activation.
    expect(calls.filter((c) => c.name === "firestarter_update_listing")).toHaveLength(2);
    expect(root.querySelector("#dzs")!.textContent).toContain("attached");
    expect(told.join(" ")).toContain("possession verification");
  });

  it("does not touch status when activate is false (photo added to a live listing)", async () => {
    const { host, calls } = fakeHost((name) => {
      if (name === "firestarter_upload_image") return UPLOAD_OK;
      return { ok: true, text: "updated", structured: null };
    });
    renderUploader(root, { listing_id: "lst_1", existing_image_urls: [], activate: false }, undefined, () => host);

    await dropFiles([imageFile("a.jpg")]);

    const updates = calls.filter((c) => c.name === "firestarter_update_listing");
    expect(updates).toHaveLength(1);
    expect(updates[0].args.status).toBeUndefined();
  });

  it("uploads without attaching when there is no listing yet", async () => {
    const { host, calls, told } = fakeHost(() => UPLOAD_OK);
    renderUploader(root, {}, undefined, () => host);

    await dropFiles([imageFile("a.jpg")]);

    expect(calls.map((c) => c.name)).toEqual(["firestarter_upload_image"]);
    expect(told.join(" ")).toContain("https://api.test/v1/img/new1");
  });
});

describe("drop zone: bad input handling", () => {
  it("skips an unsupported file and an oversized file but uploads the good one", async () => {
    const { host, calls } = fakeHost(() => UPLOAD_OK);
    renderUploader(root, {}, undefined, () => host);

    await dropFiles([
      imageFile("notes.pdf", 64, "application/pdf"),
      imageFile("huge.jpg", 7 * 1024 * 1024),
      imageFile("good.jpg"),
    ]);

    expect(calls.filter((c) => c.name === "firestarter_upload_image")).toHaveLength(1);
    const status = root.querySelector("#dzs")!.textContent ?? "";
    expect(status).toContain("notes.pdf");
    expect(status).toContain("huge.jpg");
  });

  it("shows the dashboard fallback when every upload fails", async () => {
    const { host, told } = fakeHost(() => ({ ok: false, text: "Error: image upload returned no URL.", structured: null }));
    renderUploader(root, {}, undefined, () => host);

    await dropFiles([imageFile("a.jpg")]);

    expect(root.querySelector("#dzs")!.textContent).toContain("Upload failed");
    expect(root.querySelector('#dzs [data-url]')!.getAttribute("data-url")).toContain("firestarter.network/seller");
    expect(told.join(" ")).toContain("FAILED");
  });
});

describe("listing card", () => {
  it("renders title, price, status and share link", () => {
    renderListingCard(root, {
      id: "lst_1",
      title: "Walnut Desk Lamp",
      price: 89.5,
      status: "active",
      images: ["https://api.test/v1/img/x"],
      share_url: "https://firestarter.network/l/lst_1",
    });
    expect(root.textContent).toContain("Walnut Desk Lamp");
    expect(root.textContent).toContain("$89.50");
    expect(root.textContent).toContain("Live");
    expect(root.querySelector('[data-url="https://firestarter.network/l/lst_1"]')).toBeTruthy();
  });

  it("lists activation blocks on a draft", () => {
    renderListingCard(root, { title: "Lamp", status: "draft", images: [], blocked: ["Add a product photo"] });
    expect(root.textContent).toContain("draft");
    expect(root.textContent).toContain("Add a product photo");
  });
});

/**
 * commerce#1007 — dispute evidence through the same side channel.
 *
 * The shape differs from the listing and avatar modes in one load-bearing way:
 * nothing is "attached" afterwards. Each upload call carries the dispute id and
 * firestarter_upload_image posts that photo to the thread itself, because the
 * dispute tools move money (refund / accept / withdraw) and must not be
 * reachable from a widget-originated call.
 */
describe("the drop zone in dispute mode", () => {
  const DISPUTE = { dispute_id: "disp_1", dispute_side: "buyer" as const, dispute_label: "Bow and Arrow Toy" };

  const uploadedAs = (url: string): FullResult => ({ ok: true, text: "posted", structured: { url } });

  it("posts each photo to the dispute in the SAME call, never touching a dispute tool", async () => {
    let n = 0;
    const { host, calls, told } = fakeHost(() => uploadedAs(`https://api.test/v1/img/e${++n}`));
    renderUploader(root, { ...DISPUTE, dispute_note: "the corner is crushed" }, undefined, () => host);

    await dropFiles([imageFile("a.jpg"), imageFile("b.jpg")]);

    expect(calls.map((c) => c.name)).toEqual(["firestarter_upload_image", "firestarter_upload_image"]);
    // Money-moving tools stay out of reach of the widget.
    expect(calls.some((c) => c.name.includes("disputes"))).toBe(false);
    for (const c of calls) {
      expect(c.args).toMatchObject({ dispute_id: "disp_1", dispute_side: "buyer" });
    }
    // The person's words belong in the thread once, not once per photo.
    expect(calls[0].args.dispute_note).toBe("the corner is crushed");
    expect(calls[1].args.dispute_note).toBeUndefined();
    expect(told.join(" ")).toContain("posted to dispute disp_1");
  });

  it("sends the note with the first photo that actually lands", async () => {
    let n = 0;
    const { host, calls } = fakeHost(() =>
      ++n === 1 ? { ok: false, text: "storage blip", structured: null } : uploadedAs("https://api.test/v1/img/e2"));
    renderUploader(root, { ...DISPUTE, dispute_note: "see the tear" }, undefined, () => host);

    await dropFiles([imageFile("a.jpg"), imageFile("b.jpg")]);

    // The first call failed, so its note never reached the thread — the second
    // must carry it rather than silently dropping the buyer's words.
    expect(calls[1].args.dispute_note).toBe("see the tear");
  });

  it("caps a drop at the five attachments the thread will accept", async () => {
    let n = 0;
    const { host, calls } = fakeHost(() => uploadedAs(`https://api.test/v1/img/e${++n}`));
    renderUploader(root, DISPUTE, undefined, () => host);

    await dropFiles(Array.from({ length: 7 }, (_, i) => imageFile(`p${i}.jpg`)));

    // Uploading a sixth would spend the bytes and then have the message
    // endpoint refuse the whole post.
    expect(calls).toHaveLength(5);
    expect(root.querySelector("#dzs")!.textContent).toContain("Skipped");
  });

  it("names the dispute it is collecting evidence for", () => {
    const { host } = fakeHost(() => null);
    renderUploader(root, DISPUTE, undefined, () => host);
    expect(root.querySelector(".dz-head")!.textContent).toBe("Bow and Arrow Toy");
    expect(root.querySelector(".dz-big")!.textContent).toContain("evidence");
    // One message takes several photos, unlike the single-file avatar mode.
    expect(root.querySelector<HTMLInputElement>("#dzf")!.multiple).toBe(true);
  });

  it("reports a failed post instead of implying the evidence landed", async () => {
    const { host, told } = fakeHost(() => ({ ok: false, text: "Dispute not found", structured: null }));
    renderUploader(root, DISPUTE, undefined, () => host);

    await dropFiles([imageFile("a.jpg")]);

    expect(root.querySelector("#dzs")!.textContent).toContain("Dispute not found");
    expect(told.join(" ")).toContain("FAILED");
  });
});
