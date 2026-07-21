/**
 * Shared MCP tool definitions.
 * Used by both the stdio server (server.ts) and the HTTP route (route.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { marginCentsFor } from "../lib/margin.js";
import { isRelevantMatch } from "../lib/relevance.js";
import { previewOutputShape, toPreviewStructured, PREVIEW_REASON_LABELS } from "./schemas.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const API_REQUEST_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_API_TIMEOUT_MS || 12_000);
// Listing import fetches the source page server-side (10s cap) and may run an
// LLM extraction on top - it needs more than the default API budget.
const IMPORT_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_IMPORT_TIMEOUT_MS || 25_000);
// Evidence submission runs a vision soft-check server-side - same headroom.
const VERIFY_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_VERIFY_TIMEOUT_MS || 25_000);
// Keyless preview runs a live multi-source product search (Google Shopping +
// Shopify + catalog). A cold cache can take ~25-30s - well past the 12s default -
// so it needs its own budget, or every cold "what can you get me?" fails with a
// spurious "Firestarter API timed out". Warm-cache hits are sub-second.
const PREVIEW_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_PREVIEW_TIMEOUT_MS || 30_000);
const POLL_INTERVAL_MS = Number(process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS || 2_500);
// Public share pages (GET /l/:id) — humans get a product card, agents get
// machine-readable purchase instructions, chat apps unfurl a preview card.
const SHARE_LINK_BASE = process.env.SHARE_LINK_BASE || "https://firestarter.network/l";

// Community-market join pages (GET /m/:handle) — resolves either a random share
// code or a claimed vanity handle to the same market.
const MARKET_LINK_BASE = process.env.MARKET_LINK_BASE || "https://firestarter.network/m";

// Where a seller uploads a product photo and gets back a hosted image URL.
// MCP clients (e.g. Claude Desktop) that forward user-attached images as base64
// can use the firestarter_upload_image tool directly. The dashboard URL is kept
// as a fallback for clients that cannot encode the image into a tool argument.
const SELLER_DASHBOARD_URL = process.env.SELLER_DASHBOARD_URL || "https://firestarter.network/seller";

function listingShareUrl(listing: any): string | null {
  if (listing?.test_mode === true || listing?.environment === "test" || listing?.status !== "active") {
    return null;
  }
  if (typeof listing?.share_url === "string" && listing.share_url.trim()) {
    return listing.share_url.trim();
  }
  // Backward compatibility during rolling deploys where the API may not yet
  // return share_url. New API responses always include it (string or null).
  if (listing?.share_url === undefined && listing?.id) {
    return `${SHARE_LINK_BASE}/${listing.id}`;
  }
  return null;
}

function toErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Authentication/credential failures (401/403) must not be relayed as a generic
  // "shopping service" outage. The upstream agent (e.g. the WhatsApp/Cole bridge)
  // otherwise tells the buyer the search failed — and may fabricate that a search
  // ran. Nothing is searched on these: auth runs before any provider/execution
  // call, so the right action is to re-provision the key, not to retry.
  if (err instanceof ApiError) {
    const isAuthCode =
      err.code === "INVALID_KEY" || err.code === "INVALID_KEY_FORMAT" || err.code === "MISSING_AUTH";
    if (err.status === 401 || isAuthCode) {
      return "Authentication failed: the Firestarter API key is invalid or revoked. This is a credential/configuration problem, not a product-search outage — no search was performed. Do not retry; the integration's API key must be re-provisioned.";
    }
  }
  if (msg.includes("timed out") || msg.includes("aborted")) {
    return "Firestarter API timed out. Please retry in a few seconds.";
  }
  return msg;
}

/** Strip backslashes LLMs sometimes inject when markdown-escaping underscores/hyphens in IDs. */
function cleanListingId(id: string): string {
  return id.replace(/\\/g, "");
}

/**
 * Keep external links readable in chat: suppress noisy query strings (notably
 * Google Shopping tracking params) while preserving a clickable URL.
 */
function tidyProductUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/google\./i.test(u.hostname) && /\/shopping\//i.test(u.pathname)) {
      return `${u.origin}${u.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Non-2xx API responses carry structured bodies (code + extra data, e.g. the
 * possession-verification payload on 409s). Keep them on the thrown error so
 * tool catch blocks can render specifics instead of a flattened string.
 */
class ApiError extends Error {
  status: number;
  code: string | null;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.code = typeof body?.code === "string" ? body.code : null;
    this.body = body;
  }
}

export function makeApiRequest(apiKey: string, apiBase: string) {
  return async function apiRequest(method: string, path: string, body?: unknown, timeoutMs: number = API_REQUEST_TIMEOUT_MS) {
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Firestarter-Source": "mcp",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || `API request failed: ${res.status}`, res.status, data);
    }
    return data;
  };
}

/**
 * Render the possession-verification ask (409 VERIFICATION_REQUIRED) as chat
 * instructions the agent can relay verbatim. Returns null for other errors.
 */
function verificationAskText(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "VERIFICATION_REQUIRED") return null;
  const v = err.body?.verification;
  if (!v?.code) return null;
  const why =
    v.reason === "source_conflict"
      ? "its source URL was already imported by another seller"
      : v.reason === "luxury_category"
        ? "it is a luxury-category item"
        : v.reason === "buyer_invite"
          ? "a buyer requested an escrow-protected purchase of this exact item, so possession must be proven before it goes live"
          : "it is a high-value item";
  return (
    `**Possession verification needed before this listing can go live** (${why}).\n\n` +
    `Verification code: **${v.code}**\n\n` +
    `Ask the seller to:\n` +
    `1. Write ${v.code} by hand on a piece of paper\n` +
    `2. Photograph the paper next to the item - both clearly visible in one shot\n` +
    `3. Send that photo here in chat\n\n` +
    `Then submit it with firestarter_verify (listing_id + the photo URL). A match auto-approves in seconds - no human review on the happy path.`
  );
}

async function pollExecution(apiRequest: ReturnType<typeof makeApiRequest>, executionId: string, timeoutMs: number = 60_000): Promise<any> {
  const start = Date.now();
  const TERMINAL_STATUSES = ["awaiting_approval", "awaiting_payment_method", "quoted", "completed", "failed", "cancelled", "paid", "shipping", "delivered"];

  while (Date.now() - start < timeoutMs) {
    // Use the lightweight poll endpoint (1 query) instead of the full
    // execution resource (3 queries + JOIN) during the wait loop.
    try {
      const poll = await apiRequest("GET", `/v1/executions/${executionId}/poll`);
      if (poll.has_options || TERMINAL_STATUSES.includes(poll.status)) {
        break;
      }
    } catch {
      // Fallback: if /poll 404s (old API version), break and fetch full.
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Single full fetch once the execution is ready.
  return apiRequest("GET", `/v1/executions/${executionId}`);
}

// MCP content blocks: text + image (base64) for inline rendering in any client.
//
// SIZE BUDGET — an MCP client rejects the WHOLE tool result over 1MB ("Tool
// result is too large"), so every limit here is derived from that ceiling
// rather than from what a single image might plausibly weigh. Two facts drive
// the math: base64 inflates bytes by 4/3, and a response embeds several images
// alongside its text. The old per-image cap (5MB) sat ABOVE the whole-response
// cap — one ~768KB product photo blew the limit alone, and three maxed-out
// images produced ~20MB of base64 — which broke firestarter_preview /
// firestarter_execute for any search returning external (non-hosted) photos.
export const MCP_RESULT_LIMIT_BYTES = 1024 * 1024; // client-side hard cap on a tool result
// Ceiling on the base64 of ALL images in one response. The rest of the 1MB is
// left to text, structured content, and the JSON envelope — options lists with
// shipping/eligibility prose are not small.
export const MAX_RESPONSE_IMAGE_BASE64_BYTES = Math.floor(MCP_RESULT_LIMIT_BYTES * 0.6);
// Per-image raw ceiling. An image ABOVE this is downscaled rather than dropped
// — a 900KB Google Shopping photo should still reach the buyer, just smaller.
const MAX_IMAGE_BYTES = 256 * 1024;
// Refuse to even download past this — downscaling can shrink a big image, but
// nothing justifies pulling a 20MB TIFF over the wire to make a 320px thumb.
const MAX_IMAGE_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 8_000; // 8s per image — Firestarter-hosted blobs need headroom
const MAX_EMBED_IMAGES = 3; // cap inline images per response

/** Shrink image bytes to a ~320px JPEG. Dynamically imports image-store to keep
 *  its DB pool and Jimp out of the stdio MCP path (same reason readBlobDirect
 *  does), and returns null on any failure so the caller keeps the original. */
async function shrinkImage(bytes: Buffer): Promise<Buffer | null> {
  try {
    const store = await import("../services/image-store.js");
    return await store.downscaleToJpegThumb(bytes);
  } catch {
    return null;
  }
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; annotations?: { audience?: ("user" | "assistant")[]; priority?: number } };

// MIME types an MCP image block may carry. Anything else (svg, avif,
// octet-stream, or an HTML error page returned with a 200) makes the model
// reject the WHOLE tool response with "unsupported image format" — which is
// what broke firestarter_approve / firestarter_status. Keep this in sync with
// what the consuming models accept (Claude/GPT image inputs).
const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Sniff a supported image MIME from magic bytes when the content-type header
 *  is missing or untrustworthy. Returns null if the bytes aren't a supported
 *  image (so we skip it rather than emit a block the model can't render). */
function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  // WEBP: "RIFF"...."WEBP"
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

/** Extract the hex blob id from a Firestarter-hosted image URL (/v1/img/<id>).
 *  Returns null for external URLs. */
function extractBlobId(url: string): string | null {
  const m = url.match(/\/v1\/img\/([a-f0-9]{32})(?:\?|$)/i);
  return m ? m[1] : null;
}

/** Read a self-hosted image directly from the database — avoids the HTTP
 *  roundtrip that fails when the MCP server can't reach its own public URL
 *  (DNS, loopback, firewall). Prefers the downscaled thumbnail (~320px JPEG,
 *  typically 10x smaller than the full image) so the base64 payload embedded in
 *  the tool result stays small — a full-res product PNG can be 200KB+, which is
 *  ~270KB of base64 PER option and can exceed a client's inline-render budget.
 *  Falls back to the full blob (undecodable source), then null (HTTP retry). */
async function readBlobDirect(id: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const store = await import("../services/image-store.js");
    // Thumbnail first — small, fast, and always a supported JPEG.
    try {
      const thumb = await store.getOrCreateThumb(id);
      if (thumb?.bytes) {
        const tmime = (thumb.contentType || "").split(";")[0].trim().toLowerCase();
        const mimeType = SUPPORTED_IMAGE_MIME.has(tmime) ? tmime : sniffImageMime(new Uint8Array(thumb.bytes));
        if (mimeType) return { data: Buffer.from(thumb.bytes).toString("base64"), mimeType };
      }
    } catch { /* thumb unavailable (e.g. Jimp can't decode) — fall back to full */ }

    const { pool } = await import("../db/pool.js");
    const r = await pool.query(
      "SELECT content_type, bytes FROM listing_image_blobs WHERE id = $1",
      [id],
    );
    const row = r.rows[0];
    if (!row?.bytes) return null;
    const mime = (row.content_type || "").split(";")[0].trim().toLowerCase();
    const mimeType = SUPPORTED_IMAGE_MIME.has(mime) ? mime : sniffImageMime(new Uint8Array(row.bytes));
    if (!mimeType) return null;
    return { data: Buffer.from(row.bytes).toString("base64"), mimeType };
  } catch {
    return null;
  }
}

/** Fetch an image URL and return base64 for MCP image blocks. Only supported
 *  formats are returned; anything else yields null so the caller silently skips
 *  the image instead of poisoning the tool response. */
export async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  const blobId = extractBlobId(url);
  if (blobId) {
    const direct = await readBlobDirect(blobId);
    if (direct) return direct;
    console.error(`[firestarter-mcp] direct blob read failed for ${blobId}, falling back to HTTP`);
  }
  // For a Firestarter-hosted blob, fetch the lightweight ?thumb=1 variant over
  // HTTP too (the endpoint downscales server-side) so the embedded base64 stays
  // small even on the HTTP path (e.g. a stdio MCP with no DB access).
  const fetchUrl = blobId && !/[?&]thumb=/i.test(url)
    ? `${url}${url.includes("?") ? "&" : "?"}thumb=1`
    : url;
  try {
    const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`[firestarter-mcp] image fetch failed: ${res.status} for ${url}`);
      return null;
    }
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > MAX_IMAGE_DOWNLOAD_BYTES) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) return null;
    const bytes = new Uint8Array(buf);
    const headerMime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const mimeType = SUPPORTED_IMAGE_MIME.has(headerMime) ? headerMime : sniffImageMime(bytes);
    if (!mimeType) {
      console.error(`[firestarter-mcp] unsupported image MIME: ${headerMime} for ${url}`);
      return null;
    }
    // External images never hit the ?thumb= path above, so they arrive full-res
    // and must be shrunk here or they blow the 1MB tool-result cap. Downscale
    // is best-effort: if the source won't decode, fall through to the raw bytes
    // and let the caller's response budget be the backstop.
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      const thumb = await shrinkImage(Buffer.from(buf));
      if (thumb) return { data: thumb.toString("base64"), mimeType: "image/jpeg" };
      console.error(`[firestarter-mcp] oversized image could not be downscaled: ${buf.byteLength}B for ${url}`);
    }
    return { data: Buffer.from(buf).toString("base64"), mimeType };
  } catch (err) {
    console.error(`[firestarter-mcp] image fetch error for ${url}:`, (err as Error).message);
    return null;
  }
}

/** Fetch up to MAX_EMBED_IMAGES of the given URLs and return MCP image blocks so
 *  any connected client (Claude/GPT/Cursor/Copilot) renders the product photos
 *  inline. Dedupes, skips non-http URLs and unsupported formats, and silently
 *  drops any fetch that fails so a bad image never poisons the whole tool
 *  response. The bare URLs stay in the text/structured payload for chat clients
 *  that unfurl links instead. */
export async function inlineImageBlocks(urls: Array<string | null | undefined>): Promise<Array<{ type: "image"; data: string; mimeType: string; annotations: { audience: ("user" | "assistant")[]; priority: number } }>> {
  const picked = [...new Set(urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)))].slice(0, MAX_EMBED_IMAGES);
  if (picked.length === 0) return [];
  const fetched = await Promise.all(picked.map(fetchImageAsBase64));
  const blocks: Array<{ type: "image"; data: string; mimeType: string; annotations: { audience: ("user" | "assistant")[]; priority: number } }> = [];
  // Hard backstop on the 1MB tool-result cap. Downscaling upstream is
  // best-effort (an undecodable source passes through at full size), so this
  // running total is the only thing that GUARANTEES the response fits. Drop
  // photos rather than overshoot: a missing image degrades the answer, an
  // oversized one destroys it — the client rejects the entire response.
  let budget = MAX_RESPONSE_IMAGE_BASE64_BYTES;
  for (const img of fetched) {
    if (!img) continue;
    if (img.data.length > budget) {
      console.error(`[firestarter-mcp] image dropped: ${img.data.length}B base64 exceeds remaining ${budget}B of the response image budget`);
      continue;
    }
    budget -= img.data.length;
    blocks.push({ type: "image", data: img.data, mimeType: img.mimeType, annotations: { audience: ["user", "assistant"] as const as ("user" | "assistant")[], priority: 0.8 } });
  }
  return blocks;
}

/**
 * Render the buyer-facing delivery-options menu for one purchasable option.
 *
 * The rates already exist — the quote step rate-shops each purchasable option and
 * stores the full method list on `execution_options.shipping_options` (the same
 * array `firestarter_approve`'s `shipping_option_index` selects into). Until now
 * that list was never shown, so a buyer silently got the cheapest rate and was
 * never offered the speed/carrier trade-off. This surfaces it as a numbered menu
 * whose numbers ARE the `shipping_option_index` to pass to approve.
 *
 * Non-blocking by design: approving without a choice still uses the cheapest
 * rate, so a buyer who doesn't care about speed is never stalled. Rendered only
 * for purchasable options carrying a real choice (>= 2 methods).
 */
export function renderDeliveryOptions(opt: any, dm: any): string[] {
  if (opt.purchasable === false) return [];
  const methods: any[] = Array.isArray(opt.shipping_options) ? opt.shipping_options : [];
  if (methods.length === 0) return [];

  const subtotalCents = Math.round(Number(opt.subtotal ?? 0) * 100);
  const taxCents = Math.round(Number(opt.tax ?? 0) * 100);
  const marginBps = dm && typeof dm.margin_bps === "number" ? dm.margin_bps : 0;
  const capCents = dm && typeof dm.per_transaction_cap_cents === "number" ? dm.per_transaction_cap_cents : undefined;

  // Describe one delivery method: its service label + price · eta · all-in (incl.
  // the app margin, computed the exact way the charge path does so shown == paid).
  const describe = (m: any): { label: string; parts: string[]; tags: string[] } => {
    const priceCents = Number(m.price_cents);
    const price = !Number.isFinite(priceCents) ? "price at checkout" : priceCents === 0 ? "free" : `$${(priceCents / 100).toFixed(2)}`;
    const eta = typeof m.delivery_range === "string" && m.delivery_range.trim()
      ? m.delivery_range.trim()
      : Number.isFinite(m.delivery_days)
        ? `~${m.delivery_days} day${m.delivery_days === 1 ? "" : "s"}`
        : null;
    const label = (typeof m.label === "string" && m.label.trim())
      || [m.carrier, m.service].filter(Boolean).join(" ")
      || m.method_type
      || "Shipping";
    let allIn: string | null = null;
    if (Number.isFinite(priceCents)) {
      const baseCents = subtotalCents + priceCents + taxCents;
      const withMargin = marginBps > 0 ? baseCents + marginCentsFor(baseCents, marginBps, capCents) : baseCents;
      allIn = `$${(withMargin / 100).toFixed(2)} all-in`;
    }
    const tags: string[] = [];
    if (Array.isArray(m.badges)) tags.push(...m.badges.filter((b: unknown) => typeof b === "string" && b));
    if (m.is_estimated) tags.push("estimate");
    const parts = [price];
    if (eta) parts.push(eta);
    if (allIn) parts.push(allIn);
    return { label, parts, tags };
  };

  // Single delivery method: still NAME the service + speed (there is no choice to
  // make, so no [index]) — so shipping is never invisible on a one-option order.
  if (methods.length === 1) {
    const d = describe(methods[0]);
    return [`  Delivery: ${d.label} · ${d.parts.join(" · ")}${d.tags.length ? ` — ${d.tags.join(", ")}` : ""}`];
  }

  // Two or more services: the numbered menu whose indices ARE shipping_option_index.
  const lines: string[] = ["  Delivery options — pick a speed, or approve to use the cheapest:"];
  methods.forEach((m: any, i: number) => {
    const d = describe(m);
    lines.push(`   [${i}] ${d.label} · ${d.parts.join(" · ")}${d.tags.length ? ` — ${d.tags.join(", ")}` : ""}`);
  });
  lines.push("  To choose one, approve with shipping_option_index set to its [number].");
  return lines;
}

/**
 * Restate the chosen delivery SERVICE + the shipping-inclusive all-in for a
 * just-approved / pay-ready order, so the buyer always sees exactly what they'll
 * be charged BEFORE the payment/card step — the fix for "no shipping info before
 * payment". baseCents is the frozen item all-in (subtotal+shipping+tax); dm adds
 * the per-API-key app margin the same way the option display does, so the number
 * shown equals the number charged. Returns [] when nothing is known.
 */
export function renderPayReadySummary(opts: { baseCents: number | null; shipping: any; dm: any }): string[] {
  const lines: string[] = [];
  const s = opts.shipping;
  if (s && typeof s === "object") {
    const label =
      (typeof s.label === "string" && s.label.trim()) ||
      [s.carrier, s.service].filter(Boolean).join(" ") ||
      s.method_type ||
      "Shipping";
    const priceCents = Number(s.price_cents);
    const price = !Number.isFinite(priceCents) ? null : priceCents === 0 ? "free" : `$${(priceCents / 100).toFixed(2)}`;
    const days = Number(s.delivery_days);
    const eta =
      (typeof s.delivery_range === "string" && s.delivery_range.trim()) ||
      (Number.isFinite(days) ? `~${days} day${days === 1 ? "" : "s"}` : null);
    lines.push(`Shipping: ${[label, price, eta].filter(Boolean).join(" · ")}`);
  }
  const base = opts.baseCents;
  if (base != null && Number.isFinite(base)) {
    const dm = opts.dm;
    const marginBps = dm && typeof dm.margin_bps === "number" ? dm.margin_bps : 0;
    const capCents = dm && typeof dm.per_transaction_cap_cents === "number" ? dm.per_transaction_cap_cents : undefined;
    const allIn = marginBps > 0 ? base + marginCentsFor(base, marginBps, capCents) : base;
    lines.push(`Total: $${(allIn / 100).toFixed(2)} all-in — this is what will be charged.`);
  }
  return lines;
}

async function formatExecution(exec: any): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  const lines: string[] = [];

  const hasOptions = Array.isArray(exec.options) && exec.options.length > 0;
  // #256: the buyer-facing confirmation (options presented for approval) must
  // NOT lead with internal IDs. Drop the "Execution exec_…/Status/Request"
  // header in that one state so the product leads; every other state (status
  // checks, post-purchase tracking) keeps it as the track/dispute reference
  // the spec explicitly allows.
  const isApprovalConfirmation = exec.status === "awaiting_approval" && hasOptions;
  const displayStatus = exec.order_status || exec.display_status || exec.status;

  if (!isApprovalConfirmation) {
    lines.push(`**Execution ${exec.id}** — Status: ${displayStatus}`);
    lines.push(`Request: ${exec.request_text}`);

    if (exec.order_status && exec.status !== exec.order_status) {
      lines.push(`Workflow state: ${exec.status}`);
    }

    if (exec.current_step) {
      lines.push(`Current step: ${exec.current_step}`);
    }
  }

  // A dispute freezes escrow and changes what "shipping"/"delivered" actually
  // means for this order, so surface it prominently on every status/tracking
  // read. `active_dispute` is populated by GET /v1/executions/:id. Without this
  // banner the order looked like a normal in-flight purchase and a buyer asking
  // "is there a dispute?" was silently answered "no". An awaiting_approval order
  // can't be disputed, so this never collides with the approval-confirmation view.
  const activeDispute = exec.active_dispute;
  if (activeDispute) {
    if (lines.length > 0) lines.push("");
    lines.push(`⚠️ **Dispute open** (${activeDispute.id}) — status: ${String(activeDispute.status || "open").replace(/_/g, " ")}`);
    if (activeDispute.reason) {
      const typeLabel = activeDispute.dispute_type ? ` (${String(activeDispute.dispute_type).replace(/_/g, " ")})` : "";
      lines.push(`Reason: ${activeDispute.reason}${typeLabel}`);
    }
    const pendingOffer = activeDispute.pending_offer;
    if (pendingOffer && pendingOffer.offered_by === "seller") {
      lines.push(`The seller proposed a split: **${pendingOffer.buyer_pct}% refund to you / ${pendingOffer.seller_pct}% to the seller** — you can accept, reject, or counter it.`);
    }
    lines.push("Use `firestarter_disputes` (with this order's ID) to see the full thread and respond.");
  }

  // Order approved but no payment method on file — relay the no-login setup
  // link so the buyer can finish (the order resumes automatically once a card
  // is added). Without this the link never reached chat buyers and orders
  // parked on awaiting_payment_method forever.
  //
  // #272: render the URL bare (not as a markdown link) so it doesn't break
  // across lines in Slack/WhatsApp/Telegram. Early-return with a concise
  // message — the full options/steps dump is redundant post-approval.
  if (exec.status === "awaiting_payment_method") {
    // Restate what ships and the exact all-in BEFORE asking for a card, so the
    // buyer is never asked to pay with the shipping/total out of view.
    const payReady = renderPayReadySummary({
      baseCents: (exec.selected_option?.total_cents ?? null) as number | null,
      shipping: exec.selected_shipping ?? (exec.selected_option?.shipping_method ?? null),
      dm: exec.developer_margin,
    });
    if (exec.setup_url) {
      lines.push("");
      lines.push("Order approved.");
      if (payReady.length) lines.push(...payReady);
      lines.push("");
      lines.push("**Last step — add a payment method to place the order** (no login needed):");
      lines.push(exec.setup_url);
      lines.push("");
      lines.push("The order completes automatically once a card is added — you'll be charged the all-in above.");
    } else {
      lines.push("");
      lines.push("Order approved.");
      if (payReady.length) lines.push(...payReady);
      lines.push("");
      lines.push("**Last step:** this order is waiting on a payment method. Ask the buyer to add a card from their dashboard billing settings; the order resumes automatically once added.");
    }
    blocks.push({ type: "text", text: lines.join("\n") });
    return blocks;
  }

  if (hasOptions) {
    if (lines.length > 0) lines.push("");
    lines.push("**Options found:**");
    // D3.5: if this org charges a developer margin, disclose it WITH the
    // prices the human is choosing among - so their approval is on the true
    // total, not a number that grows at payment.
    const dm = exec.developer_margin;
    if (dm && typeof dm.margin_bps === "number" && dm.margin_bps > 0) {
      const cap = typeof dm.per_transaction_cap_cents === "number" ? ` (capped at $${(dm.per_transaction_cap_cents / 100).toFixed(0)})` : "";
      lines.push(
        `> Heads-up: this app adds a ${(dm.margin_bps / 100).toFixed(2)}% integration margin${cap} on top of the prices below. It is applied at payment and included in the total you approve - state it to the buyer before they confirm.`
      );
    }
    blocks.push({ type: "text", text: lines.join("\n") });
    lines.length = 0;

    for (let i = 0; i < exec.options.length; i++) {
      const opt = exec.options[i];
      // #107: browse-only options can't be checked out — label them so no agent
      // walks a buyer into approving one (the API rejects it anyway). But say
      // WHY honestly: a Firestarter store that hasn't enabled checkout yet is
      // NOT an "external" listing (it's in our catalog, with an owner we can
      // activate), and the buyer's own listing is neither. Only genuine web
      // results (SerpAPI/eBay/Etsy/...) are "external".
      const browseOnly = opt.purchasable === false;
      const isOwnListing = opt.own_listing === true;
      // metadata.source is set by the find step: "firestarter_seller" for any
      // catalog listing (including seeded stores not yet claimed / without
      // Stripe), vs "google_shopping"/"serpapi"/"shopify" for off-platform web
      // results. A browse-only firestarter_seller = a store that simply hasn't
      // turned on instant checkout yet.
      const unconnectedStore = browseOnly && !isOwnListing && opt.metadata?.source === "firestarter_seller";
      const externalResult = browseOnly && !isOwnListing && !unconnectedStore;
      const optLines: string[] = [];
      // #256: lead with the product name AND condition (new/used/refurbished —
      // often the deciding factor), then what's included/missing, from metadata.
      const condition = typeof opt.metadata?.condition === "string" && opt.metadata.condition.trim() ? ` (${opt.metadata.condition.trim()})` : "";
      const browseLabel = isOwnListing
        ? " - your listing"
        : unconnectedStore
          ? " - Firestarter store (checkout not enabled yet)"
          : externalResult
            ? " - browse-only (external)"
            : "";
      optLines.push(`\n**${i + 1}. ${opt.product_title}${condition}** from ${opt.supplier || opt.store || "Unknown"}${browseLabel}`);
      const included = typeof opt.metadata?.included === "string" ? opt.metadata.included.trim() : "";
      const missing = typeof opt.metadata?.missing === "string" ? opt.metadata.missing.trim() : "";
      if (included) optLines.push(`  Includes: ${included}`);
      if (missing) optLines.push(`  Not included: ${missing}`);
      // Surface the product image URL so the agent can relay it and chat
      // clients auto-unfurl a preview. Bare URL on its own line — Slack,
      // WhatsApp, and Telegram all auto-preview hosted image URLs.
      const imageUrl = opt.image_url || opt.metadata?.image;
      if (imageUrl && /^https?:\/\//i.test(String(imageUrl))) {
        optLines.push(`  ${imageUrl}`);
      }
      // #256: lead with the bold all-in total, then the line-item split, and
      // ALWAYS state the tax status — a silent omission reads as a checkout
      // surprise. The item+shipping split also stops an agent flagging the
      // line-item total as a price discrepancy (debug 2026-06-12: "$55.80" with
      // no context read as a mismatch against a $45.81 listing).
      if (opt.total != null) {
        const costParts: string[] = [];
        if (opt.subtotal != null) costParts.push(`$${opt.subtotal} item${Number(opt.quantity) > 1 ? `s x${opt.quantity}` : ""}`);
        // Always state shipping — a silently-dropped shipping line makes shipping
        // look unresolved. >0 shows the amount, 0 shows "free shipping", and a
        // genuinely-unknown shipping (browse-only / not rated) shows "shipping
        // calculated at checkout" instead of nothing (mirrors firestarter_preview).
        if (opt.shipping != null && Number(opt.shipping) > 0) costParts.push(`$${opt.shipping} shipping`);
        else if (opt.shipping != null && Number(opt.shipping) === 0) costParts.push("free shipping");
        else if (opt.shipping == null && (opt.metadata as any)?.shipping_known === false) costParts.push("shipping calculated at checkout");
        const taxPhrase = opt.tax != null && Number(opt.tax) > 0 ? `$${opt.tax} tax` : "no tax";
        const breakdown = costParts.length > 0 ? `${costParts.join(" + ")}, ${taxPhrase}` : taxPhrase;
        optLines.push(`  **$${opt.total} all-in** - ${breakdown}`);
      }
      // #256: tell the buyer when it arrives (delivery_estimate is a DATE).
      if (opt.delivery_estimate) {
        const d = new Date(opt.delivery_estimate);
        if (!isNaN(d.getTime())) {
          const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
          optLines.push(days > 0 ? `  Arrives in ~${days} day${days === 1 ? "" : "s"} (${opt.delivery_estimate})` : `  Delivery estimate: ${opt.delivery_estimate}`);
        }
      }
      // D3.5: a purchasable option's TRUE total includes the app margin (added
      // at payment, double-capped). Show it so "confirm" approves the real
      // number, not one that grows at payment.
      if (!browseOnly && dm && dm.margin_bps > 0 && opt.total != null) {
        const itemCents = Math.round(Number(opt.total) * 100);
        // Same pure function the charge path uses - shown == charged, always.
        const capCents = typeof dm.per_transaction_cap_cents === "number" ? dm.per_transaction_cap_cents : undefined;
        const marginCents = marginCentsFor(itemCents, dm.margin_bps, capCents);
        if (marginCents > 0) {
          optLines.push(`  Total with app margin: $${((itemCents + marginCents) / 100).toFixed(2)} (+$${(marginCents / 100).toFixed(2)})`);
        }
      }
      // Delivery-options menu: show the real speed/carrier choices the buyer can
      // pick between (the numbers ARE the shipping_option_index for approve), so
      // shipping stops being an invisible auto-pick. Non-blocking — approving
      // without a choice still uses the cheapest rate.
      if (!browseOnly) {
        for (const shipLine of renderDeliveryOptions(opt, dm)) optLines.push(shipLine);
      }
      // #256: surface the exact link the API returned. For a Firestarter
      // listing product_url is ALREADY the /l/<id> share link — use it verbatim
      // and never reconstruct one from an id (stripping "lst_" yields a dead
      // link). Keep it a BARE url, not a markdown link, so it stays tappable and
      // unfurls in Slack/WhatsApp/Telegram (#272).
      if (opt.product_url) {
        const linkLabel = isOwnListing
          ? "View your listing"
          : unconnectedStore
            ? "View on Firestarter"
            : externalResult
              ? `View on ${opt.supplier || opt.store || "site"}`
              : "View listing";
        optLines.push(`  ${linkLabel}: ${tidyProductUrl(opt.product_url)}`);
      }
      if (isOwnListing) {
        optLines.push(`  This is your own listing - shown so you can see how it appears to buyers. It is not offered for purchase.`);
      } else if (unconnectedStore) {
        optLines.push(`  This is a Firestarter store that hasn't enabled checkout yet, so it can't be purchased here yet. Share the link so the buyer can view it, or use \`firestarter_message\` to refine toward checkout-ready listings. Do not approve this option.`);
      } else if (externalResult) {
        optLines.push(`  External marketplace result - Firestarter cannot purchase it. Do not approve this option; share the link so the buyer can purchase directly.`);
      }
      if (opt.agent_reasoning) optLines.push(`  ${opt.agent_reasoning}`);
      blocks.push({ type: "text", text: optLines.join("\n") });
    }

    // Fetch product images for the top options and include as MCP image blocks
    // so any connected client (Claude Desktop, Cursor, etc.) renders them inline.
    // Bounded and parallel (<= MAX_EMBED_IMAGES, IMAGE_FETCH_TIMEOUT_MS each), so
    // it is cheap enough to run on EVERY path — including the quote step, where
    // the buyer is deciding and the picture matters most. (It used to be skipped
    // there to shave latency off the already-slow 45s poll; showing the product
    // at the decision moment is worth the ~one bounded parallel fetch.)
    const imageUrls = exec.options
      .slice(0, MAX_EMBED_IMAGES)
      .map((opt: any) => opt.image_url || opt.metadata?.image || null)
      .filter((url: string | null): url is string => !!url && /^https?:\/\//i.test(url));

    if (imageUrls.length > 0) {
      const images = await Promise.all(imageUrls.map(fetchImageAsBase64));
      for (const img of images) {
        if (img) blocks.push({ type: "image", data: img.data, mimeType: img.mimeType, annotations: { audience: ["user", "assistant"] as ("user" | "assistant")[], priority: 0.8 } });
      }
    }
  } else {
    blocks.push({ type: "text", text: lines.join("\n") });
    lines.length = 0;
  }

  if (exec.steps && exec.steps.length > 0) {
    lines.push("");
    lines.push("**Steps:**");
    for (const step of exec.steps) {
      const icon = step.status === "completed" ? "✓" : step.status === "failed" ? "✗" : "⧖";
      lines.push(`${icon} ${step.step}: ${step.agent_reasoning || step.status}`);
      if (step.error?.message) {
        lines.push(`  Error: ${step.error.message}`);
      }
    }
  }

  if (lines.length > 0) {
    blocks.push({ type: "text", text: lines.join("\n") });
  }

  console.error(`[firestarter-mcp] formatExecution returning ${blocks.length} text blocks`);

  return blocks;
}

// ─── Register all tools ─────────────────────────────────────────────────────

/**
 * Register a tool, preferring the modern `registerTool` API so the tool can
 * advertise a typed `outputSchema` and return `structuredContent`. Falls back to
 * the classic `tool()` signature for minimal server doubles (e.g. the unit-test
 * fakes that only implement `tool`); the fallback omits the outputSchema, which
 * is fine for those content-only tests.
 */
function registerToolCompat(server: McpServer, name: string, config: any, handler: any): void {
  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, config, handler);
  } else {
    s.tool(name, config.description, config.inputSchema, handler);
  }
}

export function registerTools(server: McpServer, apiKey: string, apiBase: string) {
  const apiRequest = makeApiRequest(apiKey, apiBase);

  // Tool: firestarter_execute
  server.tool(
    "firestarter_execute",
    "Start a purchase. Step 1 of the buy flow: it finds products matching a natural-language request (or pins to an exact listing), verifies the seller, computes real pricing + shipping, and returns ranked OPTIONS that are AWAITING APPROVAL — it does NOT pay yet. Full flow: firestarter_execute (find/price) → review options with the buyer → firestarter_approve (confirm + pay) → firestarter_receipt (proof of payment) and firestarter_track_order (delivery). Each purchasable option lists real DELIVERY OPTIONS (Standard / Express / Same-Day with prices and ETAs) — present these to the buyer so they can pick a speed, don't silently assume the cheapest; the buyer chooses at approval via shipping_option_index (use firestarter_shipping_options to re-fetch or preview a speed's total). You do NOT need a budget, an address, or a payment method to call this — a card is only requested at the very end, after the buyer approves; browsing, quoting, and comparing shipping never require one. If the buyer has a saved shipping address, it is used automatically — you do NOT need to ask for their street, zip, or phone; the response's `default_delivery` shows a masked view of it so you can just confirm (\"ship to your saved address?\"). Only collect a new address if they have none saved or want it shipped somewhere else, and prefer passing a saved `address_id` (from firestarter_addresses) over re-typing it. ALWAYS pass the buyer's `location` (country, and city if known) when you know it — results are localized to their country so a buyer in Kenya sees locally-deliverable options first instead of an empty or US-only list. When you already have an exact listing id (lst_..., e.g. from a firestarter.network/l/<id> share link or firestarter_catalog_search), pass listing_id to skip search and pin to that exact product. Results may include browse-only options (external or checkout-not-enabled) that can't be approved — share their links instead. Set auto_pay only when the buyer has explicitly pre-authorized buying without a confirmation step.",
    {
      request: z.string().describe("Natural language description of what to buy (e.g. 'specialty coffee beans under $30'). This is the only required field — call with just this and refine later."),
      listing_id: z.string().optional().describe("Exact Firestarter listing id (lst_...) to buy — from a listing or a share link (firestarter.network/l/<id>). Pins the purchase to that listing, skipping product search. Always pass it when you have one."),
      budget_max: z.number().optional().describe("Maximum budget in USD. Optional — omit to see all options regardless of price."),
      // Permissive, forever-stable boundary: accept a string OR any object shape
      // and NEVER reject for shape (an older/stale cached client that omits
      // street1, or sends a JSON string, must still reach the server). Strictness
      // lives server-side (the three-state normalizer + isRateable at pay time).
      delivery_address: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("Optional shipping address — pass EITHER a single-line string (e.g. \"123 Main St, Austin, TX 78701, US\") OR an object { name?, street1, street2?, city, state?, zip?, country? } (country is an ISO code, e.g. US/TH; defaults to US). The buyer's saved default address is used automatically at approval, so only pass one here if they have none saved or want it shipped elsewhere; prefer a saved address_id. A COMPLETE address (ZIP + state for US/CA/AU) lets execute quote a REAL carrier rate up front instead of the flat placeholder; a partial or odd-shaped address is accepted anyway (never rejected for shape) and the response's `needs_more` names exactly what to collect."),
      address_id: z.string().optional().describe("A saved address id (addr_...) to ship to, from firestarter_addresses. Optional — omit to use the buyer's default saved address. Localizes search + shipping to that destination."),
      location: z
        .object({
          country: z.string().optional().describe("Buyer's country — full name or ISO code (e.g. 'Kenya' or 'KE'). Drives localized, deliverable-first results."),
          city: z.string().optional().describe("Buyer's city (e.g. 'Kitale'), when known — sharpens local ranking and delivery estimates."),
        })
        .optional()
        .describe("Where the buyer is. Pass this whenever you know it (from the conversation, profile, or a prior message) even without a full delivery address — it makes search location-aware so local marketplaces are shown first."),
      priority: z.enum(["cost", "speed", "quality"]).optional().describe("Optimization priority: cost (cheapest), speed (fastest delivery), quality (best rated). Default quality."),
      auto_pay: z.boolean().optional().describe("If true, automatically pay for the best option within budget WITHOUT a confirmation step — only when the buyer explicitly pre-authorized it. If false (default), options are returned for approval."),
      requested_by: z
        .object({
          name: z.string().optional().describe("Requester's display name, e.g. 'Durga'"),
          id: z.string().optional().describe("Requester's platform user id, e.g. a Slack U... id"),
          channel: z.string().optional().describe("Platform the request came from, e.g. 'slack', 'whatsapp'"),
        })
        .optional()
        .describe("Who asked for this purchase, when relaying someone else's request (e.g. a teammate in chat). Stored as execution metadata so the buyer's dashboard can attribute the order. Integrations set this programmatically; pass it whenever you know the requester."),
    },
    async ({ request, listing_id: rawListingId, budget_max, delivery_address, address_id, location, priority, auto_pay, requested_by }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        const body: any = {
          request,
          preferences: { priority: priority || "quality", require_approval: !auto_pay },
        };
        if (listing_id) body.listing_id = listing_id;
        // Attribution rides the existing free-form metadata column — the REST
        // API stores body.metadata verbatim and the list endpoint echoes it.
        if (requested_by && (requested_by.name || requested_by.id)) {
          body.metadata = { requested_by };
        }
        if (budget_max) body.budget = { max_total: budget_max, currency: "USD" };
        if (delivery_address) body.delivery_address = delivery_address;
        if (address_id) body.address_id = address_id;
        // Location makes the find step location-aware (local supply first) even
        // without a full delivery address. Only forward fields the buyer gave.
        if (location && (location.country || location.city)) {
          body.location = {
            ...(location.country ? { country: location.country } : {}),
            ...(location.city ? { city: location.city } : {}),
          };
        }

        const created = await apiRequest("POST", "/v1/executions", body);
        const defaultDelivery = created?.default_delivery?.masked || null;
        const exec = await pollExecution(apiRequest, created.id, 45_000);
        const blocks = await formatExecution(exec);

        if (exec.status === "awaiting_approval") {
          const opts = Array.isArray(exec.options) ? exec.options : [];
          const purchasableCount = opts.filter((o: any) => o.purchasable !== false).length;
          // #206 relevance floor (shared isRelevantMatch, same threshold the
          // worker uses to pre-select): never invite "approve the best option"
          // when nothing is a confident match - an irrelevant top result must
          // not be pitched as buyable.
          const hasRelevantMatch = isRelevantMatch(opts.map((o: any) => o.match_score));
          // Honest browse-only framing: a Firestarter store that hasn't enabled
          // checkout yet is NOT "external" (it's in our catalog, with an owner we
          // can activate). Only call the set "external" when it really is.
          const browseOpts = opts.filter((o: any) => o.purchasable === false && o.own_listing !== true);
          const allFsStores = browseOpts.length > 0 && browseOpts.every((o: any) => o.metadata?.source === "firestarter_seller");
          blocks.push({
            type: "text",
            text: opts.length > 0 && !hasRelevantMatch
              ? "\n\n**No exact match - present these as the closest options to browse.** None is a confident match, so do NOT pre-select one, name a single \"best option\", or tell the buyer to approve a purchase. DO surface them as the closest near-matches: share their links so the buyer can look, and offer to refine (add brand, model, size, or a price range) for a tighter match. Don't just decline. `firestarter_cancel` to stop."
              : purchasableCount === 0 && opts.length > 0
                ? (allFsStores
                  ? "\n\n**Note:** these are Firestarter stores that haven't enabled checkout yet - none can be bought here yet. Share the listing links so the buyer can view them, or use `firestarter_message` to refine toward checkout-ready listings. `firestarter_cancel` to stop."
                  : "\n\n**Note:** none of these can be purchased through Firestarter - they're external results and/or stores that haven't enabled checkout yet. You can share the URLs so the buyer can view them, refine the search with `firestarter_message`, or `firestarter_cancel`.")
                : `\n\n**Action needed:** show the buyer the delivery options above and confirm which speed they want — don't silently take the cheapest. Then they can reply "confirm" to place the order at that speed, or use \`firestarter_approve\` (execution \`${exec.id}\`) with shipping_option_index for a specific speed; \`firestarter_cancel\` to cancel. No card is needed until the order is placed.${purchasableCount < opts.length ? " Browse-only options can't be purchased here - share their links instead." : ""}`,
          });
        } else if (exec.status === "failed" || !Array.isArray(exec.options) || exec.options.length === 0) {
          // Location-aware empty state: the #1 cause of an empty catalog for a
          // non-US buyer used to be an un-localized (US-only) search. If we
          // weren't told where the buyer is, ask for it and retry — results are
          // localized to their country (local marketplaces shown first).
          const askedLocation = !!(location && (location.country || location.city));
          blocks.push({
            type: "text",
            text: askedLocation
              ? "\n\nNo matches yet. Try refining the request (brand, size, or a price range), or widen the budget. Local marketplaces for the buyer's country were included in the search."
              : "\n\n**No matches — do you know where the buyer is?** Re-run `firestarter_execute` with their `location` (country, and city if known). Results are localized to their country, so a buyer outside the US sees locally-deliverable options first instead of an empty list.",
          });
        }
        // Saved-default confirm hint: when the buyer has a default ship-to on
        // file and passed no address this call, tell the agent to CONFIRM it
        // rather than re-collect street/zip/phone. Masked (no zip/phone).
        if (exec.status === "awaiting_approval" && defaultDelivery && !delivery_address && !address_id) {
          blocks.push({
            type: "text",
            text: `\n\n**Shipping to the buyer's saved address:** ${defaultDelivery}. Confirm with them ("ship here?") \u2014 no need to ask for street, zip, or phone. To ship elsewhere, pass a different \`address_id\` or \`delivery_address\` at approval.`,
          });
        }
        return { content: blocks };
      } catch (err: any) {
        if (err instanceof ApiError && err.code === "PAYMENT_REQUIRED") {
          // #502: include the actual Firestarter-org balance snapshot so channel
          // users don't get a vague token error when a workspace-level credit
          // dashboard shows healthy balance in a different system/account.
          try {
            const bal = await apiRequest("GET", "/v1/billing/balance");
            return {
              content: [{
                type: "text" as const,
                text:
                  `Error: ${toErrorMessage(err)}\n\n` +
                  `Firestarter org billing snapshot:\n` +
                  `- org_id: ${bal.org_id}\n` +
                  `- plan: ${bal.plan}\n` +
                  `- token_balance: ${bal.token_balance}\n` +
                  `- trial_active: ${bal.trial_active ? "yes" : "no"}\n\n` +
                  `If this differs from the workspace credit view, the channel may be linked to a different Firestarter org/API key. Re-provision or relink the integration key for this workspace.`,
              }],
              isError: true,
            };
          } catch {
            // Fall back to the base error when balance lookup itself fails.
          }
        }
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_preview
  // Phase A: keyless commerce preview surfaced as a read-only tool. Shows real
  // options + prices + buyability + per-option eligibility WITHOUT creating an
  // execution, so an agent can answer "what can you get me?" before committing.
  registerToolCompat(
    server,
    "firestarter_preview",
    {
      description:
        "Preview real products for a natural-language request WITHOUT starting a purchase. Returns live options with prices, whether each can be bought through Firestarter (vs browse-only), shipping, and per-option eligibility — in budget, can arrive by the deadline, and ships to the destination. Use it to show the buyer what's available and answer \"what can you get me?\" before committing to firestarter_execute. Read-only: nothing is bought and no approval is created.",
      inputSchema: {
        query: z.string().describe("What to look for, e.g. 'polo t-shirt' or 'wireless earbuds under $50'"),
        country: z.string().optional().describe("Destination country (ISO alpha-2 or common name) — enables shipping/serviceability checks"),
        city: z.string().optional().describe("Destination city"),
        deadline: z.string().optional().describe("Delivery deadline, e.g. 'Friday', 'in 3 days', '2026-07-03'"),
        min_price: z.number().optional().describe("Price floor in USD"),
        max_price: z.number().optional().describe("Budget ceiling in USD"),
        quantity: z.number().int().min(1).max(100).optional().describe("How many units (1-100)"),
        context: z
          .object({
            country: z.string().optional().describe("Destination country (takes precedence over the top-level country)"),
            city: z.string().optional().describe("Destination city (takes precedence over the top-level city)"),
            language: z.string().optional().describe("Buyer language, BCP-47 (e.g. 'en', 'fr-CA'). Advisory."),
            currency: z.string().optional().describe("Display currency, ISO-4217 (e.g. 'USD'). Advisory — preview does not convert money."),
            intent: z.string().optional().describe("Free-text buyer preference (e.g. 'prefers eco-friendly'). Recorded; shapes ranking only in firestarter_execute."),
          })
          .optional()
          .describe("Structured buyer context: destination, locale, currency, and intent."),
        limit: z.number().int().min(1).max(50).optional().describe("Max options per page (1-50, default 10)."),
        cursor: z.string().optional().describe("Opaque pagination cursor from a prior preview's page.next_cursor to fetch the next page."),
      },
      outputSchema: previewOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, country, city, deadline, min_price, max_price, quantity, context, limit, cursor }: {
      query: string;
      country?: string;
      city?: string;
      deadline?: string;
      min_price?: number;
      max_price?: number;
      quantity?: number;
      context?: { country?: string; city?: string; language?: string; currency?: string; intent?: string };
      limit?: number;
      cursor?: string;
    }) => {
      try {
        const ctx = context ?? {};
        const destCountry = ctx.country ?? country;
        const destCity = ctx.city ?? city;
        const language = ctx.language;
        const currency = ctx.currency ? ctx.currency.toUpperCase() : undefined;
        const intent = ctx.intent;
        const params = new URLSearchParams({ q: query });
        if (destCountry) params.set("country", destCountry);
        if (destCity) params.set("city", destCity);
        if (deadline) params.set("deadline", deadline);
        if (min_price != null) params.set("min", String(min_price));
        if (max_price != null) params.set("max", String(max_price));
        if (quantity != null) params.set("qty", String(quantity));
        if (language) params.set("language", language);
        if (currency) params.set("currency", currency);
        if (intent) params.set("intent", intent);
        if (limit != null) params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);

        const data = await apiRequest("GET", `/commerce/preview?${params.toString()}`, undefined, PREVIEW_TIMEOUT_MS);

        if (data.blocked) {
          return {
            content: [{ type: "text" as const, text: `Can't preview that: ${data.reason || "the item isn't supported on Firestarter."}` }],
            structuredContent: toPreviewStructured(data, { query, country: destCountry, city: destCity, language, currency, intent }),
          };
        }
        const options: any[] = Array.isArray(data.options) ? data.options : [];
        if (options.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No matching products found for "${data.query || query}". Try a broader query, or drop the price/deadline filters.` }],
            structuredContent: toPreviewStructured(data, { query, country: destCountry, city: destCity, language, currency, intent }),
          };
        }

        let text = `**Preview for "${data.query || query}"** (${options.length} option${options.length === 1 ? "" : "s"})\n`;
        const buyableEligible = options.filter((o) => o.purchasable && o.eligible).length;
        options.forEach((o, i) => {
          const price = Number.isFinite(o.price) ? `$${Number(o.price).toFixed(2)}` : "price n/a";
          const ship = o.shipping?.known
            ? (o.shipping.amount_usd === 0 ? " + free shipping" : ` + $${Number(o.shipping.amount_usd).toFixed(2)} shipping`)
            : " (shipping at checkout)";
          text += `\n${i + 1}. **${o.title}** — ${price}${ship}`;
          if (o.seller) text += ` · ${o.seller}`;
          text += `\n   ${o.purchasable ? "✓ buyable through Firestarter" : `browse-only${o.url ? ` — view: ${tidyProductUrl(o.url)}` : ""}`}`;
          if (o.purchasable) {
            if (o.eligible) {
              text += `\n   ✓ eligible to buy now`;
            } else {
              const blockers = (o.reasons || []).map((r: string) => PREVIEW_REASON_LABELS[r] || r);
              text += `\n   ⚠ not eligible: ${blockers.join("; ") || "see details"}`;
            }
          }
        });
        text += buyableEligible > 0
          ? `\n\n${buyableEligible} option${buyableEligible === 1 ? " is" : "s are"} buyable now — call firestarter_execute (or pass a listing_id) to purchase, after confirming with the buyer.`
          : `\n\nNone of these can be purchased through Firestarter right now — share the browse links, or refine the query toward checkout-ready listings.`;

        // Inline the top options' photos so MCP clients (Claude/Cursor/Copilot)
        // render them; the image URLs also remain in structuredContent for chat
        // clients that unfurl links.
        const previewImages = await inlineImageBlocks(options.map((o) => o.image_url ?? o.image));
        return {
          content: [{ type: "text" as const, text }, ...previewImages],
          structuredContent: toPreviewStructured(data, { query, country: destCountry, city: destCity, language, currency, intent }),
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_status
  server.tool(
    "firestarter_status",
    "Check the status of a Firestarter execution or list recent executions, and report the current ENVIRONMENT (test vs live). Use this to check on orders, see what options were found, get tracking updates, or confirm whether you are in test/sandbox mode. Firestarter DOES have a test mode: an `fs_test_…` API key runs every purchase through a fully simulated sandbox (mock payment, shipping, and tracking — no real money moves and no real seller is contacted); an `fs_live_…` key is real. The mode is fixed by the configured API key, not a per-call option.",
    {
      execution_id: z.string().optional().describe("Specific execution ID to check (e.g. 'exec_abc123'). Omit to list recent executions."),
      status_filter: z.string().optional().describe("Filter executions by status: finding, awaiting_approval, approved, paid, shipping, completed, failed, cancelled"),
    },
    async ({ execution_id, status_filter }) => {
      // Environment is determined by the API key prefix (auth.ts): fs_test_* ->
      // sandbox, anything else -> live. Surfaced so the agent can correctly
      // answer "are we in test mode?" instead of assuming there is none.
      const environment = apiKey.startsWith("fs_test_")
        ? "TEST (sandbox — simulated payment/shipping/tracking, no real money, no real seller contacted)"
        : "LIVE (real orders, real charges)";
      try {
        if (execution_id) {
          const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
          return { content: await formatExecution(exec) };
        }
        let path = "/v1/executions";
        if (status_filter) path += `?status=${encodeURIComponent(status_filter)}`;
        const data = await apiRequest("GET", path);
        const executions = data.executions || data;
        if (!Array.isArray(executions) || executions.length === 0) {
          return { content: [{ type: "text" as const, text: `Environment: ${environment}\n\nNo executions found.` }] };
        }
        const lines = [`Environment: ${environment}\n`, `**Recent Executions** (${data.total || executions.length} total)\n`];
        for (const e of executions.slice(0, 10)) {
          lines.push(`- **${e.id}** [${e.status}] ${e.request_text?.slice(0, 60) || ""}${e.request_text?.length > 60 ? "..." : ""}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_approve
  server.tool(
    "firestarter_approve",
    "Confirm and place an order that is awaiting approval — this is the step that actually BUYS and pays. Lifecycle: firestarter_execute (or a listing_id buy) returns options awaiting approval → you confirm the ship-to with the buyer → firestarter_approve places and pays for the order → the buyer can then get a receipt (firestarter_receipt) and follow delivery (firestarter_track_order). The buyer's SAVED DEFAULT address is used automatically — you do NOT need to collect or re-type their street, zip, or phone; just confirm where it's shipping (the execute/approve responses show a masked view). Only pass a `delivery_address` (or a saved `address_id` from firestarter_addresses) when the buyer has no saved address or wants THIS order shipped somewhere else. By default it approves the pre-selected (best purchasable) option; pass selected_option or option_id to pick a different one. Delivery speed is the buyer's choice: the option shows a numbered 'Delivery options' menu (Standard / Express / Same-Day with prices + ETAs) — if the buyer wants a faster or specific one, pass shipping_option_index (the [number] from that menu); omit it to use the cheapest. Only Firestarter-purchasable options can be approved — browse-only results (external listings, or Firestarter stores that haven't enabled checkout) are rejected with a view link instead. When the user just says \"approve\"/\"confirm\"/\"yes\" without naming an order, omit execution_id: the tool resolves the single pending purchase automatically (and asks which one only if several are pending). If approval returns PRICE_CHANGED, show the exact updated total to the buyer and ask again; only after they explicitly confirm it, call this tool again with confirm_total set to that exact value AND consent_nonce set to the one-time nonce that PRICE_CHANGED returned (echo it verbatim — it is single-use and cannot be guessed). If no address is saved and none is passed, approval of physical goods is rejected — collect one then.",
    {
      execution_id: z.string().optional().describe("The execution ID to approve (e.g. 'exec_abc123'). Omit when the user simply replied \"approve\": the tool then approves the one execution awaiting approval, surfaces payment-setup guidance if the order is parked awaiting a payment method, or lists the candidates if several are pending."),
      selected_option: z.number().int().min(0).optional().describe("0-based index into the options list as displayed (the option shown as '1.' is index 0). Omit to approve the pre-selected best option."),
      option_id: z.string().optional().describe("Exact option id (e.g. 'opt_abc123') to approve, as returned in API errors or the execution resource. Takes precedence over selected_option."),
      address_id: z.string().optional().describe("A saved address id (addr_...) to ship this order to, from firestarter_addresses. Optional — omit to use the buyer's default saved address. Pass only to ship somewhere other than their default."),
      // Permissive, forever-stable boundary (see firestarter_execute): string OR
      // any object, never rejected for shape; the server normalizes + gates.
      delivery_address: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("Optional — pass EITHER a single-line string (e.g. \"123 Main St, Austin, TX 78701, US\") OR an object { name?, street1, street2?, city, state?, zip?, country? }. The buyer's saved default address is used automatically; only pass a NEW address here to ship this order elsewhere, or when the buyer has no saved address. A partial or odd-shaped address is accepted (never rejected for shape); a complete one (ZIP + state for US/CA/AU) is required only at the pay boundary. On a first order with no saved address, the address you pass is saved as their default for next time."),
      shipping_option_index: z.number().int().min(0).optional().describe("0-based index of the delivery speed to use, taken from the numbered 'Delivery options' menu shown for the option (in firestarter_execute / firestarter_status output, or firestarter_shipping_options). Omit to use the cheapest rate; the order total is recalculated server-side for the chosen speed and included in what the buyer approves."),
      confirm_total: z.number().nonnegative().optional().describe("Exact updated total in USD from a prior PRICE_CHANGED response. Pass only after showing that total to the buyer and receiving a new explicit confirmation; never guess or pre-fill it on the first approval."),
      consent_nonce: z.string().optional().describe("The single-use consent_nonce string from a prior PRICE_CHANGED response. Pass it VERBATIM together with confirm_total when re-approving a price change. It is one-time-use and cannot be guessed — never fabricate it; only echo the exact value the last PRICE_CHANGED returned."),
    },
    async ({ execution_id, selected_option, option_id, delivery_address, address_id, shipping_option_index, confirm_total, consent_nonce }) => {
      try {
        // Bare "approve" (no execution_id): resolve the pending purchase so a
        // user replying just "approve" in chat doesn't dead-end with "nothing
        // pending approval" (issue #172). The /approve route needs an id, and
        // the agent often no longer holds it a few turns after the prompt.
        // Prefer an execution awaiting_approval; if none, fall through to one
        // parked at awaiting_payment_method so the approve call returns the
        // actionable PAYMENT_METHOD_REQUIRED guidance instead of a dead end.
        if (!execution_id) {
          const list = await apiRequest("GET", "/v1/executions?limit=20");
          const all: any[] = Array.isArray(list?.executions)
            ? list.executions
            : Array.isArray(list)
              ? list
              : [];
          const approvable = all.filter((e) => e.status === "awaiting_approval");
          if (approvable.length === 1) {
            execution_id = approvable[0].id;
          } else if (approvable.length > 1) {
            const lines = approvable
              .slice(0, 10)
              .map((e) => `- \`${e.id}\` — ${e.request_text?.slice(0, 60) || "(no description)"}`);
            return {
              content: [{
                type: "text" as const,
                text: `You have ${approvable.length} purchases awaiting approval. Call firestarter_approve again with the execution_id of the one to approve:\n${lines.join("\n")}`,
              }],
              isError: true,
            };
          } else {
            const parked = all.filter((e) => e.status === "awaiting_payment_method");
            if (parked.length >= 1) {
              // Hand the most recent parked order to the approve route; it
              // returns PAYMENT_METHOD_REQUIRED with a setup URL (actionable).
              execution_id = parked[0].id;
            } else {
              return {
                content: [{
                  type: "text" as const,
                  text: "There's nothing awaiting your approval right now. If you just started a search it may still be finding options — check firestarter_status, or start a new request.",
                }],
                isError: true,
              };
            }
          }
        }
        if (!execution_id) {
          return {
            content: [{ type: "text" as const, text: "No execution to approve." }],
            isError: true,
          };
        }

        const body: any = {};
        if (delivery_address) body.delivery_address = delivery_address;
        if (address_id) body.address_id = address_id;
        if (shipping_option_index != null) body.shipping_option_index = shipping_option_index;
        if (confirm_total != null) body.confirm_total = confirm_total;
        if (consent_nonce != null) body.consent_nonce = consent_nonce;
        if (option_id) {
          body.option_id = option_id;
        } else if (selected_option !== undefined) {
          // The approve route takes an option *id*; resolve the displayed index
          // against the execution's options (same match_score DESC order the
          // agent saw). Previously this was sent as `selected_option`, which
          // the API ignored — silently approving the pre-selected row instead.
          const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
          const opts: any[] = Array.isArray(exec.options) ? exec.options : [];
          const chosen = opts[selected_option];
          if (!chosen?.id) {
            return {
              content: [{
                type: "text" as const,
                text: `Error approving: option index ${selected_option} is out of range — this execution has ${opts.length} option(s) (valid indexes 0-${Math.max(0, opts.length - 1)}).`,
              }],
              isError: true,
            };
          }
          body.option_id = chosen.id;
        }
        const approveRes = await apiRequest("POST", `/v1/executions/${execution_id}/approve`, body);
        const exec = await pollExecution(apiRequest, execution_id, 30_000);

        // Restate the chosen delivery SERVICE + the exact shipping-inclusive
        // all-in the pay step will charge — from the authoritative approve
        // response, falling back to the polled execution — so the buyer always
        // sees shipping + total BEFORE the payment/card step.
        const payReady = renderPayReadySummary({
          baseCents: (approveRes?.total_cents ?? exec.selected_option?.total_cents ?? null) as number | null,
          shipping: approveRes?.shipping ?? exec.selected_shipping ?? null,
          dm: exec.developer_margin,
        });

        // #272: when approval transitions to awaiting_payment_method, return a
        // concise one-shot message instead of the full execution dump (which
        // caused repetitive/duplicated output in Slack) — now WITH the shipping
        // service + all-in shown next to the card link.
        if (exec.status === "awaiting_payment_method" && exec.setup_url) {
          const text = [
            "Order approved.",
            ...payReady,
            "",
            "**Last step — add a payment method to place the order** (no login needed):",
            exec.setup_url,
            "",
            "The order completes automatically once a card is added — you'll be charged the all-in above.",
          ].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        const blocks = await formatExecution(exec);
        const head = payReady.length ? `Order approved.\n${payReady.join("\n")}\n` : "Execution approved.\n";
        blocks.unshift({ type: "text", text: head });
        return { content: blocks };
      } catch (err: any) {
        if (err instanceof ApiError && err.code === "PRICE_CHANGED") {
          const oldTotal = Number(err.body?.previous_total);
          const newTotal = Number(err.body?.new_total);
          const oldLabel = Number.isFinite(oldTotal) ? `$${oldTotal.toFixed(2)}` : "the quoted amount";
          const newLabel = Number.isFinite(newTotal) ? `$${newTotal.toFixed(2)}` : "the updated amount";
          const nonce = typeof err.body?.consent_nonce === "string" ? err.body.consent_nonce : null;
          const newArg = Number.isFinite(newTotal) ? newTotal.toFixed(2) : "<new total>";
          return {
            content: [{
              type: "text" as const,
              text: `Shipping changed the order total from ${oldLabel} to ${newLabel}. Nothing was charged. Show the buyer ${newLabel} and ask for a new explicit confirmation. Only after they confirm, call firestarter_approve again with confirm_total: ${newArg}${nonce ? ` and consent_nonce: "${nonce}"` : ""}.`,
            }],
            isError: true,
          };
        }
        // Fail-closed shipping: a live carrier rate could not be obtained — surface
        // the retry so the agent can try again rather than charging a placeholder.
        if (err instanceof ApiError && err.code === "SHIPPING_UNAVAILABLE") {
          return {
            content: [{ type: "text" as const, text: "Couldn't get a live shipping rate for this address just now, so nothing was charged. Try firestarter_approve again in a moment; if it keeps failing, the address may be outside the carriers' service area." }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Error approving: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_shipping_options
  // Shows the buyer the real delivery-speed choices (Standard / Express /
  // Same-Day, with prices, ETAs, and per-speed all-in totals) for an order
  // awaiting approval, and previews the re-priced total for a chosen speed —
  // BEFORE anything is paid. The numbers map 1:1 to firestarter_approve's
  // shipping_option_index, so the buyer picks a speed and the agent carries the
  // index into approve. Non-blocking: approving without a pick uses the cheapest.
  server.tool(
    "firestarter_shipping_options",
    "Show and compare the delivery speeds for an order awaiting approval, and preview the re-priced total for a chosen speed — before paying. Returns the numbered 'Delivery options' menu (Standard / Express / Same-Day, each with its price, ETA, and all-in total); the buyer picks one and you place the order by calling firestarter_approve with shipping_option_index set to that [number]. Use this when the buyer asks about delivery speed/cost, wants it faster, or you want to show the trade-off before they approve — otherwise firestarter_execute already lists these inline and approving without a pick uses the cheapest rate. Pass refresh:true to re-fetch live carrier rates (e.g. if the quote is stale), and select_index to preview one speed's new total.",
    {
      execution_id: z.string().describe("The execution ID (exec_...) to show delivery options for — an order that is awaiting approval."),
      option_id: z.string().optional().describe("Which option's delivery methods to show (opt_...). Omit to use the pre-selected option (the one the buyer is about to approve)."),
      select_index: z.number().int().min(0).optional().describe("Preview a specific delivery speed: the [number] from the menu. Shows that speed's new all-in total and the exact shipping_option_index to approve with. Does NOT select or pay — it's a preview."),
      refresh: z.boolean().optional().describe("Re-fetch live carrier rates and persist them before showing the menu. Use when the stored rates may be stale (e.g. >30 min old). Off by default."),
    },
    async ({ execution_id, option_id, select_index, refresh }) => {
      try {
        const qs = new URLSearchParams();
        if (option_id) qs.set("option_id", option_id);
        if (refresh) qs.set("refresh", "true");
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        const data = await apiRequest("GET", `/v1/executions/${execution_id}/shipping-options${suffix}`);
        const methods: any[] = Array.isArray(data.options) ? data.options : [];
        if (methods.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No delivery options are available for this order yet — they're computed once a product and a delivery address are set. Check firestarter_status, or approve to use the standard rate.",
            }],
          };
        }

        // App integration margin varies by API key; fetch it so the all-in shown
        // here is the all-in charged. Best-effort — a miss just omits the margin.
        let dm: any = null;
        try {
          const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
          dm = exec?.developer_margin ?? null;
        } catch { /* margin is best-effort; base all-in still shown */ }
        const marginBps = dm && typeof dm.margin_bps === "number" ? dm.margin_bps : 0;
        const capCents = dm && typeof dm.per_transaction_cap_cents === "number" ? dm.per_transaction_cap_cents : undefined;
        const allInCents = (baseCents: number) =>
          marginBps > 0 ? baseCents + marginCentsFor(baseCents, marginBps, capCents) : baseCents;
        const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

        const lines: string[] = [];
        lines.push(`Delivery options${data.product_title ? ` for ${data.product_title}` : ""} — pick a speed, or approve to use the cheapest:`);
        if (data.ship_from) {
          const from = [data.ship_from.city, data.ship_from.state, data.ship_from.country].filter(Boolean).join(", ");
          if (from) lines.push(`Ships from: ${from}`);
        }
        if (data.ship_to) {
          const to = [data.ship_to.city, data.ship_to.state, data.ship_to.country].filter(Boolean).join(", ");
          if (to) lines.push(`Ships to: ${to}`);
        }
        if (data.fee_breakdown) {
          lines.push(`Item subtotal: ${fmt(data.fee_breakdown.subtotal_cents || 0)} · Tax: ${fmt(data.fee_breakdown.tax_cents || 0)} · Shipping: shown per option below`);
        }
        for (const m of methods) {
          const price = m.price_cents == null ? "price at checkout" : m.price_cents === 0 ? "free" : fmt(m.price_cents);
          const eta = m.delivery_range || (m.delivery_days != null ? `~${m.delivery_days} day${m.delivery_days === 1 ? "" : "s"}` : null);
          const label = m.label || [m.carrier, m.service].filter(Boolean).join(" ") || m.method_type || "Shipping";
          const allIn = m.all_in_cents != null ? `${fmt(allInCents(m.all_in_cents))} all-in` : null;
          const tags = [
            ...(Array.isArray(m.badges) ? m.badges : []),
            m.provider ? `provider: ${m.provider}` : null,
            m.carrier ? `carrier: ${m.carrier}` : null,
            m.is_estimated ? "estimate" : null,
          ].filter(Boolean);
          const parts = [`[${m.index}] ${label}`, price];
          if (eta) parts.push(eta);
          if (allIn) parts.push(allIn);
          lines.push(`  ${parts.join(" · ")}${tags.length ? ` — ${tags.join(", ")}` : ""}`);
        }

        if (select_index != null) {
          const chosen = methods.find((m) => m.index === select_index);
          if (!chosen) {
            lines.push("", `[${select_index}] isn't one of the options above — choose one of the listed [numbers].`);
          } else {
            const label = chosen.label || [chosen.carrier, chosen.service].filter(Boolean).join(" ") || chosen.method_type || "that speed";
            const total = chosen.all_in_cents != null ? fmt(allInCents(chosen.all_in_cents)) : "the price shown above";
            lines.push("", `Selected ${label} — new total ${total}. To place the order at this speed, approve with shipping_option_index = ${select_index}.`);
          }
        } else {
          lines.push("", "To choose one, approve with shipping_option_index set to its [number]. Approving without it uses the cheapest.");
        }
        if (data.refreshed) lines.push("", "(Live rates refreshed just now.)");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        const msg = err instanceof ApiError ? err.message : err?.message || String(err);
        return {
          content: [{ type: "text" as const, text: `Couldn't load delivery options: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: firestarter_addresses
  // Lets the agent see the buyer's saved shipping addresses (masked) so it can
  // pass a saved address_id to firestarter_execute/approve instead of asking
  // the buyer to re-type a street/zip/phone it already has on file. Deliberately
  // MASKED: partial street only, never zip or phone — the agent doesn't need PII
  // to reference an address, and the raw values stay server-side.
  server.tool(
    "firestarter_addresses",
    "List the buyer's saved shipping addresses (masked). Use this to see if they already have an address on file BEFORE asking them to type one — then pass the matching `address_id` to firestarter_execute or firestarter_approve. The default address (used automatically at approval) is marked. Values are masked (partial street, no zip/phone); you don't need the full address to reference it by id.",
    {},
    async () => {
      try {
        const data = await apiRequest("GET", "/v1/addresses");
        const rows: any[] = Array.isArray(data?.addresses) ? data.addresses : [];
        if (rows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No saved addresses yet. When the buyer gives one at their first order it's saved as their default automatically for next time.",
            }],
          };
        }
        const lines = rows.map((a) => {
          const label = a.label || a.name || "Address";
          const place = [a.city, a.country].filter(Boolean).join(", ");
          const street = a.street1 ? `${String(a.street1).slice(0, 6)}\u2026` : "";
          const parts = [label, place, street].filter(Boolean).join(" \u00b7 ");
          return `- \`${a.id}\`${a.is_default ? " (default)" : ""} \u2014 ${parts}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `**Saved addresses** (pass the id as \`address_id\` to ship there):\n${lines.join("\n")}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_save_address
  server.tool(
    "firestarter_save_address",
    "Save a delivery address to the buyer's address book for reuse on future orders. Use this after a purchase when the buyer gave a new address, or when they explicitly ask to save an address. Pass an optional label (e.g. 'Home', 'Office', 'Mom's house') — if omitted, a default label is assigned. Set `is_default: true` to make it the default shipping address for future orders. Returns the saved address id.",
    {
      street1: z.string().describe("Street address line 1"),
      street2: z.string().optional().describe("Street address line 2 (apt, suite, etc.)"),
      city: z.string().describe("City"),
      state: z.string().optional().describe("State / province / region"),
      zip: z.string().optional().describe("Postal / ZIP code"),
      country: z.string().optional().describe("ISO country code (e.g. US, PK, KE). Defaults to US."),
      name: z.string().optional().describe("Recipient name"),
      phone: z.string().optional().describe("Phone number for delivery"),
      label: z.string().optional().describe("Label for this address (e.g. 'Home', 'Office', 'Warehouse'). If omitted, a default label is assigned."),
      is_default: z.boolean().optional().describe("Set to true to make this the default shipping address."),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          street1: args.street1,
          city: args.city,
          country: args.country || "US",
        };
        if (args.street2) body.street2 = args.street2;
        if (args.state) body.state = args.state;
        if (args.zip) body.zip = args.zip;
        if (args.name) body.name = args.name;
        if (args.phone) body.phone = args.phone;
        if (args.label) body.label = args.label;
        if (args.is_default) body.is_default = args.is_default;

        // POST /v1/addresses responds { address: {...} } — unwrap it.
        const res = await apiRequest("POST", "/v1/addresses", body);
        const saved = res?.address ?? res;
        const place = [saved.city, saved.state, saved.country].filter(Boolean).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `Address saved as "${saved.label || "Address"}" (${place}).` +
              `\nid: \`${saved.id}\`${saved.is_default ? " (default)" : ""}` +
              `\nUse this \`address_id\` on future firestarter_execute / firestarter_approve calls to ship here.`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error saving address: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_payment_method
  server.tool(
    "firestarter_payment_method",
    "Check the buyer's payment method status and get a link to add or update their card. IMPORTANT — the card is the LAST step of a purchase, NOT a precondition: run firestarter_execute first and let the buyer see the shipping estimate and pick a delivery speed (shipping_option_index) BEFORE any card is collected. A card is only genuinely needed once an order is parked at awaiting_payment_method (after approval), or when the buyer explicitly asks to add one now. Do NOT collect a card up front just to browse, quote, or compare shipping — none of those need one. Use this tool when the buyer asks about payment or an order is waiting on a card. Returns a no-login Stripe setup link (works from any channel - WhatsApp, Slack, Telegram) plus a dashboard link.",
    {},
    async () => {
      try {
        const methods = await apiRequest("GET", "/v1/payments/methods");
        const cards = methods.payment_methods || [];
        if (cards.length > 0) {
          const card = cards.find((c: any) => c.card) || cards[0];
          const detail = card.card ? `${card.card.brand} ending in ${card.card.last4} (expires ${card.card.exp_month}/${card.card.exp_year})` : "saved";
          let text = `**Payment method on file:** ${detail}\n\nOrders will charge this card automatically.\n\n`;
          const setup = await apiRequest("POST", "/v1/billing/setup-payment");
          text += `To update or add a different card:\n${setup.short_url || setup.url}\n\n`;
          text += `Or go to your dashboard settings: https://firestarter.network/dashboard?tab=settings`;
          return { content: [{ type: "text" as const, text }] };
        }
        // No payment method - get a setup link
        const setup = await apiRequest("POST", "/v1/billing/setup-payment");
        let text = "**No payment method on file.** A card is only needed at the FINAL payment step — after the buyer has run firestarter_execute, seen the shipping estimate, and picked a delivery speed. Browsing, quoting, and comparing shipping never require one.\n\n";
        text += `If an order is already approved and waiting on payment, add a card here to finish it (no login needed, works from any device):\n${setup.short_url || setup.url}\n\n`;
        text += `Or add one from your dashboard settings: https://firestarter.network/dashboard?tab=settings\n\n`;
        text += `Once added, any pending orders resume automatically. If the buyer is not mid-purchase, start with firestarter_execute instead — no card required.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error checking payment methods: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_cancel
  server.tool(
    "firestarter_cancel",
    "Cancel an active execution. A not-yet-captured authorization hold is voided; an already-captured payment is refunded. An order that has already shipped can't be cancelled — use firestarter_return instead.",
    {
      execution_id: z.string().describe("The execution ID to cancel"),
      reason: z.string().optional().describe("Reason for cancellation"),
    },
    async ({ execution_id, reason }) => {
      try {
        await apiRequest("POST", `/v1/executions/${execution_id}/cancel`, { reason });
        return { content: [{ type: "text" as const, text: `Execution ${execution_id} cancelled.${reason ? ` Reason: ${reason}` : ""}` }] };
      } catch (err: any) {
        if (err instanceof ApiError && err.code === "ORDER_ALREADY_SHIPPED") {
          return { content: [{ type: "text" as const, text: `This order can't be cancelled — it's already paid and shipped. Use \`firestarter_return\` to return it for a refund.` }] };
        }
        return { content: [{ type: "text" as const, text: `Error cancelling: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_track_order
  server.tool(
    "firestarter_track_order",
    "Track a shipped order's delivery status. Returns carrier, tracking number, estimated delivery, and current location/events. Use when a buyer asks 'where's my order?' or 'when will it arrive?'. Only works after an order has been paid and shipped — for unpaid/unshipped orders, use firestarter_status instead.",
    {
      execution_id: z.string().describe("The execution/order ID to track (exec_...)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ execution_id }) => {
      try {
        // API-key-authed route. Do NOT use /commerce/tracking/:id — that one is
        // JWT/dashboard-only and 401s an API key (mis-reported as a revoked key).
        const data = await apiRequest("GET", `/v1/executions/${execution_id}/tracking`);
        if (!data.tracking_number) {
          const status = data.order_status || data.display_status || data.status;
          return { content: [{ type: "text" as const, text: `**Order ${execution_id}** — Status: ${status || "pending"}. No tracking info yet. The seller may not have shipped it yet, or tracking hasn't been added. Use \`firestarter_status\` to check the order's current state.` }] };
        }
        let text = `**Order ${execution_id} — Shipping**\n`;
        if (data.ship_from) {
          text += `Ships from: ${[data.ship_from.city, data.ship_from.state, data.ship_from.country].filter(Boolean).join(", ")}\n`;
        }
        text += `Carrier: ${data.carrier || "Unknown"}\n`;
        if (data.shipping_method?.provider) text += `Provider: ${data.shipping_method.provider}\n`;
        if (data.shipping_method?.service) text += `Service: ${data.shipping_method.service}\n`;
        text += `Tracking: ${data.tracking_number}\n`;
        if (data.tracking_url) text += `Track: ${data.tracking_url}\n`;
        if (data.estimated_delivery) text += `Estimated delivery: ${data.estimated_delivery}\n`;
        text += `Status: ${data.status || "in_transit"}\n`;
        if (data.fee_breakdown) {
          const f = data.fee_breakdown;
          const money = (cents: number) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
          text += `Fees: item ${money(f.subtotal_cents)} + shipping ${money(f.shipping_cents)} + tax ${money(f.tax_cents)} = ${money(f.total_cents)}\n`;
        }
        if (data.events?.length > 0) {
          text += `\n**Recent events:**\n`;
          for (const e of data.events.slice(-5)) {
            const eventDate = e.datetime || e.date || "Update";
            const eventDetail = e.description || e.message || e.detail || e.status || "Shipping update";
            text += `  ${eventDate}: ${eventDetail}\n`;
          }
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // Not-ready orders come back as 200 with no tracking_number (handled above).
        // A 404/403 (order not found for this org, or not yet trackable) must not be
        // relayed as the generic "invalid/revoked key" message — give a helpful hint.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          return { content: [{ type: "text" as const, text: `**Order ${execution_id}** — Not ready for tracking yet. This order may not have been paid or shipped. Use \`firestarter_status\` to check its current state.` }] };
        }
        return { content: [{ type: "text" as const, text: `Error tracking: ${msg}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_return
  server.tool(
    "firestarter_return",
    "Initiate a return for a purchased order. Creates a return shipping label and processes the refund. Use when a buyer wants to return an item, get a refund, or reports a problem with their purchase.",
    {
      execution_id: z.string().describe("The execution/order ID to return (exec_...)"),
      reason: z.string().optional().describe("Reason for the return (e.g. 'wrong size', 'damaged', 'not as described')"),
    },
    { destructiveHint: true, idempotentHint: false },
    async ({ execution_id, reason }) => {
      try {
        const data = await apiRequest("POST", `/v1/executions/${execution_id}/return`, { reason });
        let text = `**Return initiated for order ${execution_id}**\n`;
        if (data.return_label_url) text += `Return label: ${data.return_label_url}\n`;
        if (data.amount_refunded_cents) text += `Refund: $${(data.amount_refunded_cents / 100).toFixed(2)}\n`;
        text += `Status: ${data.status || "return_initiated"}\n`;
        if (data.return_label_url) {
          text += `\nPrint the return label, pack the item, and drop it off with the carrier. The refund processes once the return is received.`;
        } else {
          text += `\nThe refund has been processed. No return shipping needed.`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error initiating return: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_confirm_delivery
  server.tool(
    "firestarter_confirm_delivery",
    "Confirm that a shipped or delivered order was received by the buyer. This marks a shipped order delivered and expedites escrow release instead of waiting for carrier confirmation plus the auto-release window (5 days). Use when the buyer says 'I got it', 'package arrived', or 'confirm delivery'.",
    {
      execution_id: z.string().describe("The execution/order ID to confirm delivery for (exec_...)"),
    },
    async ({ execution_id }) => {
      try {
        // Find the order ID from the execution
        const orderData = await apiRequest("GET", `/v1/executions/${execution_id}`);
        const orderId = orderData.order_id || orderData.id;
        await apiRequest("POST", `/buyer/orders/${orderId}/confirm`);
        return { content: [{ type: "text" as const, text: `**Delivery confirmed for ${execution_id}.** Escrow release has been expedited — the seller will be paid on the next processing tick. Thank you for confirming!` }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        if (/not.*(deliver|receiv|ship)/i.test(msg) || (err instanceof ApiError && err.status === 400)) {
          return { content: [{ type: "text" as const, text: `Cannot confirm delivery: the order has not shipped yet. Use \`firestarter_status\` to check its current state.` }] };
        }
        return { content: [{ type: "text" as const, text: `Error confirming delivery: ${msg}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_review
  server.tool(
    "firestarter_review",
    "Submit a review for a delivered/completed order. Use when the buyer wants to rate their purchase experience (1-5 stars with optional comment). Only one review per order is allowed.",
    {
      execution_id: z.string().describe("The execution/order ID to review (exec_...)"),
      rating: z.number().int().min(1).max(5).describe("Rating from 1 (poor) to 5 (excellent)"),
      comment: z.string().max(1000).optional().describe("Optional text review (max 1000 chars)"),
    },
    async ({ execution_id, rating, comment }) => {
      try {
        // Find the order ID from the execution
        const orderData = await apiRequest("GET", `/v1/executions/${execution_id}`);
        const orderId = orderData.order_id || orderData.id;
        await apiRequest("POST", `/buyer/reviews`, { order_id: orderId, rating, comment });
        const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
        let text = `**Review submitted** ${stars} (${rating}/5)`;
        if (comment) text += `\n"${comment}"`;
        text += `\n\nThank you for the feedback — it helps other buyers and builds the seller's reputation.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        if (/already.*review/i.test(msg) || (err instanceof ApiError && err.code === "ALREADY_REVIEWED")) {
          return { content: [{ type: "text" as const, text: `This order has already been reviewed. Each order can only be reviewed once.` }] };
        }
        if (/not.*deliver/i.test(msg)) {
          return { content: [{ type: "text" as const, text: `Cannot review yet — the order must be delivered/completed first.` }] };
        }
        return { content: [{ type: "text" as const, text: `Error submitting review: ${msg}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_spend_cap
  server.tool(
    "firestarter_spend_cap",
    "Read, raise, lower, set, or remove the buyer's monthly spend cap - the safety limit on total monthly spend. THIS is the tool for changing the spending limit: call it whenever the buyer wants to increase, raise, bump, set, lower, or change their cap (e.g. 'increase my spending cap to $100', 'raise my limit to $X', 'set a spending limit', 'cap my spending at $X', 'what's my budget?'). IMPORTANT: when a purchase is rejected with SPEND_CAP_EXCEEDED and the buyer wants to proceed, call THIS tool with a higher spend_cap_dollars and then retry the purchase - never tell the buyer you cannot change the cap. Pass no arguments to read the current cap; set disable:true to remove it entirely. Also shows/sets the alert threshold (default 80%) at which a warning fires.",
    {
      spend_cap_dollars: z.number().min(1).optional().describe("New monthly spend cap in dollars (e.g. 500 = $500/month). Omit to just read the current value."),
      alert_threshold_pct: z.number().int().min(1).max(100).optional().describe("Fire a warning when monthly spend reaches this % of the cap. Default 80."),
      disable: z.boolean().optional().describe("Set to true to remove the spend cap entirely (no limit)."),
    },
    async ({ spend_cap_dollars, alert_threshold_pct, disable }) => {
      try {
        if (disable) {
          await apiRequest("PATCH", "/v1/billing/settings", { spend_cap_cents: null });
          return { content: [{ type: "text" as const, text: `**Spend cap removed.** There is no monthly spending limit. Agents can spend without a cap.` }] };
        }
        if (spend_cap_dollars !== undefined || alert_threshold_pct !== undefined) {
          const body: any = {};
          if (spend_cap_dollars !== undefined) body.spend_cap_cents = Math.round(spend_cap_dollars * 100);
          if (alert_threshold_pct !== undefined) body.alert_threshold_pct = alert_threshold_pct;
          await apiRequest("PATCH", "/v1/billing/settings", body);
          let text = `**Spend cap updated.**\n`;
          if (spend_cap_dollars !== undefined) text += `Monthly limit: $${spend_cap_dollars}\n`;
          if (alert_threshold_pct !== undefined) text += `Alert at: ${alert_threshold_pct}% of cap\n`;
          text += `\nPurchases that would exceed this cap are automatically rejected.`;
          return { content: [{ type: "text" as const, text }] };
        }
        // Read current
        const balance = await apiRequest("GET", "/v1/billing/balance");
        const cap = balance.spend_cap_cents;
        const threshold = balance.alert_threshold_pct || 80;
        if (!cap) {
          return { content: [{ type: "text" as const, text: `**No spend cap set.** There is currently no monthly spending limit. Use \`firestarter_spend_cap\` with \`spend_cap_dollars\` to set one.` }] };
        }
        return { content: [{ type: "text" as const, text: `**Monthly spend cap: $${(cap / 100).toFixed(2)}**\nAlert threshold: ${threshold}%\n\nPurchases that would exceed $${(cap / 100).toFixed(2)} in a calendar month are automatically rejected.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error managing spend cap: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_receipt
  server.tool(
    "firestarter_receipt",
    "Get the payment receipt for an order the buyer has already paid for (after firestarter_approve completed). Returns an itemized breakdown — item, subtotal, shipping, tax, total — plus payment method and date, suitable for expense or invoice records. Use whenever the buyer asks for a receipt, invoice, proof of payment, or expense documentation. If the order hasn't been paid yet, there's no receipt: check firestarter_status instead. For delivery progress use firestarter_track_order; to send the item back use firestarter_return.",
    {
      execution_id: z.string().describe("The execution/order ID to get a receipt for (exec_...)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ execution_id }) => {
      try {
        const data = await apiRequest("GET", `/v1/executions/${execution_id}/receipt`);
        let text = `**Receipt — Order ${execution_id}**\n`;
        text += `Date: ${data.paid_at || data.created_at || "N/A"}\n`;
        if (data.product_title) text += `Item: ${data.product_title}\n`;
        if (data.subtotal_cents != null) text += `Subtotal: $${(data.subtotal_cents / 100).toFixed(2)}\n`;
        if (data.shipping_cents != null && data.shipping_cents > 0) text += `Shipping: $${(data.shipping_cents / 100).toFixed(2)}\n`;
        if (data.tax_cents != null && data.tax_cents > 0) text += `Tax: $${(data.tax_cents / 100).toFixed(2)}\n`;
        if (data.total_cents != null) text += `**Total: $${(data.total_cents / 100).toFixed(2)}**\n`;
        if (data.payment_method) text += `Paid with: ${data.payment_method}\n`;
        if (data.stripe_charge_id) text += `Transaction: ${data.stripe_charge_id}\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error fetching receipt: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_auto_approve_limit
  server.tool(
    "firestarter_auto_approve_limit",
    "Read or set the buyer's PERSISTENT, account-level auto-approval limit for purchases. This is a real stored account setting (not a chat note or session memory): orders whose total is at or below the limit are auto-approved and paid without a manual confirmation step, and anything above pauses for approval. It applies to EVERY future order on the account, across all surfaces (chat, dashboard, API), until changed. Call with NO arguments to report the current limit. To change it, pass set_limit_usd (e.g. 50 for '$50 per order'; 0 makes every order require manual approval) OR disable=true to turn auto-approval off entirely. The maximum limit is $10,000. Always confirm the exact dollar amount with the buyer before setting it — never invent, assume, or round a value the buyer did not state. Only report success after this tool returns a confirmation.",
    {
      set_limit_usd: z
        .number()
        .min(0)
        .max(10_000)
        .optional()
        .describe("New auto-approve limit in USD. Orders at or below this amount auto-approve; anything above pauses for approval. 0 = require manual approval for every order. Omit to just read the current setting."),
      disable: z
        .boolean()
        .optional()
        .describe("Set true to turn OFF auto-approval entirely (every order requires manual approval). Mutually exclusive with set_limit_usd."),
    },
    // Mutates a PERSISTENT account-level billing setting (overwrites the prior
    // value), so it is destructive in the MCP sense; re-setting the same value
    // is a no-op, hence idempotent.
    { destructiveHint: true, idempotentHint: true },
    async ({ set_limit_usd, disable }) => {
      try {
        // No mutation requested → report the currently persisted limit.
        if (set_limit_usd === undefined && !disable) {
          const bal = await apiRequest("GET", "/v1/billing/balance");
          const cents = bal.auto_approve_threshold_cents;
          // null = auto-approval turned OFF; 0 = a configured $0 limit (nothing
          // auto-approves). Report them distinctly so a buyer who explicitly set
          // $0 isn't told the feature is "OFF".
          const text =
            cents == null
              ? "Auto-approval is OFF — every order requires your manual approval."
              : cents === 0
                ? "Your auto-approval limit is $0.00 per order — every order requires your manual approval."
                : `Your auto-approval limit is $${(cents / 100).toFixed(2)} per order. Orders at or below this auto-approve; anything above pauses for your approval.`;
          return { content: [{ type: "text" as const, text }] };
        }

        if (set_limit_usd !== undefined && disable) {
          return {
            content: [{ type: "text" as const, text: "Pass either set_limit_usd or disable, not both." }],
            isError: true,
          };
        }

        // Reject sub-cent precision instead of silently rounding — the buyer's
        // stated figure must map exactly to whole cents (e.g. 49.99, not 49.999).
        if (set_limit_usd !== undefined) {
          const rawCents = set_limit_usd * 100;
          if (Math.abs(rawCents - Math.round(rawCents)) > 1e-6) {
            return {
              content: [{ type: "text" as const, text: "set_limit_usd must be a whole-cent amount (at most 2 decimal places, e.g. 49.99). Confirm the exact figure with the buyer before setting it." }],
              isError: true,
            };
          }
        }

        const auto_approve_threshold_cents = disable ? null : Math.round((set_limit_usd as number) * 100);
        await apiRequest("PATCH", "/v1/billing/settings", { auto_approve_threshold_cents });

        const text =
          auto_approve_threshold_cents == null
            ? "Auto-approval is now OFF. Every order will pause for your manual approval."
            : auto_approve_threshold_cents === 0
              ? "Auto-approval limit set to $0 — every order will require your manual approval."
              : `Auto-approval limit saved: $${(auto_approve_threshold_cents / 100).toFixed(2)} per order. Orders at or below this go through automatically; anything above pauses for your approval. This applies to all future orders until you change it.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error updating auto-approval limit: ${toErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: firestarter_message
  server.tool(
    "firestarter_message",
    "Send a follow-up message to an active execution. Use this to refine the search, change requirements, or ask questions about the options.",
    {
      execution_id: z.string().describe("The execution ID to message"),
      message: z.string().describe("Follow-up message (e.g. 'I prefer organic options' or 'Can you find something cheaper?')"),
    },
    async ({ execution_id, message }) => {
      try {
        await apiRequest("POST", `/v1/executions/${execution_id}/message`, { message });
        const exec = await pollExecution(apiRequest, execution_id, 30_000);
        return { content: await formatExecution(exec) };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_watch
  server.tool(
    "firestarter_watch",
    "Create a price/stock monitor that watches products on a schedule. Get notified via webhook when prices drop, items restock, or new listings appear.",
    {
      name: z.string().describe("Name for this monitor (e.g. 'AirPods price watch')"),
      query: z.string().describe("What to watch — natural language (e.g. 'AirPods Pro 2 under $200')"),
      schedule: z.string().optional().describe("How often to check: 'hourly', 'daily', 'daily at 9am', 'every 6 hours', or a cron expression. Default: 'daily'"),
      price_drop_pct: z.number().optional().describe("Minimum price drop percentage to notify (e.g. 10 = notify on 10%+ drops)"),
      goal: z.string().optional().describe("Natural language goal for AI-powered meaningful change detection (e.g. 'price drops below $180')"),
      webhook_url: z.string().optional().describe("Webhook URL to receive change notifications"),
    },
    async ({ name, query, schedule, price_drop_pct, goal, webhook_url }) => {
      try {
        const body: any = { name, type: "product", targets: [{ query }], schedule: schedule || "daily", conditions: {} };
        if (price_drop_pct) body.conditions.price_drop_pct = price_drop_pct;
        if (goal) body.goal = goal;
        if (webhook_url) body.notifications = { webhook: { url: webhook_url } };
        const monitor = await apiRequest("POST", "/v1/monitors", body);
        return {
          content: [{
            type: "text" as const,
            text: `**Monitor created: ${monitor.name}**\nID: ${monitor.id}\nSchedule: ${monitor.schedule} (${monitor.schedule_cron})\nNext check: ${monitor.next_check_at}\n${goal ? `Goal: ${goal}\n` : ""}\nUse \`firestarter_watches\` to see all active monitors.`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error creating monitor: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_watches
  server.tool(
    "firestarter_watches",
    "List active monitors and their recent check results. Shows what you're watching, last check status, and any recent price changes or alerts.",
    {
      monitor_id: z.string().optional().describe("Get details for a specific monitor ID. Omit to list all monitors."),
      include_checks: z.boolean().optional().describe("Include recent check history (default: true for single monitor, false for list)"),
    },
    async ({ monitor_id, include_checks }) => {
      try {
        if (monitor_id) {
          const monitor = await apiRequest("GET", `/v1/monitors/${monitor_id}`);
          const checks = include_checks !== false
            ? await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=5`)
            : null;
          let text = `**${monitor.name}** [${monitor.status}]\nType: ${monitor.type} | Schedule: ${monitor.schedule}\nTargets: ${monitor.targets.map((t: any) => t.query).join(", ")}\n`;
          if (monitor.goal) text += `Goal: ${monitor.goal}\n`;
          if (monitor.last_check_at) text += `Last check: ${monitor.last_check_at}\n`;
          if (monitor.next_check_at) text += `Next check: ${monitor.next_check_at}\n`;
          if (checks?.checks?.length > 0) {
            text += "\n**Recent checks:**\n";
            for (const chk of checks.checks) {
              const s = chk.summary || {};
              text += `- ${chk.completed_at || chk.created_at}: ${chk.status}`;
              if (s.price_drops) text += ` | ${s.price_drops} price drop(s)`;
              if (s.new_listings) text += ` | ${s.new_listings} new listing(s)`;
              text += ` | ${s.products_checked || 0} products checked\n`;
              if (chk.changes?.length > 0) {
                for (const c of chk.changes.slice(0, 3)) {
                  text += `  ${c.status}: ${c.product}`;
                  if (c.previous_price && c.current_price) text += ` $${c.previous_price} → $${c.current_price}`;
                  if (c.drop_pct) text += ` (-${c.drop_pct}%)`;
                  if (c.judgment?.meaningful) text += ` ✓ ${c.judgment.reason}`;
                  text += "\n";
                }
              }
            }
          }
          return { content: [{ type: "text" as const, text }] };
        }
        const data = await apiRequest("GET", "/v1/monitors");
        const monitors = data.monitors || [];
        if (monitors.length === 0) {
          return { content: [{ type: "text" as const, text: "No monitors set up yet. Use `firestarter_watch` to create one." }] };
        }
        const lines = [`**Active Monitors** (${monitors.length})\n`];
        for (const m of monitors) {
          lines.push(`- **${m.name}** [${m.status}] — ${m.schedule}`);
          lines.push(`  ID: ${m.id} | Targets: ${m.targets.map((t: any) => t.query).join(", ")}`);
          if (m.last_check_at) lines.push(`  Last check: ${m.last_check_at}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_unwatch
  server.tool(
    "firestarter_unwatch",
    "Pause or delete a monitor. Paused monitors can be resumed later; deleted monitors are permanent.",
    {
      monitor_id: z.string().describe("The monitor ID to pause or delete"),
      action: z.enum(["pause", "resume", "delete"]).describe("Action to take: pause (stop checks, keep history), resume (restart checks), delete (permanent)"),
    },
    async ({ monitor_id, action }) => {
      try {
        if (action === "delete") {
          await apiRequest("DELETE", `/v1/monitors/${monitor_id}`);
          return { content: [{ type: "text" as const, text: `Monitor ${monitor_id} deleted.` }] };
        }
        const result = await apiRequest("POST", `/v1/monitors/${monitor_id}/${action}`);
        return { content: [{ type: "text" as const, text: `Monitor ${monitor_id} ${action}d. Status: ${result.status}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_check
  server.tool(
    "firestarter_check",
    "Trigger an immediate check on a monitor. Runs the product search and diff right now instead of waiting for the next scheduled check.",
    {
      monitor_id: z.string().describe("The monitor ID to check now"),
    },
    async ({ monitor_id }) => {
      try {
        await apiRequest("POST", `/v1/monitors/${monitor_id}/run`);
        const pollStart = Date.now();
        let latest: any = null;
        while (Date.now() - pollStart < 8_000) {
          const checks = await apiRequest("GET", `/v1/monitors/${monitor_id}/checks?limit=1`);
          latest = checks.checks?.[0];
          if (latest && latest.status !== "queued" && latest.status !== "running") break;
          await new Promise((r) => setTimeout(r, 800));
        }
        if (!latest || latest.status === "queued" || latest.status === "running") {
          return { content: [{ type: "text" as const, text: `Check queued for monitor ${monitor_id}. It may take a minute to complete. Use \`firestarter_watches\` to see results.` }] };
        }
        const s = latest.summary || {};
        let text = `**Check completed** for monitor ${monitor_id}\nProducts checked: ${s.products_checked || 0}\nPrice drops: ${s.price_drops || 0} | New listings: ${s.new_listings || 0}\n`;
        if (latest.changes?.length > 0) {
          text += "\n**Changes detected:**\n";
          for (const c of latest.changes) {
            text += `- ${c.status}: ${c.product}`;
            if (c.previous_price && c.current_price) text += ` $${c.previous_price} → $${c.current_price}`;
            if (c.drop_pct) text += ` (-${c.drop_pct}%)`;
            if (c.judgment) text += c.judgment.meaningful ? ` ✓ ${c.judgment.reason}` : ` ○ ${c.judgment.reason}`;
            text += "\n";
          }
        } else {
          text += "\nNo changes detected since last check.";
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_upload_image
  // Accepts a base64-encoded image from the conversation and persists it to the
  // Firestarter image store, returning a public URL the agent can then pass to
  // firestarter_list / firestarter_update_listing (image_urls) or firestarter_import (photo_urls).
  server.tool(
    "firestarter_upload_image",
    "Upload a product photo the seller sent in this conversation and get back a permanent public URL. Call this FIRST when the seller provides a photo (attached image), then pass the returned URL into firestarter_list or firestarter_update_listing image_urls. Accepts a base64-encoded image (data-URI format: 'data:image/jpeg;base64,...'). Max 6 MB. Returns the hosted URL on success.",
    {
      image_base64: z.string().describe("The image as a base64 data-URI string (e.g. 'data:image/jpeg;base64,/9j/4AAQ...'). If the client provides raw base64 without the data-URI prefix, prepend 'data:image/jpeg;base64,' before passing it here."),
      filename: z.string().optional().describe("Optional original filename (used to detect format: png, webp, gif). Defaults to jpeg if omitted."),
    },
    async ({ image_base64, filename }) => {
      try {
        const base64Part = String(image_base64).includes(",") ? String(image_base64).split(",", 2)[1] : String(image_base64);
        const normalized = base64Part.replace(/\s+/g, "");
        const padding = (normalized.match(/=+$/)?.[0].length ?? 0);
        const approxBytes = Math.floor((normalized.length * 3) / 4) - padding;
        const MAX_BYTES = 6 * 1024 * 1024;
        if (approxBytes > MAX_BYTES) {
          return {
            content: [{ type: "text" as const, text: `Error: image is too large (${(approxBytes / 1024 / 1024).toFixed(1)} MB). Max is 6 MB.` }],
            isError: true,
          };
        }

        const res = await apiRequest("POST", "/seller/products/upload-image", {
          image_base64,
          filename,
        });
        const url = (res as any)?.url;
        if (!url) {
          return { content: [{ type: "text" as const, text: "Error: image upload returned no URL. The image may be invalid or too large (max 6 MB)." }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `✅ Image uploaded successfully.\n\nHosted URL: ${url}\n\nUse this URL in the \`image_urls\` array when calling firestarter_list or firestarter_update_listing.` }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        return { content: [{ type: "text" as const, text: `Error uploading image: ${msg}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_register_seller
  server.tool(
    "firestarter_register_seller",
    "Register the current account as a seller on Firestarter. This is required BEFORE the seller can create listings (firestarter_list), import products (firestarter_import), or connect a store (firestarter_connect_shopify). Only requires a business_name. If firestarter_list or firestarter_import returns NO_SELLER_PROFILE, call this first, then retry the original tool immediately. Idempotent: if the account is already a seller, returns the existing profile without error. After registration the seller can immediately list products - payouts (firestarter_payouts) can be set up later.",
    {
      business_name: z.string().describe("REQUIRED. The seller's business or brand name, e.g. \"Tania's Art Studio\" or \"QuickShip Electronics\"."),
      type: z.enum(["retailer", "wholesaler", "manufacturer", "reseller"]).optional().describe("Optional. Seller type. Defaults to 'retailer'. Only ask if the seller mentions they're a wholesaler/manufacturer."),
    },
    async ({ business_name, type }) => {
      try {
        const body: any = { business_name };
        if (type) body.type = type;
        const seller = await apiRequest("POST", "/v1/sellers", body);
        let text = `**Seller profile created!**\n`;
        text += `ID: \`${seller.id}\`\n`;
        text += `Business: ${seller.business_name}\n`;
        text += `Type: ${seller.type || "retailer"}\n`;
        text += `Status: ${seller.status}\n`;
        text += `\nYou can now:\n`;
        text += `- Create listings with \`firestarter_list\` (just product_name + base_price)\n`;
        text += `- Import existing listings with \`firestarter_import\`\n`;
        text += `- Connect a Shopify store with \`firestarter_connect_shopify\`\n`;
        text += `\n**Important:** Connect Stripe payouts with \`firestarter_payouts\` so buyers can actually purchase your listings. Without it, listings are visible but show as "browse-only" (checkout blocked). Takes ~2 minutes.\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // Already a seller → treat as success (idempotent)
        if (err instanceof ApiError && err.code === "SELLER_EXISTS") {
          // Fetch the existing profile to show it
          try {
            const existing = await apiRequest("GET", "/v1/sellers");
            let text = `**Already registered as a seller.**\n`;
            text += `ID: \`${existing.id}\`\n`;
            text += `Business: ${existing.business_name}\n`;
            text += `Type: ${existing.type || "retailer"}\n`;
            text += `Status: ${existing.status}\n`;
            text += `\nReady to list products with \`firestarter_list\` or import with \`firestarter_import\`.`;
            return { content: [{ type: "text" as const, text }] };
          } catch {
            return { content: [{ type: "text" as const, text: "**Already registered as a seller.** Ready to list products with `firestarter_list`." }] };
          }
        }
        return { content: [{ type: "text" as const, text: `Error registering seller: ${msg}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_list
  server.tool(
    "firestarter_list",
    "List (create) a product for sale on Firestarter. ONLY two fields are required: product_name and base_price (USD). Everything else is OPTIONAL with sensible defaults — do NOT interrogate the seller for category, inventory, shipping, or ship-from. Create the listing immediately with what you have, then tell them what defaulted and how to refine it. Defaults when omitted: inventory unlimited, shipping = network default ($9.99, free over $50), ship-from = account default address, ships worldwide (cross-border buyers get a duties disclosure; restrict with shipping_policy). If the seller already sent a photo in the conversation, reuse that URL in image_urls — never ask them to re-send it. The listing goes live instantly unless something blocks activation (e.g. payouts not connected), in which case it's saved as a draft and the response lists exactly what to fix. To VIEW or edit listings you already have, use firestarter_listings / firestarter_update_listing instead; to BROWSE other sellers' products, use firestarter_catalog_search.",
    {
      product_name: z.string().describe("REQUIRED. What's being sold, e.g. 'Logitech MX Master 3S Wireless Mouse'."),
      base_price: z.number().describe("REQUIRED. Sale price in USD, e.g. 49.99."),
      category: z.string().optional().describe("Optional. Product category (e.g. 'electronics/audio/earbuds'). Infer a reasonable one from the product name if obvious; otherwise omit — don't ask."),
      floor_price: z.number().optional().describe("Never sell below this price"),
      ceiling_price: z.number().optional().describe("Never surge above this price"),
      dynamic_pricing: z.boolean().optional().describe("Enable demand-based pricing"),
      inventory_qty: z.number().optional().describe("Optional. Available quantity. Omit for unlimited — don't ask the seller unless they mention stock limits."),
      image_urls: z.array(z.string()).optional().describe("Public product photo URLs (first is the primary image). If the seller attached a photo in this conversation, call firestarter_upload_image FIRST to get a hosted URL, then pass it here. Never ask them to re-send a photo already in the conversation."),
      shipping: z.number().optional().describe("Shipping price in USD. Omit to use the network default ($9.99, free over $50). Set to 0 for free shipping."),
      ship_from: z.object({
        street1: z.string(),
        street2: z.string().optional(),
        city: z.string(),
        state: z.string(),
        zip: z.string(),
        country: z.string().optional(),
      }).optional().describe("Ship-from (origin) address — where this item ships FROM. Used to compute real shipping rates (#332). Omit to use your account's default fulfillment address."),
      shipping_policy: z.object({
        mode: z.enum(["domestic", "list", "worldwide"]),
        countries: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      }).optional().describe("Where the seller is willing to ship this item. Omit to default to WORLDWIDE (ships anywhere the platform hard rules allow; cross-border buyers are shown a duties disclosure). mode 'domestic' = home country only; mode 'list' with countries:['CA','GB',...] = home country plus those ISO alpha-2 destinations; mode 'worldwide' (optionally exclude:['BR',...]) = everywhere except excluded codes. Sanctioned/embargoed destinations are always blocked regardless of this setting."),
    },
    async ({ product_name, base_price, category, floor_price, ceiling_price, dynamic_pricing, inventory_qty, image_urls, shipping, ship_from, shipping_policy }) => {
      try {
        const body: any = { product_name, base_price };
        if (category) body.category = category;
        if (floor_price !== undefined) body.floor_price = floor_price;
        if (ceiling_price !== undefined) body.ceiling_price = ceiling_price;
        if (dynamic_pricing !== undefined) body.dynamic_pricing = dynamic_pricing;
        if (inventory_qty !== undefined) body.inventory_qty = inventory_qty;
        if (image_urls?.length) body.images = image_urls;
        if (shipping !== undefined) body.shipping = shipping;
        if (ship_from) body.ship_from = ship_from;
        if (shipping_policy) body.shipping_policy = shipping_policy;
        const listing = await apiRequest("POST", "/v1/listings", body);
        let text = `**Listing created: ${listing.product_name}**\nID: \`${listing.id}\`\nStatus: ${listing.status || "active"}\nBase price: $${listing.base_price}\n`;
        if (listing.floor_price) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing) text += `Dynamic pricing: enabled\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        if (listing.shipping != null) text += `Shipping: $${listing.shipping.toFixed(2)} (seller-set)\n`;
        else text += `Shipping: network default ($9.99, free over $50)\n`;
        if (Array.isArray(listing.images) && listing.images.length) text += `Photos: ${listing.images.length} attached\n`;
        // Surface activation blocks so the seller knows WHY the listing is a
        // draft and what to do about it — without this the agent just says
        // "Status: draft" and the seller is stuck.
        if (listing.status === "draft" && Array.isArray(listing.activation_blocked) && listing.activation_blocked.length > 0) {
          text += `\n**This listing is saved as a draft.** Resolve the following before it can go live:\n`;
          for (const block of listing.activation_blocked) {
            text += `- ${block.message}\n`;
          }
          text += `\nOnce resolved, activate with \`firestarter_update_listing\` (status "active").`;
        } else if (listingShareUrl(listing)) {
          text += `Share link: ${listingShareUrl(listing)}\n`;
          text += `\nPaste the share link bare in chat — it unfurls into a product card, humans see "ask your AI agent to buy this", and any agent that opens it gets purchase instructions. Buyers' agents also discover this via network search. Use \`firestarter_listings\` to view it anytime.`;
        } else {
          text += `\n**Sandbox-only listing.** No public share link is created in test mode. It remains available through test-mode catalog and listing tools.`;
        }
        // No photo on the listing → give a concrete way to add one. A photo the
        // seller attached in chat can't be forwarded into the listing (MCP tool
        // args are JSON URLs only; the client never uploads the file), so deep
        // link straight to this listing's uploader in the seller dashboard.
        if (!(Array.isArray(listing.images) && listing.images.length)) {
          // Build via URL so a base with an existing query string / trailing
          // path still yields a valid, encoded link (never `...?a=b?edit=`).
          const uploaderUrl = new URL(SELLER_DASHBOARD_URL);
          uploaderUrl.searchParams.set("edit", String(listing.id));
          text += `\n\n📷 **Add a photo.** Send a photo in this chat and I'll upload it with \`firestarter_upload_image\`, then attach the URL to your listing. Or open ${uploaderUrl.toString()} to drag-and-drop directly in the dashboard.`;
        }
        // Surface payout warnings — listing is active but seller should
        // connect Stripe to actually receive earnings.
        if (Array.isArray(listing.activation_warnings) && listing.activation_warnings.length > 0) {
          for (const warn of listing.activation_warnings) {
            if (warn.code === "SELLER_PAYOUTS_RECOMMENDED") {
              text += `\n\n⚠️ **Payouts not connected — buyers cannot purchase this listing yet.** The listing is visible in search, but checkout is blocked until Stripe payouts are set up. Call \`firestarter_payouts\` now to get a setup link (takes ~2 minutes).`;
            }
          }
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // The REST 403 carries code NO_SELLER_PROFILE but its message is a plain
        // sentence ("No active seller profile found...") - matching only the
        // code token in the message missed it, so the agent got a bare error
        // and looped (re-asking for details / "ran into an issue"). Detect via
        // the structured code (phrasing as a fallback) and route to the chat
        // seller-setup funnel the agent's skill knows.
        const noSeller =
          (err instanceof ApiError && err.code === "NO_SELLER_PROFILE") ||
          /no active seller profile/i.test(msg) ||
          msg.includes("NO_SELLER_PROFILE");
        const code = err instanceof ApiError ? err.code : undefined;
        // #489: give the agent a concrete next step per error code instead of a
        // bare "Error creating listing" it relays as "I ran into an issue" (which
        // makes it loop or re-ask for product details it already has).
        let hint = "";
        if (noSeller) {
          hint = "\n\nNO_SELLER_PROFILE: no seller profile exists on this Firestarter org. Call `firestarter_register_seller` with the seller's business name to create one, then retry this listing immediately — do NOT ask for details again. If they already have an active web seller account on a different org, ask them to open the seller dashboard, generate a Link Code, and paste it to relink this chat identity.";
        } else if (code === "DUPLICATE_LISTING" || /duplicate listing/i.test(msg)) {
          hint = "\n\nDUPLICATE_LISTING: this seller already has a listing with that name. Do NOT re-ask for details - either update the existing one (find it with firestarter_listings) or, if they genuinely want a second listing, retry with allow_duplicate: true.";
        } else if (code === "PROHIBITED_ITEM" || /prohibited/i.test(msg)) {
          hint = "\n\nPROHIBITED_ITEM: this item can't be listed on Firestarter. Relay the reason above to the seller plainly and do NOT retry.";
        }
        return { content: [{ type: "text" as const, text: `Error creating listing: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_import
  // A2: the Cole-chat seller claim funnel. Wraps POST /v1/listings/import -
  // the draft is reviewed in chat, then activated via firestarter_update_listing.
  server.tool(
    "firestarter_import",
    "Import a seller's EXISTING listing from another marketplace (Craigslist, Gumtree, their own site) into Firestarter. Give it the listing URL, or pasted listing text plus photo URLs, and it creates a DRAFT listing for the seller to review - not live, not buyable, no share link yet. Amazon, Walmart, eBay, Etsy, Facebook Marketplace, OfferUp and Mercari block server fetches: for those, do NOT send the URL - ask the seller to copy-paste the listing text and photo URLs instead. Other sites that block return PLATFORM_BLOCKED or EXTRACTION_EMPTY - when that happens, ask the seller to paste the listing text and photos. Activation (firestarter_update_listing, status 'active') requires a positive price (firestarter_reprice if the import found none) and at least one photo.",
    {
      source_url: z.string().optional().describe("URL of the seller's existing listing (e.g. a Craigslist post). Omit for blocked platforms - paste text instead."),
      raw_text: z.string().optional().describe("Pasted listing text (title, price, description - at least 10 characters). Required when source_url is omitted or blocked; also fills gaps URL extraction missed."),
      photo_urls: z.array(z.string()).optional().describe("Photo URLs for the listing, e.g. image links the seller pasted in chat. Seller photos lead the images array."),
    },
    async ({ source_url, raw_text, photo_urls }) => {
      try {
        const body: any = {};
        if (source_url) body.source_url = source_url;
        if (raw_text) body.raw_text = raw_text;
        if (photo_urls && photo_urls.length > 0) body.photo_urls = photo_urls;
        // Import does a server-side page fetch (10s cap) + LLM extraction -
        // give it more headroom than the default API budget.
        const draft = await apiRequest("POST", "/v1/listings/import", body, IMPORT_TIMEOUT_MS);

        let text = `**Draft imported: ${draft.product_name}**\nID: \`${draft.id}\`\nStatus: draft (NOT live - buyers cannot see or buy it yet)\n`;
        text += Number(draft.base_price) > 0
          ? `Price: $${draft.base_price} ${draft.currency}\n`
          : `Price: none found - set one with firestarter_reprice before activating\n`;
        if (draft.category) text += `Category: ${draft.category}\n`;
        if (draft.condition) text += `Condition: ${draft.condition}\n`;
        if (draft.description) {
          const d = String(draft.description);
          text += `Description: ${d.slice(0, 200)}${d.length > 200 ? "..." : ""}\n`;
        }
        text += `Photos: ${Array.isArray(draft.images) ? draft.images.length : 0}\n`;
        if (Array.isArray(draft.needs_review) && draft.needs_review.length > 0) {
          text += `Needs review (extraction was uncertain or found nothing): ${draft.needs_review.join(", ")}\n`;
        }
        if (draft.verification?.status === "required") {
          const why = draft.verification.reason === "source_conflict"
            ? "this source URL was already imported by another seller"
            : String(draft.verification.reason || "verification required");
          text += `Heads-up: possession verification will be required at activation (${why}). The seller will get an FS-XXXX code to write by hand and photograph next to the item.\n`;
        }
        text += `\nNext steps:\n`;
        text += `1. Walk the seller through the draft - fix details with firestarter_update_listing, set or adjust the price with firestarter_reprice.\n`;
        text += `2. Check payouts with firestarter_payouts - the listing can go live without it, but earnings are held until the seller's Stripe payouts are connected.\n`;
        text += `3. Only after the seller confirms it looks right: firestarter_update_listing with status "active". High-value (>= $500) and luxury-category items will ask for a possession photo first - relay the code instructions, then submit the seller's photo with firestarter_verify. Once active, it becomes buyable and gets its share link.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        let hint = "";
        if (/blocks server-side fetches/i.test(msg)) {
          hint = "\n\nThat platform cannot be fetched. Ask the seller to copy-paste the listing text (title, price, description) and photo URLs into chat, then call firestarter_import again with raw_text + photo_urls.";
        } else if ((err instanceof ApiError && err.code === "NO_SELLER_PROFILE") || /no active seller profile/i.test(msg) || msg.includes("NO_SELLER_PROFILE")) {
          hint = "\n\nNO_SELLER_PROFILE: no seller profile exists on this Firestarter org. Call `firestarter_register_seller` with the seller's business name to create one, then retry this import immediately. If they already have an active web seller account on a different org, have them generate a Link Code in the seller dashboard and paste it to relink this chat identity.";
        } else if (/could not fetch/i.test(msg)) {
          hint = "\n\nAsk the seller to paste the listing text directly into chat and retry with raw_text.";
        }
        return { content: [{ type: "text" as const, text: `Error importing listing: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_request_escrow
  // B1: the buyer-side counterpart of firestarter_import. The user found a
  // listing on an EXTERNAL site and wants Firestarter escrow protection - we
  // mint a claim link, but THE BUYER delivers it to the seller themselves.
  server.tool(
    "firestarter_request_escrow",
    "BUYER-side tool: the user found a listing on another site (Craigslist, Facebook Marketplace, Gumtree, ...) and wants to pay through Firestarter escrow instead of cash/wire. Creates an escrow invite with a claim link for the SELLER, plus a ready-to-send message. The buyer must send that message to the seller themselves through the platform where they found the listing - Firestarter never contacts external sellers, and neither should you (never automate messages to Craigslist or marketplace posters). Needs the listing URL and the buyer's email (ask for it - that is where the goes-live notification lands). For Facebook Marketplace / eBay / Etsy / OfferUp / Mercari the page cannot be fetched, so also ask for the item title and price and pass them along.",
    {
      source_url: z.string().describe("URL of the external listing the buyer wants to purchase"),
      buyer_email: z.string().describe("Buyer's email address - notified when the seller claims and the listing goes live"),
      buyer_name: z.string().optional().describe("Buyer's first name (shown to the seller on the claim page)"),
      title: z.string().optional().describe("Item title, buyer-supplied. Required in practice for platforms that block fetches (Facebook Marketplace etc.)."),
      price: z.number().optional().describe("Asking price in the listing's currency, buyer-supplied (for blocked platforms)"),
    },
    async ({ source_url, buyer_email, buyer_name, title, price }) => {
      try {
        const body: any = { source_url, buyer_email };
        if (buyer_name) body.buyer_name = buyer_name;
        if (title) body.title = title;
        if (price !== undefined) body.price = price;
        // May fetch + extract the external page - same headroom as import.
        const r = await apiRequest("POST", "/v1/escrow-invites", body, IMPORT_TIMEOUT_MS);

        if (r.already_listed) {
          let text = `**Good news - this item is already live on Firestarter.**\n`;
          if (r.title) text += `Item: ${r.title}\n`;
          text += `Share link: ${r.share_url}\n\nNo invite needed - the buyer can pay through escrow right now from that link.`;
          return { content: [{ type: "text" as const, text }] };
        }

        let text = `**Escrow request created${r.item?.title ? `: ${r.item.title}` : ""}**\n`;
        if (r.item?.price) text += `Price: $${r.item.price}${r.item.currency ? ` ${r.item.currency}` : ""}\n`;
        text += `Claim link (for the seller): ${r.claim_url}\nExpires: ${r.expires_at}\n\n`;
        text += `**The buyer must send the seller this message themselves** - through the same place they found the listing (Craigslist reply email, Facebook Messenger, ...). Do not contact the seller for them. Suggested message:\n\n`;
        text += `${r.suggested_message}\n\n`;
        text += `What happens next: the seller claims the link, proves possession (photo of the item next to a handwritten code), the listing goes live, and the buyer gets an email at ${buyer_email} with the payment link. Funds are held in escrow until handoff.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // Error CODES ride on ApiError.code, never inside the message string.
        const code: string = err?.code ?? "";
        let hint = "";
        if (code === "INVALID_BUYER_EMAIL") {
          hint = "\n\nAsk the buyer for a valid email address - it is where the goes-live notification lands.";
        } else if (code === "INVALID_URL") {
          hint = "\n\nThe listing URL was rejected. Ask the buyer to copy the full address bar URL of the listing.";
        } else if (msg.includes("Too many requests")) {
          hint = "\n\nRate limit hit - wait a bit before creating another escrow request.";
        }
        return { content: [{ type: "text" as const, text: `Error creating escrow request: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_assist_quote
  // B4 Phase 3: price a courier crew (load + haul + unload) for a bulky item.
  // PURE QUOTE - nothing booked, no money. Booking is a separate tool so a
  // human always confirms the price first.
  server.tool(
    "firestarter_assist_quote",
    "Get pickup+delivery quotes for a PHYSICAL item, including loading/unloading help (a courier crew) for bulky or heavy things - weight racks, sofas, appliances. Use when a buyer or seller asks how to move an item, or proactively when an item is clearly bulky. Pure price check: books nothing, charges nothing. Include lat/lng for both stops when the user shared a location pin - some couriers (Lalamove in Thailand) cannot quote without coordinates. Returns quotes cheapest-first with a quote_ref; to actually book one, confirm the price with the human FIRST, then call firestarter_assist_book.",
    {
      pickup_address: z.string().describe("Pickup street address"),
      dropoff_address: z.string().describe("Dropoff street address"),
      pickup_lat: z.number().optional(),
      pickup_lng: z.number().optional(),
      dropoff_lat: z.number().optional(),
      dropoff_lng: z.number().optional(),
      weight_kg: z.number().optional().describe("Approximate item weight in kg"),
      bulky: z.boolean().optional().describe("Large/awkward item (furniture, gym equipment)"),
      two_person: z.boolean().optional().describe("Needs two people to carry - adds a crew helper"),
      needs_disassembly: z.boolean().optional(),
      declared_value_cents: z.number().optional().describe("Item value in cents, for courier insurance on high-value items"),
    },
    async (a) => {
      try {
        const r = await apiRequest("POST", "/v1/assist/quote", {
          pickup: { address: a.pickup_address, lat: a.pickup_lat, lng: a.pickup_lng },
          dropoff: { address: a.dropoff_address, lat: a.dropoff_lat, lng: a.dropoff_lng },
          handling: {
            weight_kg: a.weight_kg, bulky: a.bulky, two_person: a.two_person,
            needs_disassembly: a.needs_disassembly,
          },
          ...(a.declared_value_cents !== undefined ? { declared_value_cents: a.declared_value_cents } : {}),
        }, IMPORT_TIMEOUT_MS);
        if (r.enabled === false) {
          return { content: [{ type: "text" as const, text: "Fulfillment assist is not enabled on this workspace yet - the item would need to be moved by the buyer and seller themselves." }] };
        }
        if (!r.quotes?.length) {
          return { content: [{ type: "text" as const, text: "No courier could quote this route (outside coverage, or the item may be too large). Suggest the parties arrange the handoff themselves." }] };
        }
        let text = `**Courier options (cheapest first):**\n`;
        for (const q of r.quotes.slice(0, 4)) {
          const fee = (q.fee_cents / 100).toFixed(2);
          text += `- ${q.provider}: ${fee} ${q.currency}${q.vehicle_class ? ` (${q.vehicle_class}` : ""}${q.includes_helper ? " + loading crew)" : q.vehicle_class ? ")" : ""}${q.eta_minutes ? ` ~${q.eta_minutes} min` : ""}\n  quote_ref: ${q.quote_ref}\n`;
        }
        text += `\nRelay the price to the human and get an explicit YES before booking. Then call firestarter_assist_book with the chosen quote_ref. Quotes expire in minutes - re-quote if they hesitate.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error quoting assist: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_assist_book
  server.tool(
    "firestarter_assist_book",
    "Book a courier from a firestarter_assist_quote result. ONLY call after the human has explicitly confirmed the exact price - this dispatches a real crew and the fee is charged to the buyer's order. Link the purchase execution when there is one: the courier's proof-of-delivery photo then starts the escrow inspection window automatically.",
    {
      provider: z.string().describe("Provider name from the chosen quote (e.g. lalamove, nash)"),
      quote_ref: z.string().describe("quote_ref from firestarter_assist_quote"),
      pickup_address: z.string(),
      dropoff_address: z.string(),
      pickup_contact_name: z.string().optional(),
      pickup_contact_phone: z.string().optional(),
      dropoff_contact_name: z.string().optional(),
      dropoff_contact_phone: z.string().optional(),
      execution_id: z.string().optional().describe("The purchase execution this delivery fulfills (exec_...)"),
      listing_id: z.string().optional(),
      fee_cents: z.number().optional().describe("The confirmed quote fee, for the booking record"),
    },
    async (a) => {
      try {
        const r = await apiRequest("POST", "/v1/assist/book", {
          provider: a.provider,
          quote_ref: a.quote_ref,
          pickup: { address: a.pickup_address, contact_name: a.pickup_contact_name, contact_phone: a.pickup_contact_phone },
          dropoff: { address: a.dropoff_address, contact_name: a.dropoff_contact_name, contact_phone: a.dropoff_contact_phone },
          ...(a.execution_id ? { execution_id: a.execution_id } : {}),
          ...(a.listing_id ? { listing_id: a.listing_id } : {}),
          ...(a.fee_cents !== undefined ? { fee_cents: a.fee_cents } : {}),
        }, IMPORT_TIMEOUT_MS);
        let text = `**Courier booked.** Booking ${r.id} (${r.provider}, ref ${r.provider_ref})\n`;
        if (r.tracking_url) text += `Tracking: ${r.tracking_url}\n`;
        text += r.next_step;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // Error CODES ride on ApiError.code, never inside the message string.
        const hint = err?.code === "BOOKING_FAILED"
          ? "\n\nThe quote may have expired - run firestarter_assist_quote again and re-confirm with the human."
          : "";
        return { content: [{ type: "text" as const, text: `Error booking courier: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_payouts
  server.tool(
    "firestarter_payouts",
    "Manage seller payout method — REQUIRED for listings to be purchasable by buyers. Without a payout method, listings appear in search but show as 'browse-only'. Supports four providers: Stripe (46 countries), PayPal (200+ countries), Wise (80+ currencies, best for APAC), and Payoneer (190+ countries, popular with TikTok Shop/Amazon sellers). Call with no arguments to check current status. Pass `provider` to set up a new method. If the seller is outside the US/EU, suggest PayPal (easiest), Wise (best rates for APAC), or Payoneer (if they already have one from TikTok/Amazon).",
    {
      provider: z.enum(["stripe", "paypal", "wise", "payoneer"]).optional().describe("Which payout provider to set up. Omit to check current status. 'stripe' = Stripe Connect (US/EU), 'paypal' = PayPal email (global), 'wise' = Wise bank transfer (APAC/global), 'payoneer' = Payoneer (190+ countries, TikTok/Amazon sellers)."),
      country: z.string().optional().describe("ISO 3166-1 alpha-2 country code (e.g. 'TH', 'US', 'GB'). Needed for Stripe onboarding for non-US sellers."),
      paypal_email: z.string().optional().describe("PayPal email for receiving payouts. Required when provider='paypal'."),
      wise_recipient_id: z.string().optional().describe("Wise recipient ID. Required when provider='wise'. Seller creates this in their Wise account first."),
      payoneer_email: z.string().optional().describe("Payoneer account email. Required when provider='payoneer'."),
    },
    async ({ provider, country, paypal_email, wise_recipient_id, payoneer_email }) => {
      try {
        // If no provider specified, check current status
        if (!provider) {
          const status = await apiRequest("GET", "/v1/sellers/payout-method");
          let text = "";
          if (status.status === "active") {
            text = `**Payouts active** via ${status.provider.toUpperCase()}.\nDestination: ${status.masked_destination}\n\nListings are purchasable by buyers.`;
          } else if (status.provider && status.provider !== "none") {
            text = `**Payouts pending** — ${status.provider.toUpperCase()} is configured but not yet active.\nRun \`firestarter_payouts\` with \`provider: "${status.provider}"\` to complete setup.`;
          } else {
            text = `**No payout method configured.** Listings are visible but buyers cannot checkout.\n\nAvailable providers:\n- **Stripe** — 46 countries, ~5 min setup (best for US/EU)\n- **PayPal** — 200+ countries, ~2 min setup (just an email)\n- **Wise** — 80+ currencies, best rates for APAC (Thailand, Singapore, India)\n- **Payoneer** — 190+ countries, popular with TikTok Shop/Amazon sellers\n\nCall \`firestarter_payouts\` with \`provider\` set to your choice.`;
          }
          return { content: [{ type: "text" as const, text }] };
        }

        // Set up the chosen provider
        if (provider === "stripe") {
          // Existing Stripe Connect flow
          const body: Record<string, string> = {};
          if (country) body.country = country;
          const link = await apiRequest("POST", "/v1/sellers/stripe-connect", Object.keys(body).length > 0 ? body : undefined);
          let text = `**Stripe Connect setup**\n\nSend the seller this onboarding link (a secure Stripe-hosted page):\n${link.onboarding_url}\n`;
          text += `\nAfter they finish, run \`firestarter_payouts\` again to verify.`;
          return { content: [{ type: "text" as const, text }] };
        }

        if (provider === "paypal") {
          if (!paypal_email) {
            return { content: [{ type: "text" as const, text: "To set up PayPal payouts, call `firestarter_payouts` with `provider: \"paypal\"` and `paypal_email: \"seller@email.com\"`. The seller will receive payouts to that PayPal account." }] };
          }
          const result = await apiRequest("POST", "/v1/sellers/payout-method/paypal", { email: paypal_email });
          return { content: [{ type: "text" as const, text: `**PayPal payouts configured!**\nEmail: ${paypal_email}\nStatus: active\n\n${result.message}\n\nListings are now purchasable by buyers.` }] };
        }

        if (provider === "wise") {
          if (!wise_recipient_id) {
            return { content: [{ type: "text" as const, text: "To set up Wise payouts:\n1. Seller logs into wise.com and creates a recipient (their own bank account)\n2. Get the recipient ID from Wise\n3. Call `firestarter_payouts` with `provider: \"wise\"` and `wise_recipient_id: \"<id>\"`\n\nWise supports 80+ currencies with low fees — ideal for APAC sellers." }] };
          }
          const result = await apiRequest("POST", "/v1/sellers/payout-method/wise", { recipient_id: wise_recipient_id });
          return { content: [{ type: "text" as const, text: `**Wise payouts configured!**\nRecipient: ${wise_recipient_id}\nStatus: active\n\n${result.message}\n\nListings are now purchasable by buyers.` }] };
        }

        if (provider === "payoneer") {
          if (!payoneer_email) {
            return { content: [{ type: "text" as const, text: "To set up Payoneer payouts, call `firestarter_payouts` with `provider: \"payoneer\"` and `payoneer_email: \"seller@email.com\"`. Many TikTok Shop and Amazon sellers already have a Payoneer account — use the same email. Covers 190+ countries." }] };
          }
          const result = await apiRequest("POST", "/v1/sellers/payout-method/payoneer", { email: payoneer_email });
          return { content: [{ type: "text" as const, text: `**Payoneer payouts configured!**\nEmail: ${payoneer_email}\nStatus: active\n\n${result.message}\n\nListings are now purchasable by buyers.` }] };
        }

        return { content: [{ type: "text" as const, text: "Unknown provider." }], isError: true };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /no active seller profile/i.test(msg)
          ? "\n\nThe seller is not registered yet. Call `firestarter_register_seller` with their business name first, then retry."
          : "";
        return { content: [{ type: "text" as const, text: `Error managing payouts: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_connect_shopify
  server.tool(
    "firestarter_connect_shopify",
    "Connect a seller's Shopify store to Firestarter — step 1 of the Shopify flow: connect_shopify → (catalog syncs automatically) → firestarter_listings to see imported products → firestarter_sync_shopify to refresh after store edits → orders arrive via firestarter_seller_orders → firestarter_ship_order. Call with NO arguments first: if a store is already connected it returns the connection status, store name, and last sync time (and you're done); if not, it tells you to ask for the store handle. Once you have the handle, call again with shop_handle to mint a one-click install link — the seller clicks it, approves on Shopify, and their whole catalog syncs into Firestarter automatically (no tokens to paste). Use this whenever a seller mentions Shopify, wants to connect/link their store, or asks why their products aren't showing up. The store handle is the part before .myshopify.com in their Shopify admin URL (Settings > Domains > the permanent xxxxx.myshopify.com, NOT their custom domain). To force a fresh catalog pull on an already-connected store, use firestarter_sync_shopify instead.",
    {
      shop_handle: z.string().optional().describe("Optional. The seller's Shopify store handle (e.g. 'matrix-store' from matrix-store.myshopify.com). Omit on the first call to check existing connection status — only needed when no store is connected yet. Accepts the bare handle or the full myshopify.com domain (it's normalized). If the seller doesn't know it, tell them: Shopify admin > Settings > Domains > the permanent .myshopify.com address."),
    },
    async ({ shop_handle }) => {
      try {
        // Check existing connections first
        const conns = await apiRequest("GET", "/v1/connections");
        const shopifyConn = (conns.connections || []).find((c: any) => c.platform === "shopify");

        if (shopifyConn) {
          let text = `**Shopify store connected:** ${shopifyConn.shop_name || shopifyConn.shop_domain}\n`;
          text += `Status: ${shopifyConn.status}\n`;
          if (shopifyConn.last_synced_at) text += `Last catalog sync: ${shopifyConn.last_synced_at}\n`;
          if (shopifyConn.error_message) text += `Error: ${shopifyConn.error_message}\n`;
          text += `\nProducts from this store are already listed on Firestarter and discoverable by buyers' agents. View them with firestarter_listings.`;
          // #556: point the agent at the right next action instead of leaving it stuck.
          if (shopifyConn.status === "error") {
            text += `\n\nThis connection is in an error state — run firestarter_sync_shopify to retry the catalog sync. If it keeps failing, the seller may need to reconnect from the Firestarter dashboard.`;
          } else {
            text += `\nIf the seller has added or edited products in Shopify since the last sync, run firestarter_sync_shopify to pull the changes now.`;
          }
          if (shop_handle) text += `\n\n(A new store handle was provided but a store is already connected. To switch stores, the seller disconnects the current one from the Firestarter dashboard first, then call this tool again with the new handle.)`;
          return { content: [{ type: "text" as const, text }] };
        }

        // No connection — generate the install link
        if (!shop_handle) {
          return {
            content: [{
              type: "text" as const,
              text: "**No Shopify store connected.**\n\nTo connect, I need the seller's Shopify store handle - the part before `.myshopify.com` in their Shopify admin URL.\n\nThey can find it in: Shopify admin > Settings > Domains > the permanent `xxxxx.myshopify.com` address (not their custom domain).\n\nAsk the seller for their store handle and call this tool again.",
            }],
          };
        }

        // Normalize: strip .myshopify.com if they pasted the full domain
        const handle = shop_handle
          .trim()
          .toLowerCase()
          .replace(/\.myshopify\.com$/, "")
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");

        if (!handle || /[^a-z0-9-]/.test(handle)) {
          return {
            content: [{
              type: "text" as const,
              text: `"${shop_handle}" doesn't look like a valid Shopify store handle. It should be letters, numbers, and hyphens only (e.g. 'my-store'). Ask the seller to check Shopify admin > Settings > Domains for their permanent .myshopify.com address.`,
            }],
            isError: true,
          };
        }

        // Mint the install link via the API so it carries a short-lived token
        // that homes the connected store to THIS seller's org (not an orphan).
        const link = await apiRequest("POST", "/v1/sellers/shopify-connect-link", { shop: `${handle}.myshopify.com` });
        const installUrl = link.install_url as string;
        const text = [
          `**Send this link to the seller** (send it bare so it is clickable):`,
          installUrl,
          ``,
          `What happens when they click it:`,
          `1. Shopify shows "Install / Allow" (they approve product read + order write)`,
          `2. They land on the Firestarter "connected" page`,
          `3. Their catalog syncs automatically and products become discoverable`,
          `4. Paid orders flow back into their Shopify store`,
          ``,
          `The whole process takes about 10 seconds, no tokens to paste.`,
          `After they finish, call firestarter_connect_shopify again to confirm the connection.`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /no active seller profile/i.test(msg)
          ? "\n\nThe seller is not registered yet. Call `firestarter_register_seller` with their business name first, then connect Shopify."
          : "";
        return { content: [{ type: "text" as const, text: `Error checking Shopify connection: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_connect_tiktok
  server.tool(
    "firestarter_connect_tiktok",
    "Connect a seller's TikTok Shop to Firestarter so their catalog syncs and orders flow back. If a TikTok Shop is already connected, returns its status. TikTok Shop currently connects by ACCESS TOKEN (not one-click OAuth yet): the seller authorizes Firestarter in TikTok Shop Partner Center and provides their shop access token + shop id/region. Call with no arguments to check status or get setup instructions; call with access_token AND shop_domain to create the connection. Use this whenever a seller mentions TikTok Shop or wants to sync their TikTok products. NEVER display the access token back to the seller or in chat.",
    {
      access_token: z.string().optional().describe("The seller's TikTok Shop access token (from TikTok Shop Partner Center authorization). Omit to check status or get instructions. This is a secret — never echo it back."),
      shop_domain: z.string().optional().describe("The seller's TikTok Shop identifier (shop id, shop cipher, or region/store name). Required together with access_token to create the connection."),
    },
    async ({ access_token, shop_domain }) => {
      try {
        // Check existing connection first.
        const conns = await apiRequest("GET", "/v1/connections");
        const tiktokConn = (conns.connections || []).find((c: any) => c.platform === "tiktok_shop");

        if (tiktokConn) {
          let text = `**TikTok Shop connected:** ${tiktokConn.shop_name || tiktokConn.shop_domain}\n`;
          text += `Status: ${tiktokConn.status}\n`;
          if (tiktokConn.last_synced_at) text += `Last catalog sync: ${tiktokConn.last_synced_at}\n`;
          if (tiktokConn.error_message) text += `Error: ${tiktokConn.error_message}\n`;
          text += `\nProducts from this shop are listed on Firestarter and discoverable by buyers' agents.`;
          if (access_token) text += `\n\n(A new token was provided but a connection already exists. Disconnect the current TikTok Shop from the dashboard first to reconnect.)`;
          return { content: [{ type: "text" as const, text }] };
        }

        // Have both credentials → create the connection.
        if (access_token && shop_domain) {
          await apiRequest("POST", "/v1/connections", {
            platform: "tiktok_shop",
            access_token,
            shop_domain,
          });
          return {
            content: [{
              type: "text" as const,
              text: "**TikTok Shop connected.** Initial catalog sync started — products will appear on Firestarter shortly. Call firestarter_connect_tiktok again to check sync status. (For security, the access token is stored encrypted and never shown again.)",
            }],
          };
        }

        // Have a token but no shop id.
        if (access_token && !shop_domain) {
          return {
            content: [{
              type: "text" as const,
              text: "I have the access token but still need the seller's **TikTok Shop id** (shop id / shop cipher / region) to finish connecting. Ask the seller for it and call firestarter_connect_tiktok again with both access_token and shop_domain.",
            }],
          };
        }

        // No credentials — explain the token-paste setup.
        return {
          content: [{
            type: "text" as const,
            text: [
              "**No TikTok Shop connected.** TikTok Shop connects by access token (one-click OAuth is coming soon).",
              "",
              "To connect now, the seller needs to:",
              "1. Authorize Firestarter in TikTok Shop **Partner Center** (Apps > Authorization).",
              "2. Copy their **shop access token** and **shop id** (shop cipher / region).",
              "3. Give you both, then I'll connect it.",
              "",
              "Once you have them, call firestarter_connect_tiktok with `access_token` and `shop_domain`. The seller must already be registered — call `firestarter_register_seller` first if they are not.",
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        // The connections route returns 403 NO_SELLER_PROFILE / 409
        // ALREADY_CONNECTED as business errors. toErrorMessage() masks every 403
        // as a generic "auth failed" string, so branch on the error CODE first
        // to give the seller an accurate, actionable message.
        if (err?.code === "NO_SELLER_PROFILE") {
          return {
            content: [{
              type: "text" as const,
              text: "The seller isn't registered on Firestarter yet. Call `firestarter_register_seller` with their business name first, then connect TikTok Shop.",
            }],
            isError: true,
          };
        }
        if (err?.code === "ALREADY_CONNECTED") {
          return {
            content: [{
              type: "text" as const,
              text: "A TikTok Shop is already connected for this seller. Disconnect it from the dashboard before reconnecting.",
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Error connecting TikTok Shop: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_sync_shopify
  // #556: the manual re-sync step the lifecycle was missing. connect_shopify only
  // re-checks status; this actually re-pulls the catalog (POST /v1/connections/:id/sync)
  // so store edits made after the initial connect show up on Firestarter.
  server.tool(
    "firestarter_sync_shopify",
    "Re-sync a connected store's catalog into Firestarter — pulls the latest products, prices, and inventory from Shopify (or another connected platform) so changes the seller made in their store show up on Firestarter. Use this AFTER firestarter_connect_shopify, whenever the seller says they added/edited/removed products, prices look stale, a previous sync errored, or items aren't appearing. The store must already be connected (run firestarter_connect_shopify first if not). Syncing runs in the background and returns immediately — tell the seller it may take a moment, then confirm results with firestarter_listings. Read-mostly: it imports/updates Firestarter listings from the store but never changes the seller's Shopify store. By default it syncs the seller's connected Shopify store; pass connection_id to target a specific connection when several platforms are linked.",
    {
      connection_id: z.string().optional().describe("Optional. The platform connection id (conn_...) to re-sync. Omit to sync the seller's Shopify store automatically — only needed to disambiguate when the seller has connected more than one platform."),
    },
    async ({ connection_id }) => {
      try {
        const conns = await apiRequest("GET", "/v1/connections");
        const list: any[] = conns.connections || [];
        if (list.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "**No store connected.** There's nothing to sync yet. Connect the seller's Shopify store first with firestarter_connect_shopify, and the catalog syncs automatically on connect.",
            }],
            isError: true,
          };
        }

        // Resolve which connection to sync: explicit id, else the Shopify one,
        // else the single connection, else ask which.
        let conn: any;
        if (connection_id) {
          conn = list.find((c) => c.id === connection_id);
          if (!conn) {
            const known = list.map((c) => `${c.id} (${c.platform})`).join(", ");
            return {
              content: [{ type: "text" as const, text: `No connection with id ${connection_id}. Connected: ${known || "none"}.` }],
              isError: true,
            };
          }
        } else {
          const shopify = list.filter((c) => c.platform === "shopify");
          if (shopify.length === 1) {
            conn = shopify[0];
          } else if (shopify.length === 0 && list.length === 1) {
            conn = list[0];
          } else if (shopify.length > 1 || (shopify.length === 0 && list.length > 1)) {
            const known = list.map((c) => `${c.id} — ${c.shop_name || c.shop_domain} (${c.platform})`).join("\n");
            return {
              content: [{ type: "text" as const, text: `Several stores are connected — say which one to sync by passing its connection_id:\n${known}` }],
              isError: true,
            };
          } else {
            conn = shopify[0];
          }
        }

        await apiRequest("POST", `/v1/connections/${conn.id}/sync`);
        const where = conn.shop_name || conn.shop_domain || conn.platform;
        const text = [
          `**Catalog sync started for ${where}.**`,
          `Firestarter is re-pulling products, prices, and inventory from the store in the background — this can take a moment for large catalogs.`,
          `Check the results with firestarter_listings once it finishes. If products still look wrong after a sync, the seller may need to reconnect the store from the Firestarter dashboard.`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        let hint = "";
        if (/no active seller profile/i.test(msg)) {
          hint = "\n\nThe seller is not registered yet. Call `firestarter_register_seller` with their business name first, then connect Shopify with firestarter_connect_shopify.";
        } else if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.status === 404)) {
          hint = "\n\nThat store connection no longer exists. Reconnect with firestarter_connect_shopify.";
        }
        return { content: [{ type: "text" as const, text: `Error syncing catalog: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_catalog_search
  server.tool(
    "firestarter_catalog_search",
    "Search the Firestarter NETWORK catalog — products listed for sale by ALL sellers — without starting a purchase. This is the BUYER-facing browse tool: use it to see what's available before buying, compare prices, or check whether the network carries an item. Different from firestarter_listings, which only shows YOUR OWN seller listings. Each result includes a listing id (lst_...) you can pass to firestarter_execute (as listing_id) to buy it, the share link, and a `buyable` flag — buyable means it can be purchased now; browse-only means the seller hasn't enabled checkout yet (share the link instead). Results lead with buyable, cheapest first. Pass `country` to filter for items that ship to the buyer's country. test/live follows the API key's environment. Returns up to `limit` matches (default 20, max 50); when more exist the result notes it — narrow the query or raise `limit`. Read-only: never charges or changes anything.",
    {
      query: z.string().optional().describe("Free-text product search, e.g. 'leather conditioner', 'wireless earbuds under 50'. Matches product name, description, and category. Use real product nouns; omit filler words like 'cheap' or 'best'."),
      category: z.string().optional().describe("Filter by category, e.g. 'Rings', 'Accessories', 'Stickers'."),
      country: z.string().optional().describe("ISO 3166-1 alpha-2 country code (e.g. 'TH', 'US', 'GB'). Filters for listings that ship to this country. Pass the buyer's country to see locally-deliverable options."),
      min_price: z.number().optional().describe("Minimum price in the listing currency (inclusive)."),
      max_price: z.number().optional().describe("Maximum price in the listing currency (inclusive)."),
      buyable_only: z.boolean().optional().describe("If true, return only listings that can be purchased now (seller checkout enabled). Default false (includes browse-only listings, which are clearly tagged)."),
      limit: z.number().optional().describe("Max results to return, 1-50. Default 20."),
    },
    async ({ query, category, country, min_price, max_price, buyable_only, limit }) => {
      try {
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        if (category) params.set("category", category);
        if (country) params.set("country", country);
        if (typeof min_price === "number") params.set("min_price", String(min_price));
        if (typeof max_price === "number") params.set("max_price", String(max_price));
        if (buyable_only) params.set("buyable_only", "true");
        if (typeof limit === "number") params.set("limit", String(limit));

        const data = await apiRequest("GET", `/v1/listings/catalog?${params.toString()}`);
        const listings: any[] = data.listings || [];
        if (listings.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No catalog listings matched. Try a broader search term (a single product noun), remove price/category filters, or drop `buyable_only`.",
            }],
          };
        }

        const buyableCount = listings.filter((l) => l.buyable).length;
        const lines = [
          `**Firestarter catalog** — ${listings.length} result${listings.length === 1 ? "" : "s"} (${data.query?.environment || "live"} mode, ${buyableCount} buyable now)${data.has_more ? " · more available, narrow the search or raise `limit`" : ""}\n`,
        ];
        for (const l of listings) {
          const price = `${l.currency || "USD"} ${Number(l.current_price).toFixed(2)}`;
          const tag = l.buyable ? "✅ buyable" : "👁 browse-only";
          // #611: surface the first product image URL on its own line so chat
          // clients auto-unfurl a preview and agents have a fetchable, CORS-open
          // image URL (the network image endpoint) instead of guessing a link.
          const img0 = Array.isArray(l.images) && typeof l.images[0] === "string" && /^https?:\/\//i.test(l.images[0]) ? l.images[0] : null;
          lines.push(
            `- **${l.product_name}** — ${price} [${tag}]${l.category ? ` · ${l.category}` : ""}\n  id: \`${l.id}\` · ${l.share_url}${img0 ? `\n  ${img0}` : ""}`,
          );
        }
        lines.push(
          "\nTo buy a **buyable** item, call `firestarter_execute` with `listing_id` set to its id. **Browse-only** items can't be checked out here — share the link so the buyer can view them, and suggest the seller finish Stripe Connect to enable checkout.",
        );
        // Inline each listing's first photo so MCP clients render them; the URLs
        // also remain in the text above for chat clients that unfurl links.
        const catalogImages = await inlineImageBlocks(listings.map((l) => (Array.isArray(l.images) ? l.images[0] : null)));
        return { content: [{ type: "text" as const, text: lines.join("\n") }, ...catalogImages] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error searching catalog: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_listings
  server.tool(
    "firestarter_listings",
    "View your own product listings (seller side): name, current price, inventory, status, demand, and live share link when available. Pass listing_id for full detail on one listing; omit it to list all active listings. Use this when a seller wants to see, verify, or share what they have listed. Active live listings have a public share link; sandbox and draft listings do not.",
    {
      listing_id: z.string().optional().describe("Specific listing ID (lst_...) for full detail. Omit to list all active listings."),
    },
    async ({ listing_id: rawListingId }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        if (listing_id) {
          const l = await apiRequest("GET", `/v1/listings/${listing_id}`);
          let text = `**${l.product_name}** [${l.status}]\nID: \`${l.id}\`\n`;
          text += `Price: $${Number(l.current_price).toFixed(2)}`;
          const priceBits: string[] = [];
          if (l.base_price != null && l.base_price !== l.current_price) priceBits.push(`base $${Number(l.base_price).toFixed(2)}`);
          if (l.floor_price) priceBits.push(`floor $${Number(l.floor_price).toFixed(2)}`);
          if (l.ceiling_price) priceBits.push(`ceiling $${Number(l.ceiling_price).toFixed(2)}`);
          if (l.dynamic_pricing) priceBits.push("dynamic pricing on");
          if (priceBits.length) text += ` (${priceBits.join(", ")})`;
          text += "\n";
          if (l.inventory_qty != null) text += `Inventory: ${l.inventory_qty}\n`;
          if (l.category) text += `Category: ${l.category}\n`;
          if (l.description) text += `Description: ${String(l.description).slice(0, 300)}\n`;
          if (Array.isArray(l.images) && l.images.length > 0) {
            if (l.images.length === 1) {
              text += `Image: ${l.images[0]}\n`;
            } else {
              text += `Images (${l.images.length}):\n`;
              for (const img of l.images) text += `  - ${img}\n`;
            }
          }
          if (l.demand_score != null) text += `Demand score: ${l.demand_score}\n`;
          if (l.created_at) text += `Listed: ${l.created_at}\n`;
          const shareUrl = listingShareUrl(l);
          if (shareUrl) {
            text += `Share link: ${shareUrl}\n`;
            text += `\nPaste the share link bare in chat — it unfurls into a product card; humans get an "ask your AI agent to buy this" prompt and agents get machine-readable purchase instructions. Buyers' agents also find this via network search.`;
          } else {
            text += `Environment: sandbox\n`;
            text += `\nNo public share link is created for sandbox listings. Use test-mode catalog and listing tools to inspect it.`;
          }
          // #611: embed the product photos as MCP image blocks so any connected
          // client renders them inline — the agent no longer has to fetch a bare
          // URL with its own tool (which failed on the legacy web-hosted image
          // path that returns an HTML SPA shell). fetchImageAsBase64 validates the
          // bytes and returns null for anything that isn't a supported image, so a
          // bad URL is silently skipped and never poisons the whole tool response.
          const detailBlocks: ContentBlock[] = [{ type: "text", text }];
          const detailImageUrls = (Array.isArray(l.images) ? (l.images as unknown[]) : [])
            .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
            .slice(0, MAX_EMBED_IMAGES);
          if (detailImageUrls.length > 0) {
            const detailImages = await Promise.all(detailImageUrls.map(fetchImageAsBase64));
            for (const img of detailImages) {
              if (img) detailBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
            }
          }
          return { content: detailBlocks };
        }
        const data = await apiRequest("GET", "/v1/listings");
        const listings = data.listings || [];
        if (listings.length === 0) {
          return { content: [{ type: "text" as const, text: "You have no active listings. Use `firestarter_list` to create one." }] };
        }
        const utcToday = new Date().toISOString().slice(0, 10);
        const listedTodayUtc = listings.filter((l: any) => {
          const ts = typeof l?.created_at === "string" ? l.created_at : "";
          return ts.slice(0, 10) === utcToday;
        }).length;

        let text = `**Your listings (${listings.length})**\n`;
        text += `Listed today (UTC): ${listedTodayUtc}\n`;
        for (const l of listings) {
          text += `- **${l.product_name}** [${l.status}] — $${Number(l.current_price).toFixed(2)}`;
          if (l.inventory_qty != null) text += `, qty ${l.inventory_qty}`;
          // #527: include the listing date so the agent can answer "what did I list today?"
          // (the list view previously dropped it, so the model confabulated "no new listings").
          if (l.created_at) text += `, listed ${String(l.created_at).slice(0, 10)}`;
          text += ` — ID \`${l.id}\`\n`;
          const shareUrl = listingShareUrl(l);
          text += shareUrl ? `  Share link: ${shareUrl}\n` : "  Sandbox-only: no public share link\n";
        }
        text += `\nPass a listing ID for full detail. Active live listings include a public share link; sandbox listings remain accessible only through test-mode tools.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /not found/i.test(msg)
          ? "\n\nCall `firestarter_listings` with no arguments to see all your listings and their IDs."
          : "";
        return { content: [{ type: "text" as const, text: `Error fetching listings: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_demand
  server.tool(
    "firestarter_demand",
    "Check demand intelligence for a specific listing or category. See what buyers are searching for, demand trends, and pricing signals.",
    {
      listing_id: z.string().optional().describe("Specific listing ID to check demand for"),
      category: z.string().optional().describe("Check demand for a category (e.g. 'electronics/audio')"),
    },
    async ({ listing_id: rawListingId }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        let data: any;
        if (listing_id) {
          data = await apiRequest("GET", `/v1/listings/${listing_id}/demand`);
        } else {
          data = await apiRequest("GET", "/v1/demand/feed?hours=24");
        }
        const items = data.signals || data.demand || [data];
        if (!items || (Array.isArray(items) && items.length === 0)) {
          return { content: [{ type: "text" as const, text: "No demand signals found for the given criteria." }] };
        }
        let text = listing_id ? `**Demand for listing ${listing_id}**\n` : `**Demand feed** (last 24 hours)\n`;
        if (Array.isArray(items)) {
          for (const item of items.slice(0, 15)) {
            text += `- ${item.query || item.category || item.product || "Unknown"}`;
            if (item.count) text += ` (${item.count} searches)`;
            if (item.trend) text += ` | trend: ${item.trend}`;
            if (item.avg_budget) text += ` | avg budget: $${item.avg_budget}`;
            text += "\n";
          }
        } else {
          text += JSON.stringify(items, null, 2);
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error checking demand: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_reprice
  server.tool(
    "firestarter_reprice",
    "Adjust pricing, shipping, or rules for an existing listing. Update base price, floor/ceiling limits, shipping fee, dynamic pricing settings, or pricing rules.",
    {
      listing_id: z.string().describe("The listing ID to reprice"),
      base_price: z.number().optional().describe("New base price in USD"),
      floor_price: z.number().optional().describe("New floor price"),
      ceiling_price: z.number().optional().describe("New ceiling price"),
      dynamic_pricing: z.boolean().optional().describe("Enable/disable dynamic pricing"),
      shipping: z.number().optional().describe("Shipping price in USD. 0 = free shipping. Omit to keep current value. Set to null to revert to network default ($9.99, free over $50)."),
    },
    async ({ listing_id: rawListingId, base_price, floor_price, ceiling_price, dynamic_pricing, shipping }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        const body: any = {};
        if (base_price !== undefined) body.base_price = base_price;
        if (floor_price !== undefined) body.floor_price = floor_price;
        if (ceiling_price !== undefined) body.ceiling_price = ceiling_price;
        if (dynamic_pricing !== undefined) body.dynamic_pricing = dynamic_pricing;
        if (shipping !== undefined) body.shipping = shipping;
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "No pricing changes provided. Specify at least one field to update." }], isError: true };
        }
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, body);
        let text = `**Listing ${listing_id} updated**\n`;
        if (listing.base_price !== undefined) text += `Base price: $${listing.base_price}\n`;
        if (listing.floor_price !== undefined) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price !== undefined) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing !== undefined) text += `Dynamic pricing: ${listing.dynamic_pricing ? "enabled" : "disabled"}\n`;
        if (listing.shipping != null) text += `Shipping: $${listing.shipping.toFixed(2)} (seller-set)\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error repricing: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_update_listing
  server.tool(
    "firestarter_update_listing",
    "Update a listing's product details — name, description, category, inventory, or status. Use this to rename a product, change its description, update stock levels, or pause/reactivate a listing. Also activates imported drafts (status 'active') - drafts need a positive price and at least one photo. High-value (>= $500) and luxury-category drafts additionally require a possession-verification photo: activation returns the instructions and an FS-XXXX code to relay, and firestarter_verify submits the seller's photo. For pricing changes, use firestarter_reprice instead.",
    {
      listing_id: z.string().describe("The listing ID to update"),
      product_name: z.string().optional().describe("New product name/title"),
      description: z.string().optional().describe("New product description"),
      category: z.string().optional().describe("New category (e.g. 'sports/tennis')"),
      inventory_qty: z.number().optional().describe("Updated inventory quantity"),
      status: z.enum(["active", "paused", "out_of_stock"]).optional().describe("New listing status"),
      image_urls: z.array(z.string()).optional().describe("Replace the listing's photos with these public image URLs. If the seller attached a photo in this conversation, call firestarter_upload_image FIRST to get a hosted URL, then pass it here. Never ask them to re-send a photo already in the conversation."),
    },
    async ({ listing_id: rawListingId, product_name, description, category, inventory_qty, status, image_urls }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        const body: any = {};
        if (product_name !== undefined) body.product_name = product_name;
        if (description !== undefined) body.description = description;
        if (category !== undefined) body.category = category;
        if (inventory_qty !== undefined) body.inventory_qty = inventory_qty;
        if (status !== undefined) body.status = status;
        if (image_urls !== undefined) body.images = image_urls;
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "No updates provided. Specify at least one field to change." }], isError: true };
        }
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, body);
        let text = `**Listing ${listing_id} updated**\n`;
        if (listing.product_name) text += `Name: ${listing.product_name}\n`;
        if (listing.description) text += `Description: ${listing.description.slice(0, 100)}${listing.description.length > 100 ? "..." : ""}\n`;
        if (listing.category) text += `Category: ${listing.category}\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        if (listing.status) text += `Status: ${listing.status}\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        // Activation can trip the possession-verification gate - surface the
        // code + photo instructions instead of a flattened error string.
        const ask = verificationAskText(err);
        if (ask) {
          return { content: [{ type: "text" as const, text: ask }], isError: true };
        }
        if (err instanceof ApiError && err.code === "VERIFICATION_PENDING") {
          return {
            content: [{ type: "text" as const, text: `Cannot activate yet: a verification photo was received but could not be auto-checked, so it is held for review. The seller can resubmit a clearer photo with firestarter_verify (item + handwritten code both visible).` }],
            isError: true,
          };
        }
        if (err instanceof ApiError && err.code === "VERIFICATION_FLAGGED") {
          return {
            content: [{ type: "text" as const, text: `Cannot activate yet: the last verification photo did not match this listing, so it is queued for review. Ask the seller for a clearer photo - the item and the handwritten code both visible in one shot - and resubmit with firestarter_verify.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Error updating listing: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_set_shipping_policy
  // #332: the "widen on demand" path. A buyer's checkout can come back
  // SHIPPING_NOT_OFFERED when the seller hadn't opted into that destination;
  // the seller says "yes, ship there too" and this updates the listing's
  // allow-list. Platform hard rules (sanctions etc.) still apply downstream.
  server.tool(
    "firestarter_set_shipping_policy",
    "Set where a seller is willing to ship a listing. Use this when a buyer wants delivery to a country the listing does not yet cover (a checkout came back 'seller not shipping to that destination') and the seller agrees to ship there — or whenever the seller wants to change their shipping reach. mode 'domestic' = ship-from country only (the default); mode 'list' = the home country plus the countries you name (ISO alpha-2, e.g. ['CA','GB','AU']); mode 'worldwide' = everywhere except any you exclude. Sanctioned/embargoed destinations stay blocked regardless. Sets the policy for one listing — pass its ID.",
    {
      listing_id: z.string().describe("The listing ID whose shipping policy to set"),
      mode: z.enum(["domestic", "list", "worldwide"]).describe("'domestic' = ship-from country only; 'list' = home country plus the named countries; 'worldwide' = everywhere except excluded"),
      countries: z.array(z.string()).optional().describe("mode 'list' only: ISO alpha-2 destination codes to serve, e.g. ['CA','GB']. The ship-from country is always included automatically."),
      exclude: z.array(z.string()).optional().describe("mode 'worldwide' only: ISO alpha-2 codes to carve out, e.g. ['BR']."),
    },
    async ({ listing_id: rawListingId, mode, countries, exclude }) => {
      const listing_id = cleanListingId(rawListingId);
      if (mode === "list" && !(countries && countries.length > 0)) {
        return { content: [{ type: "text" as const, text: "mode 'list' needs at least one country in `countries` (ISO alpha-2, e.g. ['CA','GB']). Ask the seller which destinations to add." }], isError: true };
      }
      try {
        const policy: any = { mode };
        if (mode === "list" && countries?.length) policy.countries = countries;
        if (mode === "worldwide" && exclude?.length) policy.exclude = exclude;
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, { shipping_policy: policy });
        const sp = listing.shipping_policy || policy;
        let text = `**Shipping policy updated for ${listing.product_name || listing_id}**\n`;
        if (sp.mode === "domestic") text += `Ships: domestically only (within the ship-from country).\n`;
        else if (sp.mode === "list") text += `Ships to: home country${sp.countries?.length ? " + " + sp.countries.join(", ") : ""}.\n`;
        else text += `Ships: worldwide${sp.exclude?.length ? " except " + sp.exclude.join(", ") : ""}.\n`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error setting shipping policy: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_verify
  // A3: possession-verification evidence. Wraps POST /v1/listings/:id/verification.
  // The happy path is human-free: vision soft-check auto-approves, the agent
  // relays the outcome and activates. Mismatches flag (resubmit allowed);
  // vision errors hold as pending (fail-safe, never fail-open).
  server.tool(
    "firestarter_verify",
    "Submit a possession-verification photo for a listing whose activation asked for one (high-value >= $500, luxury category, or a source-URL conflict). The seller writes the FS-XXXX code by hand, photographs the paper next to the item, and sends the photo in chat - pass that photo's URL here with the listing ID. A match verifies instantly (then activate via firestarter_update_listing); a mismatch is flagged and the seller can resubmit a clearer photo; an unreadable photo is held for review.",
    {
      listing_id: z.string().describe("The listing ID (lst_...) that needs possession verification"),
      photo_url: z.string().describe("Public https URL of the seller's photo showing the item next to the handwritten verification code"),
    },
    async ({ listing_id, photo_url }) => {
      try {
        const r = await apiRequest("POST", `/v1/listings/${listing_id}/verification`, { photo_url }, VERIFY_TIMEOUT_MS);
        if (r.verification_status === "verified") {
          const already = !r.checked;
          const text = already
            ? `**Listing ${listing_id} is already verified.** Activate it with firestarter_update_listing (status "active") once the seller confirms the draft looks right.`
            : `**Verified.** The photo matches the listing and the handwritten code - no human review needed.\n\nNext: after the seller confirms the draft looks right, activate with firestarter_update_listing (status "active").`;
          return { content: [{ type: "text" as const, text }] };
        }
        if (r.verification_status === "flagged") {
          const text =
            `**Not verified - the photo did not clearly match.**\n` +
            `Item match: ${r.checked?.item_match === true ? "yes" : "no"} | Code match: ${r.checked?.code_match === true ? "yes" : "no"}\n\n` +
            `It is queued for review, but the seller can resubmit right away: one clear photo with the item AND the handwritten code both visible, then call firestarter_verify again.`;
          return { content: [{ type: "text" as const, text }] };
        }
        // pending: vision could not check - held, never auto-approved
        return {
          content: [{ type: "text" as const, text: `**Photo received but not auto-checked.** ${r.message || "It is held for review."} The seller can also resubmit a clearer photo with firestarter_verify later.` }],
        };
      } catch (err: any) {
        const ask = verificationAskText(err);
        if (ask) {
          // First evidence attempt on a collision-born draft: the code was
          // just issued - relay the instructions, then resubmit the photo.
          return { content: [{ type: "text" as const, text: ask }], isError: true };
        }
        if (err instanceof ApiError && err.code === "VERIFICATION_NOT_REQUIRED") {
          return {
            content: [{ type: "text" as const, text: `This listing does not need possession verification. Activate it directly with firestarter_update_listing (status "active").` }],
            isError: true,
          };
        }
        const msg = toErrorMessage(err);
        let hint = "";
        if (err instanceof ApiError && (err.code === "INVALID_PHOTO_URL" || err.code === "MISSING_PHOTO_URL")) {
          hint = "\n\nThe photo must be a public https image URL (e.g. the URL of the photo the seller sent in chat). Ask the seller to re-send the photo if needed.";
        } else if (/not found/i.test(msg)) {
          hint = "\n\nCall firestarter_listings to check the listing ID.";
        }
        return { content: [{ type: "text" as const, text: `Error submitting verification photo: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_delist
  server.tool(
    "firestarter_delist",
    "Remove one of your listings from the network (soft delete). Buyers' agents can no longer find or buy it, and its share link goes dark. Always confirm with the user before delisting — this takes the product off the market immediately.",
    {
      listing_id: z.string().describe("The listing ID (lst_...) to delist"),
    },
    async ({ listing_id: rawListingId }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        await apiRequest("DELETE", `/v1/listings/${listing_id}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `**Listing ${listing_id} delisted.** It is no longer discoverable by buyers' agents, and its share link (${SHARE_LINK_BASE}/${listing_id}) now shows not-found. Relist anytime with \`firestarter_list\`.`,
            },
          ],
        };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        const hint = /not found/i.test(msg)
          ? "\n\nCall `firestarter_listings` to see your active listings and their IDs — it may already be delisted."
          : "";
        return { content: [{ type: "text" as const, text: `Error delisting: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // ── Seller order management tools ─────────────────────────────────────────

  // Tool: firestarter_seller_orders
  server.tool(
    "firestarter_seller_orders",
    "View the seller's incoming orders — product, quantity, amount, net payout, order status, payout status, and carrier tracking when shipped. This is the start of the fulfillment flow: firestarter_seller_orders (see what sold) → firestarter_confirm_order (accept a pending order) → firestarter_ship_order (add tracking; the buyer is notified automatically). Use whenever a seller asks about their orders, sales, what sold, or recent activity. Covers all orders including those from a connected Shopify store. Each order line carries the order_id you pass to confirm/ship. Read-only: never changes anything.",
    {},
    async () => {
      try {
        const data = await apiRequest("GET", "/v1/sellers/orders");
        const orders = data.orders || [];
        if (orders.length === 0) {
          return { content: [{ type: "text" as const, text: "No orders yet. Once a buyer purchases one of your listings, orders will appear here." }] };
        }
        const lines = [`**Your Orders** (${orders.length})\n`];
        let anyPending = false;
        for (const o of orders) {
          const amount = o.amount_cents ? `$${(o.amount_cents / 100).toFixed(2)}` : "pending";
          const payout = o.net_payout_cents ? `$${(o.net_payout_cents / 100).toFixed(2)} net` : "";
          if (o.status === "pending" || o.status === "confirmed") anyPending = true;
          // #556: surface the order_id so the agent can chain straight into
          // firestarter_confirm_order / firestarter_ship_order without re-asking.
          const tracking = o.tracking_number
            ? ` - Tracking: ${o.carrier || "Carrier"} ${o.tracking_number}${o.tracking_url ? ` (${o.tracking_url})` : ""}`
            : "";
          lines.push(`- **${o.product_title}** x${o.quantity} - ${amount}${payout ? ` (${payout})` : ""} - Status: ${o.status} - Payout: ${o.payout_status}${tracking} - order_id \`${o.id}\``);
        }
        if (anyPending) {
          lines.push(`\nAccept a pending order with firestarter_confirm_order (its order_id), then add tracking with firestarter_ship_order once it's on its way.`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error fetching orders: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_confirm_order
  server.tool(
    "firestarter_confirm_order",
    "Accept a pending incoming order — step 2 of the seller fulfillment flow (firestarter_seller_orders → firestarter_confirm_order → firestarter_ship_order). Use when a seller wants to accept/confirm an order a buyer placed. Confirming notifies the buyer that the order is accepted and is the gate before shipping. Pass the order_id exactly as shown by firestarter_seller_orders (the order_id field, NOT the exec_... execution id). Only orders still in 'pending' can be confirmed — an order that's already confirmed or shipped doesn't need this; go straight to firestarter_ship_order.",
    {
      order_id: z.string().describe("REQUIRED. The order_id from firestarter_seller_orders (the seller_earnings id, not the exec_... execution id)."),
    },
    async ({ order_id }) => {
      try {
        await apiRequest("PUT", `/v1/sellers/orders/${order_id}/confirm`);
        return { content: [{ type: "text" as const, text: `**Order confirmed.** The buyer has been notified. Next step: ship the item and add tracking with firestarter_ship_order (same order_id).` }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        let hint = "";
        if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.status === 404)) {
          hint = "\n\nNo pending order matched that id. It may already be confirmed (go straight to firestarter_ship_order) or the id was wrong — run firestarter_seller_orders to get the exact order_id.";
        } else if (err instanceof ApiError && err.code === "NO_SELLER") {
          hint = "\n\nThe seller has no active seller profile yet. Call `firestarter_register_seller` with their business name first.";
        }
        return { content: [{ type: "text" as const, text: `Error confirming order: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_ship_order
  server.tool(
    "firestarter_ship_order",
    "Mark an order shipped by attaching a carrier and tracking number — the final step of the seller fulfillment flow (firestarter_seller_orders → firestarter_confirm_order → firestarter_ship_order). The buyer is notified and can track delivery automatically; no separate buyer message is needed. Call once the seller has actually handed the package to the carrier and has a tracking number. ONLY order_id and tracking_number are required; carrier is optional and defaults to USPS. Pass the order_id exactly as firestarter_seller_orders shows it (NOT the exec_... execution id).",
    {
      order_id: z.string().describe("REQUIRED. The order_id from firestarter_seller_orders (the seller_earnings id, not the exec_... execution id)."),
      tracking_number: z.string().describe("REQUIRED. The carrier's tracking number for the shipment."),
      carrier: z.string().optional().describe("Optional. Carrier name (e.g. 'USPS', 'UPS', 'FedEx', 'DHL'). Defaults to USPS when omitted — don't ask the seller unless they used a non-USPS carrier."),
    },
    async ({ order_id, tracking_number, carrier }) => {
      try {
        const body: any = { tracking_number };
        if (carrier) body.carrier = carrier;
        await apiRequest("POST", `/v1/sellers/orders/${order_id}/ship`, body);
        return { content: [{ type: "text" as const, text: `**Order shipped.** Tracking: ${carrier || "USPS"} ${tracking_number}. The buyer has been notified and can now track their delivery.` }] };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        let hint = "";
        if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.status === 404)) {
          hint = "\n\nNo order matched that id. Run firestarter_seller_orders to get the exact order_id (use the order_id field, not the exec_... id).";
        } else if (err instanceof ApiError && err.code === "NO_SELLER") {
          hint = "\n\nThe seller has no active seller profile yet. Call `firestarter_register_seller` with their business name first.";
        }
        return { content: [{ type: "text" as const, text: `Error marking shipped: ${msg}${hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_seller_analytics
  server.tool(
    "firestarter_seller_analytics",
    "View seller revenue and order analytics - total revenue, order count, average order value, and 30-day daily breakdown. Use when a seller asks about their performance, earnings, or sales trends.",
    {},
    async () => {
      try {
        const data = await apiRequest("GET", "/v1/sellers/analytics");
        let text = "**Seller Analytics**\n";
        text += `Total revenue: $${(data.revenue_cents / 100).toFixed(2)}\n`;
        text += `Total orders: ${data.orders}\n`;
        text += `Average order: $${(data.avg_order_cents / 100).toFixed(2)}\n`;
        if (data.daily?.length > 0) {
          text += `\n**Last 30 days:**\n`;
          for (const d of data.daily.slice(-7)) {
            text += `  ${d.date}: $${(d.revenue_cents / 100).toFixed(2)} (${d.orders} order${d.orders !== 1 ? "s" : ""})\n`;
          }
          if (data.daily.length > 7) text += `  ... and ${data.daily.length - 7} more days\n`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error fetching analytics: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_seller_disputes
  // Call with no args to LIST disputes; pass dispute_id + action to ACT on one.
  // The action maps to the dispute engine's seller responses (voluntary_refund /
  // contest / propose_split) so escrow actually moves. Sending a bare
  // { resolution } string is intentionally NOT accepted by the API (it requires
  // an explicit action), so the tool must translate the seller's intent here.
  server.tool(
    "firestarter_seller_disputes",
    "View and resolve disputes on orders the user is SELLING (their own catalog/store). This is the SELLER side only. If the user is asking about something they BOUGHT — 'is there a dispute on my order?', a purchase that didn't arrive or arrived wrong — use firestarter_disputes instead. Call with NO arguments to list open disputes on the seller's sales (each shows its dispute_id). To act on one, pass dispute_id plus an action: 'refund' (refund the buyer in full and lift the escrow freeze), 'contest' (reject the claim and state your case), or 'split' (propose a partial refund - include buyer_pct and seller_pct that sum to 100). Use when a seller mentions a dispute, complaint, refund, chargeback, or return on something they sell.",
    {
      dispute_id: z.string().optional().describe("Dispute ID to act on (disp_...). Omit to list all disputes."),
      action: z.enum(["refund", "contest", "split"]).optional().describe("What to do with the dispute: 'refund' = full refund to the buyer; 'contest' = reject the claim; 'split' = propose a partial refund (also set buyer_pct + seller_pct)."),
      buyer_pct: z.number().min(0).max(100).optional().describe("For action 'split': percent refunded to the buyer. buyer_pct + seller_pct must equal 100."),
      seller_pct: z.number().min(0).max(100).optional().describe("For action 'split': percent the seller keeps. buyer_pct + seller_pct must equal 100."),
      reasoning: z.string().optional().describe("Optional note explaining the decision, recorded on the dispute and shown to the buyer."),
    },
    async ({ dispute_id, action, buyer_pct, seller_pct, reasoning }) => {
      try {
        if (dispute_id) {
          if (!action) {
            return { content: [{ type: "text" as const, text: `To act on dispute ${dispute_id}, choose an action: **refund** (full refund to the buyer), **contest** (reject the claim), or **split** (partial refund - give buyer_pct and seller_pct summing to 100).` }] };
          }
          const ENGINE_ACTION = { refund: "voluntary_refund", contest: "contest", split: "propose_split" } as const;
          const engineAction = ENGINE_ACTION[action];
          const payload: Record<string, unknown> = { action: engineAction };
          if (reasoning) payload.reasoning = reasoning;
          if (engineAction === "propose_split") {
            payload.buyer_pct = buyer_pct ?? 50;
            payload.seller_pct = seller_pct ?? 50;
          }
          await apiRequest("PUT", `/v1/sellers/disputes/${dispute_id}/resolve`, payload);
          const summary =
            engineAction === "voluntary_refund" ? "Full refund issued to the buyer. The escrow freeze is lifted and the order is closed."
              : engineAction === "contest" ? "Claim contested. The buyer has been notified and can respond, counter, or escalate."
                : `Split proposed to the buyer: ${payload.buyer_pct}% refund / ${payload.seller_pct}% to you. It applies once the buyer accepts.`;
          return { content: [{ type: "text" as const, text: `**Dispute ${dispute_id} updated.** ${summary}` }] };
        }
        const data = await apiRequest("GET", "/v1/sellers/disputes");
        const disputes = data.disputes || [];
        if (disputes.length === 0) {
          // Never claim "all orders in good standing" from a seller-only query —
          // that global-sounding assurance is exactly what mislabeled a BUYER's
          // dispute question as "no dispute". Say the seller-scoped truth, and if
          // the caller isn't a registered seller at all, don't imply zero
          // disputes — point them at the buyer tool.
          const text = data.is_seller === false
            ? "You're not registered as a seller, so there are no seller-side disputes to show. If you're asking about an order you BOUGHT, use `firestarter_disputes` instead."
            : "No open disputes on your sales right now. (This only covers orders you're selling — for something you bought, use `firestarter_disputes`.)";
          return { content: [{ type: "text" as const, text }] };
        }
        const lines = [`**Disputes** (${disputes.length})\n`];
        for (const d of disputes) {
          lines.push(`- **${d.product || "Order"}** (${d.id}) - Reason: ${d.reason || "Not specified"} - Status: ${d.status}${d.resolution ? ` - Resolution: ${d.resolution}` : ""}`);
        }
        lines.push(`\nTo act on one, call again with its dispute_id and an action (refund / contest / split).`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error with disputes: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_disputes (BUYER side)
  // The buyer counterpart to firestarter_seller_disputes. Buyers open, track, and
  // resolve disputes on orders THEY bought. Execution-centric (exec_… ids) so it
  // lines up with how firestarter_status / firestarter_track_order name orders.
  // This tool is why a buyer asking "is there a dispute on my order?" now gets a
  // real, buyer-scoped answer instead of the seller tool's false "all clear".
  {
    // Newest-first (the API orders buyer disputes by created_at DESC), so the
    // first execution_id match is the latest dispute on that order.
    const findBuyerDispute = async (executionId: string): Promise<any | null> => {
      const list = await apiRequest("GET", "/buyer/disputes");
      const rows = Array.isArray(list.disputes) ? list.disputes : [];
      return rows.find((d: any) => d.execution_id === executionId) || null;
    };

    // Resolve the dispute id an action targets: an explicit disp_… wins; otherwise
    // look it up from the order id. Returns null when neither is usable.
    const resolveDisputeId = async (disputeId?: string, executionId?: string): Promise<string | null> => {
      if (disputeId) return cleanListingId(disputeId);
      if (executionId) return (await findBuyerDispute(cleanListingId(executionId)))?.id ?? null;
      return null;
    };

    const statusLabel = (s: unknown) => String(s ?? "").replace(/_/g, " ");
    const OPEN_STATES = new Set(["open", "seller_responded", "negotiating", "escalated"]);
    const textBlock = (text: string, isError = false) =>
      ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

    server.tool(
      "firestarter_disputes",
      "For BUYERS: open, check, and resolve disputes on orders the user BOUGHT. Use this whenever a buyer asks 'is there a dispute on my order?', wants to open a dispute (item never arrived, arrived damaged / wrong / not as described), or needs to respond to one — post a note or photo, accept / reject / counter the seller's partial-refund offer, withdraw, or escalate to Firestarter. Call with NO arguments to list the buyer's disputes; pass an order's execution_id (exec_…) to check whether THAT order has a dispute; pass a dispute_id (disp_…) to see the full thread. This is the BUYER side — for disputes on orders the user is SELLING, use firestarter_seller_disputes instead.",
      {
        action: z.enum(["open", "message", "accept", "reject", "counter", "withdraw", "escalate"]).optional().describe("What to do. OMIT to list the buyer's disputes, or to view one (pass dispute_id, or execution_id to look up the dispute on that order). 'open' = file a new dispute (needs execution_id + reason). 'message' = post a note and/or photo to the thread (needs dispute_id or execution_id, plus message and/or image_base64). 'accept' / 'reject' = respond to the seller's split offer (offer_id optional — defaults to the latest pending seller offer). 'counter' = propose your own split (needs buyer_pct + seller_pct). 'withdraw' = drop the dispute. 'escalate' = ask Firestarter to review."),
        execution_id: z.string().optional().describe("Order / execution id (exec_…). Required for 'open'. With no action, pass this to check whether a specific order has a dispute. May also stand in for dispute_id on actions — the dispute on that order is looked up."),
        dispute_id: z.string().optional().describe("Dispute id (disp_…). Identifies which dispute to view or act on for message / accept / reject / counter / withdraw / escalate."),
        reason: z.string().optional().describe("For 'open': what went wrong, in the buyer's words (e.g. 'Package never arrived, tracking stuck for two weeks'). Also used as the optional note on a 'counter' or 'escalate'."),
        type: z.enum(["not_received", "not_as_described", "damaged", "missing_item", "wrong_item", "other"]).optional().describe("For 'open': the category of problem. Use 'not_received' when the order never arrived. Defaults to 'not_as_described'."),
        message: z.string().optional().describe("For 'message': the text to post to the dispute thread."),
        image_base64: z.string().optional().describe("For 'message': an optional evidence photo as a base64 data-URI ('data:image/jpeg;base64,…'). It is uploaded and attached to the message."),
        offer_id: z.string().optional().describe("For 'accept' / 'reject': the specific offer id to respond to. Omit to act on the latest pending seller offer."),
        buyer_pct: z.number().min(0).max(100).optional().describe("For 'counter': the percent YOU (the buyer) would be refunded. buyer_pct + seller_pct must equal 100."),
        seller_pct: z.number().min(0).max(100).optional().describe("For 'counter': the percent the seller keeps. buyer_pct + seller_pct must equal 100."),
      },
      async ({ action, execution_id, dispute_id, reason, type, message, image_base64, offer_id, buyer_pct, seller_pct }) => {
        try {
          // ── OPEN a new dispute ─────────────────────────────────────────────
          if (action === "open") {
            if (!execution_id) return textBlock("To open a dispute I need the order id (exec_…). Check the order with firestarter_status if you're not sure which one.", true);
            const execId = cleanListingId(execution_id);
            // Don't open a second dispute on an order that already has an open one.
            const existing = await findBuyerDispute(execId);
            if (existing && existing.is_open) {
              return textBlock(`This order already has an open dispute (${existing.id}, status: ${statusLabel(existing.status)}). View or respond to it with firestarter_disputes dispute_id "${existing.id}" — I won't open a second one.`);
            }
            if (!reason || !reason.trim()) return textBlock("To open a dispute, tell me briefly what went wrong (e.g. 'never arrived' or 'arrived damaged').", true);
            const res = await apiRequest("POST", `/v1/executions/${execId}/dispute`, { reason: reason.trim(), type: type || "not_as_described" });
            if (!res.dispute_id) {
              // The escrow was frozen but the dispute row didn't materialize — say
              // so honestly rather than implying a live, timed dispute exists.
              return textBlock(`The escrow hold on order ${execution_id} was frozen, but the dispute record couldn't be created. ${res.message || ""} Please retry, or contact support so this doesn't sit frozen.`.trim());
            }
            return textBlock(`**Dispute opened** (${res.dispute_id}) on order ${execution_id}. ${res.message || "Funds are frozen in escrow pending review; the seller has 48 hours to respond."}\n\nAdd a photo or note anytime with action "message". I'll surface the seller's response when it comes.`);
          }

          // ── MESSAGE (optionally with a photo) ──────────────────────────────
          if (action === "message") {
            const did = await resolveDisputeId(dispute_id, execution_id);
            if (!did) return textBlock("I need the dispute id (disp_…) or the order id to post to. List your disputes by calling firestarter_disputes with no arguments.", true);
            if ((!message || !message.trim()) && !image_base64) return textBlock("Add a note (message) or a photo (image_base64) to post to the dispute.", true);
            let attachmentUrls: string[] = [];
            if (image_base64) {
              const up = await apiRequest("POST", `/buyer/disputes/${did}/attachments`, { image_base64 }, VERIFY_TIMEOUT_MS);
              if (up?.url) attachmentUrls = [up.url];
              else if (!message || !message.trim()) return textBlock("I couldn't attach that photo (it may be an unsupported format or too large). Try another image, or send a text note instead.", true);
            }
            await apiRequest("POST", `/buyer/disputes/${did}/messages`, {
              message: (message && message.trim()) || "",
              attachment_urls: attachmentUrls,
            });
            return textBlock(`Posted to dispute ${did}.${attachmentUrls.length ? " Photo attached." : ""} The seller will see it.`);
          }

          // ── ACCEPT / REJECT a seller's split offer ─────────────────────────
          if (action === "accept" || action === "reject") {
            const did = await resolveDisputeId(dispute_id, execution_id);
            if (!did) return textBlock("I need the dispute id (disp_…) or the order id to respond to. List your disputes with firestarter_disputes.", true);
            let oid = offer_id ? cleanListingId(offer_id) : undefined;
            if (!oid) {
              const detail = await apiRequest("GET", `/buyer/disputes/${did}`);
              const offers = detail?.dispute?.offers || [];
              const pending = offers.find((o: any) => o.offered_by === "seller" && !o.accepted_at && !o.rejected_at);
              if (!pending) return textBlock(`There's no pending seller offer to ${action} on dispute ${did}. You can send a message, counter with your own split, or escalate.`, true);
              oid = pending.id;
            }
            if (action === "accept") {
              await apiRequest("POST", `/buyer/disputes/${did}/offers/${oid}/accept`);
              return textBlock(`Offer accepted on dispute ${did}. The agreed split is applied and the escrow is settled — the dispute is now resolved.`);
            }
            await apiRequest("POST", `/buyer/disputes/${did}/offers/${oid}/reject`);
            return textBlock(`Offer rejected on dispute ${did}. You can counter with action "counter" (buyer_pct + seller_pct), keep messaging, or escalate to Firestarter.`);
          }

          // ── COUNTER with the buyer's own split ─────────────────────────────
          if (action === "counter") {
            const did = await resolveDisputeId(dispute_id, execution_id);
            if (!did) return textBlock("I need the dispute id (disp_…) or the order id to counter on. List your disputes with firestarter_disputes.", true);
            if (buyer_pct == null || seller_pct == null) return textBlock("To counter, give both buyer_pct and seller_pct (they must add up to 100).", true);
            if (Math.round(buyer_pct + seller_pct) !== 100) return textBlock(`buyer_pct + seller_pct must equal 100 (you gave ${buyer_pct} + ${seller_pct} = ${buyer_pct + seller_pct}).`, true);
            await apiRequest("POST", `/buyer/disputes/${did}/counter`, { buyer_pct, seller_pct, reasoning: reason });
            return textBlock(`Counter-offer sent on dispute ${did}: **${buyer_pct}% refund to you / ${seller_pct}% to the seller**. The seller can accept, reject, or counter back.`);
          }

          // ── WITHDRAW the dispute ───────────────────────────────────────────
          if (action === "withdraw") {
            const did = await resolveDisputeId(dispute_id, execution_id);
            if (!did) return textBlock("I need the dispute id (disp_…) or the order id to withdraw. List your disputes with firestarter_disputes.", true);
            await apiRequest("POST", `/buyer/disputes/${did}/withdraw`);
            return textBlock(`Dispute ${did} withdrawn. The escrow hold is unfrozen and the order goes back to normal processing (the usual release timer resumes).`);
          }

          // ── ESCALATE to Firestarter ────────────────────────────────────────
          if (action === "escalate") {
            const did = await resolveDisputeId(dispute_id, execution_id);
            if (!did) return textBlock("I need the dispute id (disp_…) or the order id to escalate. List your disputes with firestarter_disputes.", true);
            await apiRequest("POST", `/buyer/disputes/${did}/escalate`, reason && reason.trim() ? { reason: reason.trim() } : {});
            return textBlock(`Dispute ${did} escalated to Firestarter for review. The funds stay frozen until a decision is recorded on the dispute.`);
          }

          // ── VIEW a specific dispute (dispute_id, or the one on an order) ────
          let viewId = dispute_id ? cleanListingId(dispute_id) : undefined;
          if (!viewId && execution_id) {
            const found = await findBuyerDispute(cleanListingId(execution_id));
            if (!found) {
              return textBlock(`No dispute on order ${execution_id} — it's in good standing on your side. If it never arrived or arrived wrong, open one with action "open" (plus a short reason).`);
            }
            viewId = found.id;
          }
          if (viewId) {
            const detail = await apiRequest("GET", `/buyer/disputes/${viewId}`);
            const d = detail?.dispute;
            if (!d) return textBlock(`Dispute ${viewId} not found among your orders.`, true);

            const lines: string[] = [];
            lines.push(`**Dispute ${d.id}** — status: ${statusLabel(d.status)}`);
            if (d.execution_id) lines.push(`Order: ${d.execution_id}`);
            if (d.reason) lines.push(`Reason: ${d.reason}${d.dispute_type ? ` (${statusLabel(d.dispute_type)})` : ""}`);
            if (OPEN_STATES.has(d.status) && d.seller_deadline_at) lines.push(`Seller must respond by ${new Date(d.seller_deadline_at).toUTCString()}.`);
            if (!OPEN_STATES.has(d.status)) {
              const pct = typeof d.buyer_refund_pct === "number" ? ` — you were refunded ${d.buyer_refund_pct}%` : "";
              lines.push(`Resolved${d.resolution_type ? ` (${statusLabel(d.resolution_type)})` : ""}${pct}.`);
            }

            const offers = Array.isArray(d.offers) ? d.offers : [];
            if (offers.length > 0) {
              lines.push("", "**Offers:**");
              for (const o of offers) {
                const state = o.accepted_at ? "accepted" : o.rejected_at ? "rejected" : "pending";
                const who = o.offered_by === "seller" ? "Seller" : "You";
                lines.push(`- ${who}: **${o.buyer_pct}% refund to you / ${o.seller_pct}% to seller** — ${state}${o.reasoning ? ` — "${o.reasoning}"` : ""}`);
              }
            }

            const messages = Array.isArray(d.messages) ? d.messages : [];
            if (messages.length > 0) {
              lines.push("", "**Messages:**");
              for (const m of messages) {
                const who = m.sender_role === "buyer" ? "You" : m.sender_role === "seller" ? "Seller" : "Firestarter";
                const nAtt = Array.isArray(m.attachment_urls) ? m.attachment_urls.length : 0;
                lines.push(`- **${who}:** ${m.message}${nAtt ? ` _(${nAtt} photo${nAtt > 1 ? "s" : ""})_` : ""}`);
              }
            }

            // Status-aware next step. Withdraw/counter need an open, pre-escalation
            // dispute; escalate only works after the seller has engaged.
            const pendingSellerOffer = offers.find((o: any) => o.offered_by === "seller" && !o.accepted_at && !o.rejected_at);
            lines.push("");
            if (pendingSellerOffer) {
              lines.push(`The seller is offering you a **${pendingSellerOffer.buyer_pct}% refund**. Accept (action "accept"), reject (action "reject"), or counter (action "counter" with buyer_pct + seller_pct).`);
            } else if (d.status === "open") {
              lines.push(`Waiting on the seller. You can add a message or photo (action "message"), or withdraw (action "withdraw").`);
            } else if (d.status === "seller_responded" || d.status === "negotiating") {
              lines.push(`You can counter (action "counter"), keep messaging, escalate to Firestarter (action "escalate"), or withdraw (action "withdraw").`);
            } else if (d.status === "escalated") {
              lines.push(`This dispute is with Firestarter for review. You can still add messages or photos while it's reviewed.`);
            }

            const imageUrls = [
              ...(Array.isArray(d.evidence_urls) ? d.evidence_urls : []),
              ...(Array.isArray(d.seller_evidence_urls) ? d.seller_evidence_urls : []),
              ...messages.flatMap((m: any) => (Array.isArray(m.attachment_urls) ? m.attachment_urls : [])),
            ];
            const imageBlocks = await inlineImageBlocks(imageUrls);
            return { content: [{ type: "text" as const, text: lines.join("\n") }, ...imageBlocks] };
          }

          // ── LIST the buyer's disputes ──────────────────────────────────────
          const list = await apiRequest("GET", "/buyer/disputes");
          const disputes = Array.isArray(list.disputes) ? list.disputes : [];
          if (disputes.length === 0) {
            return textBlock("You have no disputes — all your orders are in good standing. If an order hasn't arrived or arrived wrong, open one with action \"open\" and the order id (exec_…).");
          }
          const openCount = disputes.filter((d: any) => d.is_open).length;
          const outLines = [`**Your disputes** (${disputes.length}${openCount ? `, ${openCount} open` : ", all resolved"})\n`];
          for (const d of disputes) {
            outLines.push(`- **${d.product || "Order"}** — ${d.id} — ${statusLabel(d.status)}${d.is_open ? "" : " (closed)"}${d.execution_id ? ` — order ${d.execution_id}` : ""}`);
          }
          outLines.push(`\nSee one in full: firestarter_disputes with its dispute_id (or the order's execution_id).`);
          return textBlock(outLines.join("\n"));
        } catch (err: any) {
          return textBlock(`Error with disputes: ${toErrorMessage(err)}`, true);
        }
      }
    );
  }

  // ── Community attribution / self-serve "markets" (agentic spin-up) ──
  // These let ANY agent (Cole, Claude, Cursor, a community's own bot) stand up
  // an attribution program, mint a share code, and read earnings — no dashboard
  // required. Programs are owned by the calling org. Inert until
  // ATTRIBUTION_PROGRAMS_ENABLED turns payouts on; creating a program early just
  // stages it.
  {
    server.tool(
      "firestarter_create_market",
      "Set up a community/affiliate 'market' on Firestarter so a community owner or influencer earns a share of Firestarter's platform fee on every sale their community drives. Use this WHENEVER a user asks to create, set up, or start a community market, affiliate program, or 'store for my audience' (e.g. Discord/Telegram/X following) — call this tool directly; do NOT route them through seller onboarding or ask about their country. Creating a market does NOT require being a Firestarter seller, connecting Stripe, or living in a payout-supported country — it works from ANY country, including ones where seller payouts aren't yet available. (A payout method is only needed LATER to withdraw accrued earnings, and can be connected any time.) Creates an attribution PROGRAM owned by the caller. `share_bps` is the cut of the PLATFORM FEE in basis points (1000 = 10%); it is capped at the platform self-serve max and the response returns the effective value. Optionally claim a `handle` now for a memorable community URL (firestarter.network/m/<handle>); you can also set or change it later with firestarter_set_market_handle. Then call firestarter_market_link to get a share code for the community.",
      {
        share_bps: z.number().int().min(0).max(10000).describe("Cut of Firestarter's platform fee in basis points (1000 = 10%). Capped at the platform self-serve max; the response returns the effective value."),
        type: z.enum(["community", "developer"]).optional().describe("Program type. Default 'community'."),
        display_name: z.string().max(60).optional().describe("Buyer-facing community name, e.g. 'Analog'. Displayed on join/browse/community surfaces."),
        handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/i, "handle must be 2-31 chars: letters, digits and hyphens, starting with a letter or digit").optional().describe("Optional vanity handle for the community URL — firestarter.network/m/<handle> instead of a random share code. 2-31 chars: letters, digits and hyphens, must start with a letter or digit. Case is ignored (normalized to lowercase), so 'Analog' and 'analog' are the same handle. Must be unique; the API rejects handles that are reserved or shaped like a share code. If it's taken the whole create fails, so retry with a different handle (or omit it and claim one later with firestarter_set_market_handle)."),
      },
      async ({ share_bps, type, display_name, handle }) => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/programs", { type: type ?? "community", override_bps: share_bps, display_name, slug: handle?.toLowerCase() });
          const p = res.program ?? {};
          let text = `**Market created.**${p.display_name ? ` ${p.display_name}.` : ""} Program id: \`${p.id}\`. Your share: ${(Number(p.override_bps ?? 0) / 100).toFixed(2)}% of the platform fee`;
          if (res.override_bps_capped) text += ` (capped from your request to the platform max of ${(Number(res.max_self_serve_bps ?? 0) / 100).toFixed(2)}%)`;
          text += ".";
          if (p.slug) text += `\n\nYour community URL: ${MARKET_LINK_BASE}/${p.slug}`;
          text += `\n\nNext: firestarter_market_link with program_id \`${p.id}\` to get a share code. Members who join through it have their purchases (and, when enabled, their sales) attributed to you. Earnings: firestarter_market_earnings.`;
          return { content: [{ type: "text" as const, text }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "SLUG_TAKEN") {
            return { content: [{ type: "text" as const, text: `That handle (\`${handle}\`) is already taken. Pick a different one and try again — the market was not created.` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "INVALID_SLUG") {
            return { content: [{ type: "text" as const, text: `That handle isn't valid: ${toErrorMessage(err)}. The market was not created — retry with a valid handle, or omit it.` }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Error creating market: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_market_link",
      "Mint a shareable join code for a market you own (from firestarter_create_market). Give the code to your community — when a member redeems it (firestarter_join_market) they are attributed to your program (first-touch, ~90-day lock) so you earn on their activity. Optionally tag a channel/campaign for tracking.",
      {
        program_id: z.string().describe("The market/program id from firestarter_create_market."),
        channel: z.string().optional().describe("Optional channel tag, e.g. 'discord', 'x', 'telegram'."),
        campaign: z.string().optional().describe("Optional campaign tag for tracking."),
      },
      async ({ program_id, channel, campaign }) => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/links", { program_id, channel, campaign });
          const code = res.link?.code;
          if (!code) return { content: [{ type: "text" as const, text: "Link created but no code was returned." }], isError: true };
          return { content: [{ type: "text" as const, text: `**Share link:** ${MARKET_LINK_BASE}/${code}\n(share code: \`${code}\`)\n\nGive this to your community. Each member joins once (first-touch, locks ~90 days) — opening the link, or pasting the code to their Firestarter agent (firestarter_join_market), joins your market. Prefer a memorable URL? Claim a handle with firestarter_set_market_handle and ${MARKET_LINK_BASE}/<handle> resolves to the same market.` }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error creating share link: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_set_market_handle",
      "Claim or change the vanity handle for a market you already own (from firestarter_create_market), so its URL is firestarter.network/m/<handle> instead of a random share code. Use when an owner wants a memorable community link, or to rename an existing handle. The handle is stable even if the underlying share code is rotated, and resolves to the same market as the code. It must be unique across Firestarter; the API rejects one that is already taken, reserved, or shaped like a share code.",
      {
        program_id: z.string().describe("The market/program id from firestarter_create_market."),
        handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/i, "handle must be 2-31 chars: letters, digits and hyphens, starting with a letter or digit").describe("Vanity handle for the community URL — firestarter.network/m/<handle>. 2-31 chars: letters, digits and hyphens, must start with a letter or digit. Case is ignored (normalized to lowercase). Must be unique; reserved words and share-code-shaped strings are rejected."),
      },
      async ({ program_id, handle }) => {
        try {
          const res = await apiRequest("PATCH", `/v1/attribution/programs/${encodeURIComponent(program_id)}`, { slug: handle.toLowerCase() });
          const slug = res.program?.slug ?? handle.toLowerCase();
          return { content: [{ type: "text" as const, text: `**Handle set.** Your community URL is now ${MARKET_LINK_BASE}/${slug}\n\nShare it anywhere — it resolves to the same market as your share code and stays stable if you rotate the code.` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "SLUG_TAKEN") {
            return { content: [{ type: "text" as const, text: `That handle (\`${handle}\`) is already taken. Pick a different one and try again.` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "INVALID_SLUG") {
            return { content: [{ type: "text" as const, text: `That handle isn't valid: ${toErrorMessage(err)}.` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "PROGRAM_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No market on your account has that program id. Create one first with firestarter_create_market, then set its handle." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't set the handle: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_market_earnings",
      "Show the earnings of the markets you own: override earnings pending vs paid out, and transaction counts. Use when a community owner asks how much they have earned or wants their attribution dashboard.",
      {},
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/attribution/earnings");
          return { content: [{ type: "text" as const, text: "```json\n" + JSON.stringify(res, null, 2) + "\n```" }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error fetching earnings: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_join_market",
      "Join a community market using its share code, so the caller's purchases (and, when enabled, their sales) are attributed to that community and it earns its share. First-touch: the first market joined locks for ~90 days. Use when a user pastes a Firestarter join/market code or asks to join a community's market.",
      {
        code: z.string().describe("The market share code the community gave you."),
        force: z.boolean().optional().describe("Set true only after the buyer explicitly confirms switching from another locked community."),
      },
      async ({ code, force }) => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/redeem", { code, force: force === true });
          let lead = "**Joined the market.** Your future buys (and sells, when that's enabled) credit this community.";
          if (res.idempotent) lead = "You're already in this market — nothing changed.";
          if (res.replaced) lead = `Joined — your attribution moved to this market${force ? " after your explicit switch confirmation" : " (the previous lock had expired)"}.`;

          // PR #337 made the public community contract stable enough to turn a
          // successful join into an actionable onboarding response. Best effort:
          // a public-page miss must never undo or misreport a completed join.
          try {
            const publicView = await apiRequest("GET", `/marketplace/community/${encodeURIComponent(code)}`);
            const community = publicView?.community;
            if (community?.name) {
              const lines = [lead, "", `**Welcome to ${community.name}.**`];
              if (community.tagline) lines.push(community.tagline);

              const picks = Array.isArray(community.picks) ? community.picks.slice(0, 3) : [];
              if (picks.length > 0) {
                lines.push("", "A few community picks:");
                for (const pick of picks) {
                  const price = Number.isFinite(Number(pick.price)) ? ` — $${Number(pick.price).toFixed(2)}` : "";
                  lines.push(`- ${pick.product_name}${price} (listing_id: ${pick.listing_id})`);
                }
                lines.push("", `Next: choose a pick and call firestarter_execute with its exact listing_id (for example, ${picks[0].listing_id}).`);
              } else {
                const categories = Array.isArray(community.top_categories) ? community.top_categories.slice(0, 3) : [];
                if (categories.length > 0) lines.push("", `Popular here: ${categories.join(", ")}.`);
                lines.push("", "Next: search this market for something you need, then review the quote before approving a purchase.");
              }
              lead = lines.join("\n");
            }
          } catch {
            /* onboarding enrichment is best-effort after a successful join */
          }

          return { content: [{ type: "text" as const, text: lead }] };
        } catch (err: any) {
          const msg = toErrorMessage(err);
          if (/locked/i.test(msg)) return { content: [{ type: "text" as const, text: "You're locked to another market right now. Ask the buyer to confirm the switch, then call this tool again with `force: true`." }] };
          return { content: [{ type: "text" as const, text: `Couldn't join: ${msg}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_my_market",
      "Show which community market the buyer is currently connected to (if any): the community name, join code, program status, and how long the first-touch lock lasts. Use when a buyer asks 'what market am I in?', 'am I connected to a community?', or before joining/leaving so you can confirm the current state. Read-only.",
      {},
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/attribution/me");
          const community = res?.community ?? null;
          if (!community || community.connected !== true) {
            return { content: [{ type: "text" as const, text: "You're not connected to any community market. Paste a share code and I can join one for you (firestarter_join_market)." }] };
          }
          const lines = [
            `**Connected to:** ${community.name}`,
            community.code ? `Join code: \`${community.code}\`` : null,
            `Status: ${community.program_status}`,
            community.locked_until ? `Locked until: ${new Date(community.locked_until).toISOString().slice(0, 10)} (first-touch lock)` : null,
            community.attributed_at ? `Joined: ${new Date(community.attributed_at).toISOString().slice(0, 10)}` : null,
            "\nYour buys (and sells, when enabled) credit this community. To leave, use firestarter_leave_market.",
          ].filter(Boolean);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't check your market: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_leave_market",
      "Disconnect (delink) the buyer from their current community market so future orders no longer credit it. Use when a buyer asks to leave/disconnect a community, or wants to switch and the first-touch lock has expired. Already-earned credit on past orders still clears; only future activity stops being attributed. Confirm with the buyer before calling — this is an account-level change.",
      {},
      async () => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/disconnect", {});
          if (res?.disconnected === true) {
            return { content: [{ type: "text" as const, text: "**Left the market.** Your future orders no longer credit that community. You can join another anytime with a share code (firestarter_join_market)." }] };
          }
          return { content: [{ type: "text" as const, text: "You weren't connected to any community market — nothing to leave." }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't leave the market: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );
  }
}
