/**
 * Seller-side views for the shopping widget: the photo drop zone, the listing
 * card, and the single-upload confirmation.
 *
 * Why a drop zone at all: a photo attached in chat has no URL and the model
 * cannot emit its bytes — an image_base64 argument written by the model is a
 * fabrication (bug #958's 534-byte "JPEG"). This view is the side channel: the
 * ORIGINAL file's bytes travel widget → host bridge → server tool call, and the
 * model only ever sees the hosted URL that comes back.
 *
 * Robustness decisions, each earned by a prior failure:
 *  - Files upload SEQUENTIALLY. Parallel bridge calls each carrying megabytes
 *    of data-URI compete for one postMessage channel; one at a time keeps the
 *    progress line truthful and the failure attributable to a single file.
 *  - Attach and activate are SEPARATE listing updates. A PATCH that sets
 *    status:"active" while any activation gate still blocks fails WHOLESALE —
 *    the photos would be lost with it. Attaching first means the photos stick
 *    even when activation is refused (e.g. a verification gate), and the
 *    refusal's reason is shown + told to the model instead of swallowed.
 *  - The gallery is existing_image_urls + everything uploaded in this widget's
 *    lifetime: image_urls REPLACES a listing's photos wholesale (commerce#775),
 *    so forgetting the existing ones would delete them.
 *  - Every outcome is mirrored to the model via tellModel, so the agent's next
 *    turn narrates what actually happened instead of guessing.
 */
import { esc } from "./escape.js";
import type { Host } from "./host.client.js";

export interface UploadRequest {
  listing_id?: string;
  product_name?: string;
  existing_image_urls?: string[];
  /** Server judged a missing photo to be the only thing keeping the listing a
   *  draft — the widget requests activation after attaching. */
  activate?: boolean;
  /** commerce#1024: the same side channel, for a COMMUNITY MARKET avatar. A
   *  market owner setting an avatar from chat has exactly the listing case's
   *  problem — the photo is an attachment with no URL — and had no path at all,
   *  because no tool exposed the avatar endpoint. One picture, not a gallery. */
  market_program_id?: string;
  market_name?: string;
}

export interface ListingSummary {
  id?: string;
  title?: string;
  price?: number;
  status?: string;
  images?: string[];
  share_url?: string;
  blocked?: string[];
}

/** Hard per-file cap, mirroring the API's MAX_IMAGE_BYTES. */
const MAX_FILE_BYTES = 6 * 1024 * 1024;
/** Per-drop cap: keeps one batch's bridge traffic and progress line sane. */
const MAX_FILES_PER_BATCH = 8;
const IMAGE_TYPE_RE = /^image\/(png|jpe?g|webp|gif)$/i;
/** Some drag sources hand over files with an empty MIME type; the extension is
 *  the only signal left. The server sniffs real bytes either way. */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

const DASHBOARD_URL = "https://firestarter.network/seller";

function hostedUrlOf(full: { text: string; structured: Record<string, unknown> | null } | null): string | null {
  const structured = full?.structured?.url;
  if (typeof structured === "string" && /^https:\/\//.test(structured)) return structured;
  return /https:\/\/\S+\/v1\/img\/\S+/.exec(full?.text ?? "")?.[0] ?? null;
}

function money(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

/** Compact card for a listing the seller just created or updated. */
export function renderListingCard(root: HTMLElement, listing: ListingSummary): void {
  const cover = Array.isArray(listing.images) && typeof listing.images[0] === "string" ? listing.images[0] : null;
  const live = listing.status === "active";
  const blocked = (Array.isArray(listing.blocked) ? listing.blocked : []).filter((b) => typeof b === "string" && b);
  root.innerHTML = `
    <div class="lc">
      <div class="lc-media${cover ? "" : " noimg"}">${cover ? `<img src="${esc(cover)}" alt="" onerror="this.parentElement.classList.add('noimg');this.remove();" />` : ""}<span class="ph">No photo</span></div>
      <div class="lc-body">
        <div class="lc-title">${esc(String(listing.title ?? "Untitled listing"))}</div>
        <div class="lc-meta">
          ${money(listing.price) ? `<span class="price">${esc(money(listing.price))}</span>` : ""}
          <span class="badge ${live ? "ok" : "muted"}">${live ? "Live" : esc(String(listing.status ?? "draft"))}</span>
        </div>
        ${blocked.length ? `<div class="lc-blocks">${blocked.map((b) => `<div class="lc-block">• ${esc(b)}</div>`).join("")}</div>` : ""}
        ${typeof listing.share_url === "string" && /^https?:\/\//i.test(listing.share_url)
          ? `<div class="badgerow"><span class="badge ok link" data-url="${esc(listing.share_url)}" role="link" tabindex="0" style="cursor:pointer">View listing page</span></div>`
          : ""}
      </div>
    </div>`;
}

/** Confirmation for a direct (model-initiated) upload that rendered the widget. */
export function renderUploadDone(root: HTMLElement, url: string): void {
  root.innerHTML = `
    <div class="uploader">
      <div class="dz-status"><span class="dz-ok">✓ Photo uploaded.</span><br><small class="dz-url">${esc(url)}</small></div>
    </div>`;
}

/**
 * The drop zone. Renders into #root; owns its own listeners (each render
 * rewrites innerHTML, so nothing leaks). `getHost` is a getter because the
 * host handle resolves in parallel with the first tool result — the bridge is
 * needed at DROP time, by when it is connected.
 */
export function renderUploader(
  root: HTMLElement,
  req: UploadRequest,
  listing: ListingSummary | undefined,
  getHost: () => Host | null,
): void {
  const listingId = typeof req.listing_id === "string" && req.listing_id ? req.listing_id : null;
  // An avatar is ONE picture that replaces what is there, not a gallery that
  // grows — so this mode takes a single file and says so.
  const marketId = typeof req.market_program_id === "string" && req.market_program_id ? req.market_program_id : null;
  const title = marketId
    ? (typeof req.market_name === "string" && req.market_name ? req.market_name : null)
    : typeof req.product_name === "string" && req.product_name
      ? req.product_name
      : typeof listing?.title === "string" ? listing.title : null;

  /** The full gallery this widget knows about: what the listing already had,
   *  plus everything uploaded here. image_urls replaces wholesale. */
  const gallery: string[] = (Array.isArray(req.existing_image_urls) ? req.existing_image_urls : [])
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  let activated = false;
  let busy = false;

  root.innerHTML = `
    <div class="uploader">
      ${title ? `<div class="dz-head">${esc(title)}</div>` : ""}
      <div class="dropzone" id="dz" role="button" tabindex="0" aria-label="${marketId ? "Upload a community market avatar: drop a file here or press Enter to browse" : "Upload product photos: drop files here or press Enter to browse"}">
        <div class="dz-big">${marketId ? "Drop the community avatar here" : `Drop product photo${listingId ? "s" : "(s)"} here`}</div>
        <small>or click to browse — JPEG, PNG, WebP or GIF, up to 6&nbsp;MB${marketId ? "" : " each"}</small>
      </div>
      <div class="dz-thumbs" id="dzt" hidden></div>
      <div class="dz-status" id="dzs" role="status" aria-live="polite"></div>
      <input id="dzf" type="file"${marketId ? "" : " multiple"} accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" />
    </div>`;

  const zone = root.querySelector<HTMLElement>("#dz")!;
  const input = root.querySelector<HTMLInputElement>("#dzf")!;
  const status = root.querySelector<HTMLElement>("#dzs")!;
  const thumbs = root.querySelector<HTMLElement>("#dzt")!;

  const showError = (msg: string) => {
    status.innerHTML = `<span class="dz-err">${esc(msg)}</span><br>` +
      `<span class="badge muted link" data-url="${esc(DASHBOARD_URL)}" role="link" tabindex="0" style="cursor:pointer">Upload in the dashboard instead</span>`;
  };

  const tell = (msg: string) => {
    void getHost()?.tellModel(`[photo-upload widget] ${msg}`);
  };

  const addThumb = (file: File) => {
    try {
      const url = URL.createObjectURL(file);
      thumbs.hidden = false;
      thumbs.insertAdjacentHTML("beforeend", `<span class="dz-thumb"><img src="${esc(url)}" alt="" /></span>`);
    } catch { /* a missing preview is cosmetic */ }
  };

  const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });

  const handleFiles = async (list: FileList | null | undefined) => {
    if (!list || list.length === 0 || busy) return;
    const host = getHost();
    if (!host) {
      showError("This host hasn't finished connecting the widget — try the drop again in a moment.");
      return;
    }

    // Partition up-front so the seller hears about every skipped file once,
    // instead of discovering them one failed upload at a time.
    const all = Array.from(list);
    const cap = marketId ? 1 : MAX_FILES_PER_BATCH;
    const batch = all.slice(0, cap);
    const skipped: string[] = all.length > cap
      ? [marketId
        ? `${all.length - 1} extra file(s) ignored — a market has one avatar`
        : `${all.length - cap} file(s) over the ${cap}-at-once limit — drop them next`]
      : [];
    const accepted: File[] = [];
    for (const f of batch) {
      if (!(IMAGE_TYPE_RE.test(f.type) || (!f.type && IMAGE_EXT_RE.test(f.name)))) {
        skipped.push(`${f.name} — not a supported image`);
      } else if (f.size > MAX_FILE_BYTES) {
        skipped.push(`${f.name} — ${(f.size / 1024 / 1024).toFixed(1)} MB (limit 6 MB)`);
      } else {
        accepted.push(f);
      }
    }
    if (accepted.length === 0) {
      showError(`Nothing to upload: ${skipped.join("; ")}`);
      return;
    }

    busy = true;
    zone.classList.add("busy");
    const uploaded: string[] = [];
    const failed: string[] = [];
    try {
      for (let i = 0; i < accepted.length; i++) {
        const file = accepted[i];
        status.textContent = accepted.length > 1
          ? `Uploading ${i + 1} of ${accepted.length} — ${file.name}…`
          : "Uploading…";
        let dataUrl: string;
        try {
          dataUrl = await readAsDataUrl(file);
        } catch (e) {
          failed.push(`${file.name} — ${e instanceof Error ? e.message : "could not read the file"}`);
          continue;
        }
        const res = await host.callToolFull("firestarter_upload_image", {
          image_base64: dataUrl,
          filename: file.name,
        });
        if (res === null) {
          // The bridge itself refused — no point pushing the rest of the batch
          // through the same wall.
          failed.push(`${file.name} — the host blocked the widget's upload call`);
          break;
        }
        const url = res.ok ? hostedUrlOf(res) : null;
        if (!url) {
          failed.push(`${file.name} — ${res.text.slice(0, 160) || "no URL returned"}`);
          continue;
        }
        uploaded.push(url);
        gallery.push(url);
        addThumb(file);
      }

      const problems = [...skipped, ...failed];
      if (uploaded.length === 0) {
        showError(`Upload failed: ${problems.join("; ").slice(0, 300)}`);
        tell(`upload FAILED: ${problems.join("; ").slice(0, 300)}`);
        return;
      }

      let summary = `${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} uploaded: ${uploaded.join(" ")}`;
      let headline = `✓ ${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} uploaded.`;

      if (marketId) {
        status.textContent = "Setting the market avatar…";
        // The hosted URL, not the bytes: the picture is already stored, and the
        // avatar endpoint only accepts a URL this server minted.
        const set = await host.callToolFull("firestarter_set_market_avatar", {
          program_id: marketId,
          image_url: uploaded[uploaded.length - 1],
        });
        if (!set?.ok) {
          const why = (set?.text ?? "the host blocked the widget's update call").slice(0, 200);
          summary += ` — but setting the avatar failed: ${why}`;
          headline = "✓ Uploaded, but setting the avatar failed.";
        } else {
          summary += ` — set as the avatar for market ${marketId}.`;
          headline = "✓ Community avatar set.";
        }
        if (problems.length) summary += ` Skipped: ${problems.join("; ").slice(0, 200)}`;
        status.innerHTML = `<span class="dz-ok">${esc(headline)}</span>` +
          (problems.length ? `<br><span class="dz-err">Skipped: ${esc(problems.join("; ").slice(0, 200))}</span>` : "");
        tell(summary);
        return;
      }

      if (listingId) {
        // Attach first — this must survive an activation refusal.
        status.textContent = "Attaching to the listing…";
        const attach = await host.callToolFull("firestarter_update_listing", {
          listing_id: listingId,
          image_urls: [...gallery],
        });
        if (!attach?.ok) {
          const why = (attach?.text ?? "the host blocked the widget's update call").slice(0, 200);
          summary += ` — but attaching to ${listingId} failed: ${why}. Attach them with firestarter_update_listing.`;
          headline = `✓ Uploaded, but attaching to the listing failed.`;
        } else {
          summary += ` — attached to ${listingId} (${gallery.length} photo${gallery.length === 1 ? "" : "s"}, cover: ${gallery[0]}).`;
          headline = `✓ ${gallery.length} photo${gallery.length === 1 ? "" : "s"} on the listing.`;
          if (req.activate && !activated) {
            status.textContent = "Activating the listing…";
            const act = await host.callToolFull("firestarter_update_listing", {
              listing_id: listingId,
              status: "active",
            });
            if (act?.ok) {
              activated = true;
              summary += " Listing activated — it is live.";
              headline = `✓ Photo${gallery.length === 1 ? "" : "s"} attached — the listing is live.`;
            } else {
              const why = (act?.text ?? "activation call failed").slice(0, 200);
              summary += ` Photos attached, but activation was refused: ${why}`;
              headline = `✓ Photos attached — activation still blocked (see below).`;
            }
          }
        }
      }
      if (problems.length) summary += ` Skipped: ${problems.join("; ").slice(0, 200)}`;

      status.innerHTML = `<span class="dz-ok">${esc(headline)}</span>` +
        (problems.length ? `<br><span class="dz-err">Skipped: ${esc(problems.join("; ").slice(0, 200))}</span>` : "") +
        `<br><small class="dz-url">${esc(uploaded.join(" "))}</small>` +
        `<br><small>Drop more to add to the gallery.</small>`;
      tell(summary);
    } finally {
      busy = false;
      zone.classList.remove("busy");
    }
  };

  zone.addEventListener("click", () => { if (!busy) input.click(); });
  zone.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && !busy) { ev.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => { void handleFiles(input.files); input.value = ""; });
  zone.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    zone.classList.remove("drag");
    void handleFiles(ev.dataTransfer?.files);
  });
}
