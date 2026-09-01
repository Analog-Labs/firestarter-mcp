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
  /** Same wholesale-replacement rule as images (video_urls replaces the whole
   *  set), so the widget must know what the listing already carries or a
   *  dropped clip would delete the rest. */
  existing_video_urls?: string[];
  /** commerce#1007: DISPUTE EVIDENCE. "Still not able to add image to my
   *  dispute in Claude, it wants publicly hosted image link" — the buyer had a
   *  photo attached in the chat, and the only inputs on offer were a public URL
   *  or model-emitted base64. Same side channel, same reason.
   *
   *  Each dropped file is posted to the thread by firestarter_upload_image
   *  itself, which is why this mode never calls a dispute tool: those move
   *  money (refund / accept / withdraw) and must not be reachable from a
   *  widget-originated call. */
  dispute_id?: string;
  /** Which side's endpoint carries the evidence — the buyer's and the seller's
   *  are separate surfaces with separate auth. */
  dispute_side?: "buyer" | "seller";
  /** Optional label so the dropper can see which dispute they are answering. */
  dispute_label?: string;
  /** The note the model was going to post with the photo. Sent with the FIRST
   *  file only, so the person's words appear once rather than once per photo. */
  dispute_note?: string;
  /** commerce#561: POSSESSION EVIDENCE — the item beside its handwritten
   *  FS-XXXX code. One photo, and it is SUBMITTED rather than attached: this
   *  shot is not part of the listing's gallery. The most acute case of the
   *  whole problem, since the seller took it on a phone seconds earlier and it
   *  has never had a URL. */
  verify_listing_id?: string;
  verify_label?: string;
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

/** Hard per-file cap for photos, mirroring the API's MAX_IMAGE_BYTES. */
const MAX_FILE_BYTES = 6 * 1024 * 1024;
/** Hard per-file cap for clips, mirroring the API's MAX_VIDEO_BYTES. */
const MAX_VIDEO_FILE_BYTES = 25 * 1024 * 1024;
/** A listing carries at most this many videos (API rule) — refusing the 4th
 *  here beats uploading 25MB that the attach then throws away. */
const MAX_LISTING_VIDEOS = 3;
/** Per-drop cap: keeps one batch's bridge traffic and progress line sane. */
const MAX_FILES_PER_BATCH = 8;
/** Mirrors MAX_DISPUTE_ATTACHMENTS in the API (services/disputes.ts). Accepting
 *  a sixth here would upload it and then have the thread refuse it. */
const MAX_DISPUTE_FILES = 5;
const IMAGE_TYPE_RE = /^image\/(png|jpe?g|webp|gif)$/i;
const VIDEO_TYPE_RE = /^video\/(mp4|webm)$/i;
/** Some drag sources hand over files with an empty MIME type; the extension is
 *  the only signal left. The server sniffs real bytes either way. */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm)$/i;

const DASHBOARD_URL = "https://firestarter.network/seller";

function hostedUrlOf(full: { text: string; structured: Record<string, unknown> | null } | null): string | null {
  const structured = full?.structured?.url;
  if (typeof structured === "string" && /^https:\/\//.test(structured)) return structured;
  return /https:\/\/\S+\/v1\/(?:img|vid)\/\S+/.exec(full?.text ?? "")?.[0] ?? null;
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
  // Dispute evidence: several photos, each posted to the thread as it lands.
  const disputeId = typeof req.dispute_id === "string" && req.dispute_id ? req.dispute_id : null;
  const disputeSide = req.dispute_side === "seller" ? "seller" : "buyer";
  // Possession evidence: ONE shot, showing the item and the code together.
  const verifyId = typeof req.verify_listing_id === "string" && req.verify_listing_id ? req.verify_listing_id : null;
  const title = verifyId
    ? (typeof req.verify_label === "string" && req.verify_label ? req.verify_label : `Verification photo`)
    : marketId
    ? (typeof req.market_name === "string" && req.market_name ? req.market_name : null)
    : disputeId
      ? (typeof req.dispute_label === "string" && req.dispute_label ? req.dispute_label : `Dispute ${disputeId}`)
      : typeof req.product_name === "string" && req.product_name
        ? req.product_name
        : typeof listing?.title === "string" ? listing.title : null;

  /** The full gallery this widget knows about: what the listing already had,
   *  plus everything uploaded here. image_urls replaces wholesale. */
  const gallery: string[] = (Array.isArray(req.existing_image_urls) ? req.existing_image_urls : [])
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  /** Same wholesale rule for video_urls — see existing_video_urls. */
  const videoGallery: string[] = (Array.isArray(req.existing_video_urls) ? req.existing_video_urls : [])
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  let activated = false;
  let busy = false;

  // Only the LISTING zone takes clips: an avatar is an image full stop, a
  // verification shot must be a photo of the item, and dispute evidence rides
  // an image-only endpoint.
  const imageOnly = !!(marketId || verifyId || disputeId);
  const acceptAttr = imageOnly
    ? "image/png,image/jpeg,image/webp,image/gif"
    : "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";
  root.innerHTML = `
    <div class="uploader">
      ${title ? `<div class="dz-head">${esc(title)}</div>` : ""}
      <div class="dropzone" id="dz" role="button" tabindex="0" aria-label="${verifyId ? "Upload the possession verification photo: drop a file here or press Enter to browse" : marketId ? "Upload a community market avatar: drop a file here or press Enter to browse" : disputeId ? "Upload dispute evidence photos: drop files here or press Enter to browse" : "Upload product photos or videos: drop files here or press Enter to browse"}">
        <div class="dz-big">${verifyId ? "Drop the verification photo here" : marketId ? "Drop the community avatar here" : disputeId ? "Drop evidence photos here" : `Drop product photo${listingId ? "s" : "(s)"} or video${listingId ? "s" : "(s)"} here`}</div>
        <small>${verifyId ? "the item and the handwritten code both visible — " : ""}or click to browse — ${imageOnly ? `JPEG, PNG, WebP or GIF, up to 6&nbsp;MB${marketId || verifyId ? "" : " each"}` : "photos up to 6&nbsp;MB · MP4/WebM clips up to 25&nbsp;MB"}${disputeId ? ` — up to ${MAX_DISPUTE_FILES}` : ""}</small>
      </div>
      <div class="dz-thumbs" id="dzt" hidden></div>
      <div class="dz-status" id="dzs" role="status" aria-live="polite"></div>
      <input id="dzf" type="file"${marketId || verifyId ? "" : " multiple"} accept="${acceptAttr}" style="display:none" />
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

  const addThumb = (file: File, kind: "image" | "video") => {
    try {
      thumbs.hidden = false;
      if (kind === "video") {
        // No <video> element: decoding a 25MB clip for a 56px tile costs more
        // than the tile says. A labeled chip carries the same information.
        thumbs.insertAdjacentHTML("beforeend", `<span class="dz-thumb vid" title="${esc(file.name)}">▶</span>`);
        return;
      }
      const url = URL.createObjectURL(file);
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
    const cap = marketId || verifyId ? 1 : disputeId ? MAX_DISPUTE_FILES : MAX_FILES_PER_BATCH;
    const batch = all.slice(0, cap);
    const skipped: string[] = all.length > cap
      ? [marketId
        ? `${all.length - 1} extra file(s) ignored — a market has one avatar`
        : verifyId
          ? `${all.length - 1} extra file(s) ignored — verification takes one photo`
        : disputeId
          ? `${all.length - cap} file(s) over the ${cap}-photo limit on a dispute message — drop them next`
          : `${all.length - cap} file(s) over the ${cap}-at-once limit — drop them next`]
      : [];
    // Each accepted file knows which rail it rides: photos through
    // firestarter_upload_image, clips through firestarter_upload_video. The
    // market zone stays image-only — an avatar is a picture.
    const accepted: { file: File; kind: "image" | "video" }[] = [];
    let plannedVideos = videoGallery.length;
    for (const f of batch) {
      const isImage = IMAGE_TYPE_RE.test(f.type) || (!f.type && IMAGE_EXT_RE.test(f.name));
      const isVideo = !imageOnly && (VIDEO_TYPE_RE.test(f.type) || (!f.type && VIDEO_EXT_RE.test(f.name)));
      if (!isImage && !isVideo) {
        skipped.push(`${f.name} — not a supported ${imageOnly ? "image" : "image or video"}`);
      } else if (isImage && f.size > MAX_FILE_BYTES) {
        skipped.push(`${f.name} — ${(f.size / 1024 / 1024).toFixed(1)} MB (photo limit 6 MB)`);
      } else if (isVideo && f.size > MAX_VIDEO_FILE_BYTES) {
        skipped.push(`${f.name} — ${(f.size / 1024 / 1024).toFixed(1)} MB (video limit 25 MB)`);
      } else if (isVideo && plannedVideos >= MAX_LISTING_VIDEOS) {
        // Refuse the 4th clip BEFORE its 25MB upload: the attach would throw
        // it away anyway (a listing carries at most 3 videos).
        skipped.push(`${f.name} — a listing carries at most ${MAX_LISTING_VIDEOS} videos`);
      } else {
        if (isVideo) plannedVideos++;
        accepted.push({ file: f, kind: isVideo ? "video" : "image" });
      }
    }
    if (accepted.length === 0) {
      showError(`Nothing to upload: ${skipped.join("; ")}`);
      return;
    }

    busy = true;
    zone.classList.add("busy");
    const uploadedImages: string[] = [];
    const uploadedVideos: string[] = [];
    const failed: string[] = [];
    /** The last successful upload call's reply. In verification mode this is
     *  the verdict (verified / flagged / held), which is the whole point of
     *  the drop — so it goes back to the model verbatim. */
    let lastReply = "";
    try {
      for (let i = 0; i < accepted.length; i++) {
        const { file, kind } = accepted[i];
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
        // In dispute mode the SAME call posts the photo to the thread: the
        // dispute tools move money (refund / accept / withdraw) and are
        // deliberately not reachable from a widget-originated call, so the
        // attach happens server-side inside firestarter_upload_image instead.
        // The note rides the first file only — the person's words belong in the
        // thread once, not once per photo. Clips ride their own rail; the
        // dispute/verify extras never apply to them (those modes are
        // image-only, so kind is always "image" there).
        const res = kind === "video"
          ? await host.callToolFull("firestarter_upload_video", { video_base64: dataUrl, filename: file.name })
          : await host.callToolFull("firestarter_upload_image", {
            image_base64: dataUrl,
            filename: file.name,
            ...(verifyId ? { verify_listing_id: verifyId } : {}),
            ...(disputeId
              ? {
                dispute_id: disputeId,
                dispute_side: disputeSide,
                ...(uploadedImages.length === 0 && typeof req.dispute_note === "string" && req.dispute_note
                  ? { dispute_note: req.dispute_note }
                  : {}),
              }
              : {}),
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
        if (kind === "video") { uploadedVideos.push(url); videoGallery.push(url); }
        else { uploadedImages.push(url); gallery.push(url); }
        lastReply = res.text ?? "";
        addThumb(file, kind);
      }

      const uploaded = [...uploadedImages, ...uploadedVideos];
      const problems = [...skipped, ...failed];
      if (uploaded.length === 0) {
        showError(`Upload failed: ${problems.join("; ").slice(0, 300)}`);
        tell(`upload FAILED: ${problems.join("; ").slice(0, 300)}`);
        return;
      }

      const countPhrase = [
        uploadedImages.length ? `${uploadedImages.length} photo${uploadedImages.length === 1 ? "" : "s"}` : "",
        uploadedVideos.length ? `${uploadedVideos.length} video${uploadedVideos.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(" and ");
      let summary = `${countPhrase} uploaded: ${uploaded.join(" ")}`;
      let headline = `✓ ${countPhrase} uploaded.`;

      if (verifyId) {
        // The upload already submitted itself; the tool's reply IS the verdict,
        // and it is the only thing worth showing — "uploaded" would bury it.
        const verdict = lastReply.trim();
        summary = `verification photo submitted for ${verifyId}: ${uploaded[0]}`;
        headline = "✓ Verification photo submitted.";
        if (problems.length) summary += ` Skipped: ${problems.join("; ").slice(0, 200)}`;
        status.innerHTML = `<span class="dz-ok">${esc(headline)}</span>` +
          `<br><small>The agent will report whether it verified.</small>` +
          (problems.length ? `<br><span class="dz-err">Skipped: ${esc(problems.join("; ").slice(0, 200))}</span>` : "");
        tell(summary + (verdict ? ` Outcome: ${verdict.slice(0, 400)}` : ""));
        return;
      }

      if (disputeId) {
        // Each upload already posted itself to the thread, so there is no
        // second call to make — and nothing to lose if the person drops more.
        const n = uploaded.length;
        summary = `${n} evidence photo${n === 1 ? "" : "s"} posted to dispute ${disputeId}: ${uploaded.join(" ")}`;
        headline = `✓ ${n} photo${n === 1 ? "" : "s"} posted to the dispute.`;
        if (problems.length) summary += ` Skipped: ${problems.join("; ").slice(0, 200)}`;
        status.innerHTML = `<span class="dz-ok">${esc(headline)}</span>` +
          (problems.length ? `<br><span class="dz-err">Skipped: ${esc(problems.join("; ").slice(0, 200))}</span>` : "") +
          `<br><small>The other party can see ${n === 1 ? "it" : "them"}. Drop more to add another message.</small>`;
        tell(summary);
        return;
      }

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
        // Attach first — this must survive an activation refusal. One PATCH
        // for both rails; each *_urls key is sent only when this batch touched
        // it, because each replaces its whole set (absent = untouched).
        status.textContent = "Attaching to the listing…";
        const attachArgs: Record<string, unknown> = { listing_id: listingId };
        if (uploadedImages.length) attachArgs.image_urls = [...gallery];
        if (uploadedVideos.length) attachArgs.video_urls = [...videoGallery];
        const attach = await host.callToolFull("firestarter_update_listing", attachArgs);
        if (!attach?.ok) {
          const why = (attach?.text ?? "the host blocked the widget's update call").slice(0, 200);
          summary += ` — but attaching to ${listingId} failed: ${why}. Attach them with firestarter_update_listing.`;
          headline = `✓ Uploaded, but attaching to the listing failed.`;
        } else {
          summary += ` — attached to ${listingId} (${gallery.length} photo${gallery.length === 1 ? "" : "s"}${videoGallery.length ? `, ${videoGallery.length} video${videoGallery.length === 1 ? "" : "s"}` : ""}${gallery.length ? `, cover: ${gallery[0]}` : ""}).`;
          headline = `✓ ${countPhrase} on the listing.`;
          // Activation is gated on a PHOTO, so only attempt it once the
          // gallery actually holds one — a video-only drop on a photoless
          // draft attaches fine but cannot go live yet, and saying so beats a
          // guaranteed refusal.
          if (req.activate && !activated && gallery.length > 0) {
            status.textContent = "Activating the listing…";
            const act = await host.callToolFull("firestarter_update_listing", {
              listing_id: listingId,
              status: "active",
            });
            if (act?.ok) {
              activated = true;
              summary += " Listing activated — it is live.";
              headline = `✓ ${countPhrase} attached — the listing is live.`;
            } else {
              const why = (act?.text ?? "activation call failed").slice(0, 200);
              summary += ` Attached, but activation was refused: ${why}`;
              headline = `✓ Attached — activation still blocked (see below).`;
            }
          } else if (req.activate && !activated && gallery.length === 0) {
            summary += " The listing still needs a PHOTO before it can go live — the video alone doesn't satisfy the photo requirement.";
            headline = `✓ ${countPhrase} attached — still needs a photo to go live.`;
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
