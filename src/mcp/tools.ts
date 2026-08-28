/**
 * Shared MCP tool definitions.
 * Used by both the stdio server (server.ts) and the HTTP route (route.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { marginCentsFor } from "../lib/margin.js";
import { isRelevantMatch } from "../lib/relevance.js";
import { previewOutputShape, toPreviewStructured, PREVIEW_REASON_LABELS, catalogOutputShape, toCatalogStructured, sellerListingsOutputShape, toSellerListingsStructured, shelfOutputShape, toShelfStructured } from "./schemas.js";
import { SHARE_LINK_BASE, listingShareUrl } from "../lib/share-link.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { registerShoppingApp, SHOPPING_RESULTS_URI, SHOPPING_RESULTS_STABLE_URI } from "./shopping-app.js";
import { isWidgetCall } from "./ui/widget-call.js";
import { enforceSchemaDialect } from "./schema-dialect.js";
import { sanitizeUntrusted, neutralizeAuthority } from "./untrusted.js";
import { safeVideos, videoLines, displayRating } from "./media.js";
import { getPlatformAdapters } from "../platform.js";
import { listingDetailFields } from "../schemas/listing-details.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

export const API_REQUEST_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_API_TIMEOUT_MS || 12_000);

// ─── Server-side image-ingest budgets we must outlast (commerce#849) ─────────
//
// These mirror constants in apps/api/src/services/image-store.ts. They live
// here as named values, not as magic numbers folded into a timeout, because a
// client budget is only ever right RELATIVE to what the server is allowed to
// spend — and the two move in different repos on different release trains.
// If the API's figures change, these are what has to change with them.
//
//   MAX_IMAGE_FETCH_REDIRECTS = 3  → up to 4 hops
//   IMAGE_FETCH_TIMEOUT_MS    = 10_000 per hop
//   INGEST_BUDGET_MS          = 20_000 for a whole listing (up to 12 photos)
/** One remote image, worst case: 4 redirect hops at 10s each. */
export const SERVER_SINGLE_IMAGE_INGEST_WORST_CASE_MS = 40_000;
/** A listing write's whole-gallery ingest budget, server-side. */
export const SERVER_LISTING_INGEST_BUDGET_MS = 20_000;

// commerce#849: firestarter_upload_image makes the API fetch and re-host a
// remote image — the SAME server-side work as a dispute attachment, which
// already carries 60s for exactly this reason. On the plain 12s budget the
// client abandoned uploads the server was still completing, so a seller saw
// "the upload timed out" and retried until their Claude quota ran out, which
// is the report in #849 verbatim.
export const UPLOAD_IMAGE_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_UPLOAD_IMAGE_TIMEOUT_MS || 60_000);
// A listing create/update carrying image_urls ingests the whole gallery inside
// the request (20s budget), then runs prohibited-item checks and the activation
// gates on top. 12s could not cover the ingest alone.
export const LISTING_WRITE_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_LISTING_WRITE_TIMEOUT_MS || 45_000);

/**
 * The budget for one listing write: the longer one only when the body actually
 * carries media the API has to go and fetch.
 *
 * A timeout is a ceiling, not a delay, so widening it unconditionally would
 * cost nothing in the happy path — but it would also make a genuinely hung
 * text-only PATCH hang four times as long before the agent could say so.
 * Media is the thing that makes the request slow, so media is what earns the
 * headroom.
 */
export function listingWriteTimeoutMs(body: Record<string, unknown>): number {
  const images = body.images;
  const videos = body.video_urls;
  const carriesMedia =
    (Array.isArray(images) && images.length > 0) || (Array.isArray(videos) && videos.length > 0);
  return carriesMedia ? LISTING_WRITE_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
}
// Listing import fetches the source page server-side (10s cap) and may run an
// LLM extraction on top - it needs more than the default API budget.
const IMPORT_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_IMPORT_TIMEOUT_MS || 25_000);
// Evidence submission runs a vision soft-check server-side - same headroom.
const VERIFY_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_VERIFY_TIMEOUT_MS || 25_000);
// Dispute attachments: the API INGESTS a remote image (commerce#749), so its
// own worst case is a redirect chain at ~10s a hop. A 25s client timeout gave
// up while the server was still succeeding — reported as a failed attach while
// the blob was stored and referenced by nothing.
export const ATTACHMENT_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_ATTACHMENT_TIMEOUT_MS || 60_000);
/** The dispute message endpoint stores at most this many attachments. */
const MAX_DISPUTE_ATTACHMENTS = 5;
// Keyless preview runs a live multi-source product search (Google Shopping +
// Shopify + catalog). A cold cache can take ~25-30s - well past the 12s default -
// so it needs its own budget, or every cold "what can you get me?" fails with a
// spurious "Firestarter API timed out". Warm-cache hits are sub-second.
// Prod logs show server-side preview latency already peaking at 27s; adding the
// agent -> MCP -> gateway -> API hops on top pushed occasional cold runs past a
// 30s cap and surfaced intermittent aborts in the agent, so the budget is 45s.
const PREVIEW_TIMEOUT_MS = Number(process.env.FIRESTARTER_MCP_PREVIEW_TIMEOUT_MS || 45_000);
const POLL_INTERVAL_MS = Number(process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS || 2_500);
// Community-market join pages (GET /m/:handle) — resolves either a random share
// code or a claimed vanity handle to the same market.
const MARKET_LINK_BASE = process.env.MARKET_LINK_BASE || "https://firestarter.network/m";

// Where a seller uploads a product photo and gets back a hosted image URL.
// MCP clients (e.g. Claude Desktop) that forward user-attached images as base64
// can use the firestarter_upload_image tool directly. The dashboard URL is kept
// as a fallback for clients that cannot encode the image into a tool argument.
const SELLER_DASHBOARD_URL = process.env.SELLER_DASHBOARD_URL || "https://firestarter.network/seller";
/** Buyer billing/settings tab — where a card is added or replaced. */
const DASHBOARD_SETTINGS_URL =
  process.env.DASHBOARD_SETTINGS_URL || "https://firestarter.network/dashboard?tab=settings";

/** What GET /v1/sellers/payout-method serves about the selling gate (#949). */
export interface SellingGate {
  hold_cap_cents?: number;
  max_age_days?: number;
  age_min_cents?: number;
}

/**
 * Is this the message toErrorMessage produces for a timeout/abort?
 *
 * Callers that need to give timeout-specific advice ask here rather than
 * re-sniffing the raw error, so there is one definition of "timed out" and it
 * cannot drift from the string toErrorMessage actually returns.
 */
export function isTimeoutMessage(msg: string): boolean {
  return /timed out|aborted/i.test(msg);
}

/**
 * When a payout-less seller stops selling — rendered from what the API serves,
 * never from a number compiled into this package.
 *
 * commerce#949: this sentence used to carry the thresholds as literals in six
 * places. commerce#942 moved the age from 30 days to 90 and added a floor
 * ($100) below which the age rule never fires at all, and this package went on
 * saying "30 days" — telling sellers a number the gate had stopped enforcing
 * the moment #942 promoted.
 *
 * A corrected literal would not have fixed it. Remote MCP serves a PINNED
 * version, so any hard-coded figure is wrong for every deploy between the
 * constant moving and the pin moving. commerce/apps/web has a CI guard for the
 * same drift and it cannot see this repository.
 *
 * When the API does not supply the numbers — an older deployment, or a caller
 * with no seller account — the rule is stated WITHOUT them. Vague and true
 * beats precise and wrong: a seller who is told the wrong threshold plans
 * around it.
 */
export function sellingGateSentence(gate?: SellingGate | null): string {
  const cap = typeof gate?.hold_cap_cents === "number" ? `$${(gate.hold_cap_cents / 100).toLocaleString()}` : null;
  const days = typeof gate?.max_age_days === "number" ? gate.max_age_days : null;
  const floor = typeof gate?.age_min_cents === "number" ? `$${(gate.age_min_cents / 100).toLocaleString()}` : null;

  if (cap && days != null) {
    const age = floor
      ? `the oldest hold is ${days} days old with at least ${floor} held`
      : `the oldest hold is ${days} days old`;
    return `selling pauses automatically only once held earnings reach ${cap} or ${age}`;
  }
  return "selling pauses automatically only once held earnings pass a cap, or the oldest hold has been waiting a long time — call `firestarter_payouts` for the current thresholds";
}

export function toErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Authentication/credential failures must not be relayed as a generic
  // "shopping service" outage. The upstream agent (e.g. the WhatsApp/Cole bridge)
  // otherwise tells the buyer the search failed — and may fabricate that a search
  // ran. Nothing is searched on these: auth runs before any provider/execution
  // call.
  //
  // #556: but a 401 is not always "the key is dead". Only the codes the API-key
  // middleware emits for a genuinely bad key (INVALID_KEY / INVALID_KEY_FORMAT)
  // earn the "re-provision" instruction — an API key sent to a JWT-only
  // user-session route 401s with INVALID_TOKEN, and telling the operator to
  // re-provision a perfectly good key sends them down the wrong path.
  if (err instanceof ApiError) {
    const isAuthCode =
      err.code === "INVALID_KEY" || err.code === "INVALID_KEY_FORMAT" || err.code === "MISSING_AUTH";
    if (err.status === 401 || isAuthCode) {
      // commerce#824: an expired OAuth grant is NOT a revoked key. Saying
      // "re-provision" here sent operators after a credential that only
      // needed a refresh — and agents relayed "your key is revoked" to
      // sellers whose connector was fine an hour earlier.
      if (err.code === "EXPIRED_KEY") {
        return "Authentication failed: the Firestarter OAuth authorization has EXPIRED (access tokens last about an hour). This is normal token aging, not a dead credential — do not tell anyone to replace their API key. The client must re-authorize: its next request receives a refresh challenge automatically, or the user can reconnect the Firestarter connector. No search was performed.";
      }
      if (err.code === "INVALID_KEY" || err.code === "INVALID_KEY_FORMAT") {
        return "Authentication failed: the Firestarter API key is invalid or revoked. This is a credential/configuration problem, not a product-search outage — no search was performed. Do not retry; the integration's API key must be re-provisioned.";
      }
      if (err.code === "MISSING_AUTH") {
        return "Authentication failed: no credentials reached the Firestarter API (missing Authorization header). This is an integration configuration problem, not an outage — no search was performed. Do not retry until the integration attaches its API key.";
      }
      if (err.code === "INVALID_TOKEN") {
        return "Authentication failed: this endpoint expects a signed-in user session (JWT) and rejected the API key. The key itself may be perfectly valid — do NOT re-provision it. The integration is calling a user-session endpoint with an API key; fix the endpoint or auth scheme. No search was performed.";
      }
      return `Authentication failed (${err.code || "401"}): ${msg} This is a credential/configuration problem, not a product-search outage — no search was performed.`;
    }
  }
  if (msg.includes("timed out") || msg.includes("aborted")) {
    return "Firestarter API timed out. Please retry in a few seconds.";
  }
  return msg;
}

/** Strip backslashes LLMs sometimes inject when markdown-escaping underscores/hyphens in IDs. */
function cleanListingId(id: string): string {
  const s = id.replace(/\\/g, "").trim();
  // Accept a share link anywhere a listing id is: several tool descriptions
  // promise "also parsed from a firestarter.network/l/<id> share link", and
  // buyers paste exactly that. Extract the id from any .../l/<id> URL.
  const m = /\/l\/(lst_[A-Za-z0-9_-]+)/.exec(s);
  return m ? m[1] : s;
}

/** One-line human description of what a voucher takes off. */
function describeVoucherValue(v: {
  discount_type?: string;
  discount_percent?: number | null;
  discount_amount_cents?: number | null;
}): string {
  if (v.discount_type === "free_shipping") return "free shipping";
  if (v.discount_type === "fixed") return `$${((v.discount_amount_cents ?? 0) / 100).toFixed(2)} off`;
  return `${v.discount_percent ?? 0}% off`;
}

// ─── Community-market shelf (agent-facing) ───────────────────────────────────
// The buyer-facing web page (/m/<handle>) shows a community's curated shelf —
// the owner's product picks with their notes. The public marketplace endpoint
// already returns that shelf, so the market tools can surface it too instead of
// a flat "Joined." confirmation with no next step. Shared here so join / preview
// / my_market render the shelf identically.

/** How many shelf picks to render in one chat message — enough to be useful,
 *  few enough to stay scannable. Matches the join-page "taste" framing. */
const SHELF_RENDER_LIMIT = 6;

/**
 * Fetch a community's PUBLIC view (name, tagline, curated shelf, social proof)
 * by share code or vanity handle. Uses the unauthenticated marketplace endpoint,
 * so it returns exactly what a signed-out human sees on /m/<handle>. Best-effort:
 * resolves to null on any failure, so callers can degrade to their status-only
 * message rather than failing the whole tool over branding.
 */
async function fetchPublicCommunity(
  apiRequest: ReturnType<typeof makeApiRequest>,
  code: string,
): Promise<any | null> {
  try {
    const res = await apiRequest("GET", `/marketplace/community/${encodeURIComponent(code)}`);
    return res?.community ?? null;
  } catch {
    return null;
  }
}

/**
 * Render a community's curated shelf as chat text, or null when there is nothing
 * to show. Each pick carries its `listing_id` (lst_…) so the agent can pass it
 * straight to firestarter_execute — the shelf is an actionable next step, not
 * just a list.
 *
 * Framing is deliberate and must not overpromise: JOINING itself gives the buyer
 * no automatic discount or cashback. The community earns a share of Firestarter's
 * fee "at no extra cost to you, never from the seller's payout"; the buyer's
 * benefit is curation and supporting the community. A community MAY separately
 * fund drops (real discounts the buyer claims before checkout), which this shelf
 * surfaces per pick — but never phrase JOINING itself as a buyer perk/benefit.
 */
function formatCommunityShelf(community: any): string | null {
  const picks: any[] = Array.isArray(community?.picks) ? community.picks : [];
  if (picks.length === 0) return null;
  const name =
    typeof community?.name === "string" && community.name.trim() ? community.name.trim() : "this community";

  const lines: string[] = [`**What ${sanitizeUntrusted(name, 120) || "this community"} recommends:**`];
  for (const p of picks.slice(0, SHELF_RENDER_LIMIT)) {
    // Same two fields toCatalogStructured sanitises, reaching the buyer through
    // market_preview / join_market / my_market instead of catalog_search.
    const nm = sanitizeUntrusted(p?.product_name) || "Untitled";
    const price = Number.isFinite(Number(p?.price)) ? `$${Number(p.price).toFixed(2)}` : "price at checkout";
    const noteText = sanitizeUntrusted(p?.note);
    const note = noteText ? ` — "${noteText}"` : "";
    const id = typeof p?.listing_id === "string" && p.listing_id ? ` (listing_id: \`${p.listing_id}\`)` : "";
    lines.push(`• ${nm} — ${price}${note}${id}`);
    const drops: any[] = Array.isArray(p?.drops) ? p.drops : [];
    for (const d of drops) {
      const off = `$${(Number(d?.discount_cents ?? 0) / 100).toFixed(2)} off`;
      if (d?.in_priority_window === true && Number(d?.min_tier ?? 0) > 0) {
        lines.push(`  🔥 ${off} · early access for tier ${Number(d.min_tier)}+`);
      } else {
        const left = Number(d?.remaining ?? 0);
        lines.push(`  🔥 ${off} · ${left} slot${left === 1 ? "" : "s"} left — claim before checkout`);
      }
    }
  }
  if (picks.length > SHELF_RENDER_LIMIT) {
    lines.push(`…and ${picks.length - SHELF_RENDER_LIMIT} more.`);
  }
  lines.push(
    // Same sanitation as the header — the community name is owner-controlled
    // text reaching a BUYER, and this footer previously interpolated it raw.
    `\nBuy any of these and ${sanitizeUntrusted(name, 120) || "this community"} earns a share of Firestarter's fee — at no extra cost to you. ` +
    `Want one? I can price it for checkout: pass its listing_id to firestarter_execute.`,
  );
  return lines.join("\n");
}

/**
 * Render what the community SELLS — its own listings, disjoint from the shelf
 * by construction (the API refuses own listings as picks precisely because
 * they belong here). Until this existed, a seller-owned community with an
 * empty shelf previewed as an empty market (QA 2026-08-10). Null when the
 * community sells nothing, so callers fall back cleanly. Exported for tests.
 */
export function formatCommunitySells(community: any): string | null {
  const sells: any[] = Array.isArray(community?.sells) ? community.sells : [];
  if (sells.length === 0) return null;
  const name =
    typeof community?.name === "string" && community.name.trim() ? community.name.trim() : "this community";
  // Same sanitation as the picks shelf: these names are seller-controlled
  // text reaching a BUYER — the sells list previously rendered them raw.
  const lines: string[] = [`**What ${sanitizeUntrusted(name, 120) || "this community"} sells:**`];
  for (const s of sells.slice(0, SHELF_RENDER_LIMIT)) {
    const nm = sanitizeUntrusted(s?.product_name) || "Untitled";
    const price = Number.isFinite(Number(s?.price)) ? `$${Number(s.price).toFixed(2)}` : "price at checkout";
    const id = typeof s?.listing_id === "string" && s.listing_id ? ` (listing_id: \`${s.listing_id}\`)` : "";
    lines.push(`• ${nm} — ${price}${id}`);
  }
  return lines.join("\n");
}

/**
 * Render seller analytics. Revenue counts only LIVE, paid orders — but
 * firestarter_seller_orders lists every order a seller has, test-mode and
 * unpaid ones included, so the two surfaces can legitimately show different
 * counts. Printing a bare "$0.00" next to a 17-line order list is what turned
 * that into a bug report (firestarter-commerce#726), so whenever orders exist
 * that revenue does NOT count, say which ones and why. Silence otherwise —
 * a seller whose figures already add up gets no extra noise.
 *
 * Tolerates an API response without the newer fields (older api deployments):
 * the reconciliation lines simply don't render. Exported for tests.
 */
/**
 * Render the developer-margin config (commerce#977).
 *
 * The API speaks basis points; a person asking for this says "10%". Both are
 * printed — the percentage is what was asked for, the bps is what every API
 * field and error message quotes back.
 *
 * `earnings` is nullable on purpose: the read tool fetches margin and earnings
 * separately, and a failed earnings call must not become a confident
 * "$0.00 earned". Missing beats wrong on a money read — the same rule
 * firestarter_spend_cap follows for month-to-date spend.
 */
export function formatDeveloperMargin(cfg: any, earnings: any | null): string {
  const money = (cents: unknown) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  const bps = Math.max(0, Number(cfg?.margin_bps) || 0);
  const maxBps = Math.max(0, Number(cfg?.max_margin_bps) || 1000);
  const pct = (n: number) => `${Number((n / 100).toFixed(2))}%`;

  const head = bps === 0
    ? "**No developer margin set.** Purchases through this organization's API keys are charged at the seller's price, with nothing added."
    : `**Developer margin: ${pct(bps)}** (${bps} bps)`;

  const limits =
    `\nCeiling: ${pct(maxBps)} (${maxBps} bps), capped at ` +
    `${money(cfg?.max_margin_cents_per_transaction ?? 5000)} per transaction.`;

  // Worth saying plainly what this money IS: a margin is added ON TOP of the
  // item total and paid by the buyer, whereas the other bps-shaped setting on
  // this platform (a market's share_bps) comes OUT of Firestarter's fee and
  // costs the buyer nothing. Confusing the two is what commerce#977 was about.
  const what = "\nAdded on top of the item total, disclosed to the buyer, and paid to this organization when the seller is paid.";

  let earned = "";
  if (earnings) {
    const pending = Number(earnings.pending_cents) || 0;
    const released = Number(earnings.released_cents) || 0;
    const txns = Math.max(0, Number(earnings.transactions) || 0);
    earned = `\n\nEarned so far: ${money(released)} paid out, ${money(pending)} pending, across ${txns} transaction${txns === 1 ? "" : "s"}.`;
    if (pending > 0 && !cfg?.payout_account_connected) {
      earned += "\n⚠️ No payout account connected — margin keeps accruing but cannot be transferred until one is (firestarter_connect_payouts).";
    }
  }

  return `${head}${limits}${what}${earned}`;
}

export function formatSellerAnalytics(data: any): string {
  const money = (cents: unknown) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  const count = (v: unknown) => Math.max(0, Number(v) || 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const orders = count(data?.orders);
  const testOrders = count(data?.test_orders);
  // orders_recorded counts rows in `orders`; live + test count ledger rows.
  // The remainder is orders that never produced one — unpaid, or created
  // outside the pay path.
  const unpaid = Math.max(0, count(data?.orders_recorded) - orders - testOrders);

  let text = "**Seller Analytics**\n";
  text += `Total revenue: ${money(data?.revenue_cents)}\n`;
  text += `Total orders: ${orders}\n`;
  text += `Average order: ${money(data?.avg_order_cents)}\n`;

  if (testOrders > 0) {
    text += `\n${plural(testOrders, "order")} ${testOrders === 1 ? "is" : "are"} in test mode `
      + `(${money(data?.test_revenue_cents)}) and excluded above — test mode moves no real money.\n`;
  }
  if (unpaid > 0) {
    text += `\n${plural(unpaid, "order")} ${unpaid === 1 ? "is" : "are"} not yet paid, `
      + `so ${unpaid === 1 ? "it doesn't" : "they don't"} count toward revenue.\n`;
  }

  if (data?.daily?.length > 0) {
    text += `\n**Last 30 days:**\n`;
    for (const d of data.daily.slice(-7)) {
      text += `  ${d.date}: ${money(d.revenue_cents)} (${plural(count(d.orders), "order")})\n`;
    }
    if (data.daily.length > 7) text += `  ... and ${data.daily.length - 7} more days\n`;
  }
  return text;
}

/**
 * Render the "what this community offers" block: the tier ladder (only when
 * meaningful) and bucketed social proof. Returns null when there is nothing to
 * show. Framing: tiers are ACCESS, never money; social proof is bucketed, never
 * exact. `memberTierIndex` (my_market only) marks the viewer's current rung.
 */
function formatCommunityOffers(community: any, memberTierIndex: number | null = null): string | null {
  const blocks: string[] = [];

  const tiers = community?.tiers;
  const ladder: any[] = Array.isArray(tiers?.ladder) ? tiers.ladder : [];
  if (tiers?.meaningful === true && ladder.length > 0) {
    const rungs = ladder.map((t: any, i: number) => {
      const orders = Number(t?.min_orders ?? 0);
      const req = i === 0 ? "join" : `${orders} order${orders === 1 ? "" : "s"}`;
      const here = memberTierIndex != null && memberTierIndex === i ? " — you're here" : "";
      const perk = i === ladder.length - 1 ? " · first look at new picks" : "";
      const nm = typeof t?.name === "string" && t.name.trim() ? t.name.trim() : `Tier ${i}`;
      return `· ${nm} (${req})${here}${perk}`;
    });
    blocks.push(`**Member tiers — earn early access:**\n${rungs.join("\n")}`);
  }

  const proof = [
    community?.member_count_bucket && community.member_count_bucket !== "0" ? `${community.member_count_bucket} members` : null,
    community?.order_count_bucket && community.order_count_bucket !== "0" ? `${community.order_count_bucket} orders driven` : null,
    typeof community?.active_since === "string" && community.active_since ? `active since ${community.active_since}` : null,
  ].filter(Boolean);
  if (proof.length > 0) blocks.push(`★ ${proof.join(" · ")}`);

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/**
 * Format money for display. Currency-aware: only USD gets a bare `$`.
 *
 * Checkout can only charge USD (CHARGEABLE_CURRENCIES in the API), so a
 * listing priced in anything else stays browse-only — but it is still SHOWN,
 * and the option renderer used to print a hardcoded `$` in front of it. A
 * THB 255 listing read as "$255.00": right number, wrong currency, ~7x wrong
 * price. Also fixes the raw interpolation: `${opt.subtotal}` printed "13.6"
 * for 13.6 where every other money line printed two decimals.
 */
function money(amount: unknown, currency?: unknown): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? "");
  const code = typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase() : "USD";
  return code === "USD" ? `$${n.toFixed(2)}` : `${code} ${n.toFixed(2)}`;
}


/**
 * `★ 4.6 (12)` when a real aggregate exists, else null — callers render
 * nothing rather than a hollow "no reviews yet" per row (phase-2 lexicon;
 * the widget's starsLabel mirrors this).
 */
function stars(rating: unknown, count: unknown): string | null {
  const r = Number(rating);
  const c = Number(count);
  if (!Number.isFinite(r) || !Number.isFinite(c) || c <= 0) return null;
  return `\u2605 ${r.toFixed(1)} (${c})`;
}

/**
 * One GFM table for list surfaces (orders, inventory, recent executions) so
 * every table in the product has identical bones: same header treatment, a
 * hard row cap with an HONEST "N more" line instead of silent truncation, and
 * cell text pipe-escaped so seller-controlled strings can't break the row.
 * Renders fine as plain text in hosts without table support (aligned pipes).
 */
function mdTable(headers: string[], rows: string[][], opts: { cap?: number; moreHint?: string } = {}): string {
  const cap = opts.cap ?? 20;
  // NB: the replacement needs a DOUBLE backslash in source — "\|" in a JS
  // string literal is just "|", which made this a no-op: a | inside a cell
  // (e.g. a buyer's request text "A | B") split its table row into extra
  // columns. Cells that pass through sanitizeUntrusted were shielded by
  // accident; raw cells (the buyer's own request text) were not.
  //
  // Backslashes are escaped FIRST: without that, cell text "a\|b" becomes
  // "a\\|b" — an escaped backslash followed by a BARE pipe — which still
  // splits the row. Escaping order makes both characters inert.
  const esc = (v: string) =>
    v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n?|\n/g, " ");
  const line = (cells: string[]) => `| ${cells.map(esc).join(" | ")} |`;
  const out = [line(headers), `|${headers.map(() => " --- ").join("|")}|`];
  for (const r of rows.slice(0, cap)) out.push(line(r));
  if (rows.length > cap) out.push(`\n_…and ${rows.length - cap} more${opts.moreHint ? ` — ${opts.moreHint}` : ""}._`);
  return out.join("\n");
}

/**
 * Google Shopping thumbnail URLs (encrypted-tbn*.gstatic.com) are ~150 chars
 * of opaque token, EXPIRE, and are one per option — five of them turn an
 * options list into a wall of dead links. They stay in structuredContent for
 * the widget; they just don't belong in the prose.
 */
function isTransientThumbnail(url: string): boolean {
  return /^https?:\/\/encrypted-tbn\d*\.gstatic\.com\//i.test(url);
}

/**
 * Render a URL as a MARKDOWN HYPERLINK, or return null when it isn't one we
 * will make clickable.
 *
 * Tool results are markdown, but a bare URL is only auto-linked by renderers
 * that implement the GFM autolink extension — several MCP clients do not, so
 * every link we emitted was dead text the user had to select and copy. The
 * fix is an explicit `[label](url)`, applied where a human actually wants to
 * CLICK something.
 *
 * Deliberately NOT applied to product image URLs: those are on their own line
 * so chat clients auto-unfurl a preview and agents can fetch the bytes (#611).
 * Wrapping them in link syntax breaks the unfurl and gains nothing — nobody
 * wants to click a JPEG. Keeping them bare is also what keeps link density
 * sane on a 50-row catalogue.
 *
 * SECURITY: labels are frequently seller-controlled (product names, community
 * names). An unescaped `]` lets a listing called `Mug](https://evil.example)`
 * close the link text and retarget it, so brackets are stripped from labels
 * and `)` is percent-encoded in targets. https only — never javascript:/data:.
 */
function mdLink(label: string, url: unknown): string | null {
  if (typeof url !== "string") return null;
  const target = url.trim();
  if (!/^https:\/\/[^\s<>]+$/i.test(target)) return null;
  const safeLabel = label.replace(/[[\]]/g, "").trim();
  if (!safeLabel) return null;
  return `[${safeLabel}](${target.replace(/\)/g, "%29")})`;
}

/**
 * Hyperlink whose LABEL is the URL itself, minus the scheme
 * (`firestarter.network/l/lst_x`). Used for share/community links, where the
 * agent is often told to relay the address itself (a bare share URL unfurls
 * into a product card) — this keeps the address legible and copyable while
 * still being one click for a human. Returns null for a non-https/absent URL,
 * so callers can fall back to their own "no link yet" wording.
 */
function mdUrlLink(url: unknown): string | null {
  if (typeof url !== "string") return null;
  return mdLink(url.trim().replace(/^https:\/\//i, "").replace(/\/+$/, ""), url);}

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
 * Store-connection error_message values often ARE the raw upstream HTTP
 * response (catalog-sync/adapters.ts's apiFetch: `${status} ${statusText}:
 * ${body}`), so the JSON body — with whatever internal fields the upstream
 * API put in it (request_id, logid, numeric error codes) — was being relayed
 * to the seller verbatim. The leading "STATUS TEXT" is genuinely useful
 * context; the raw body belongs in server logs, not seller-facing chat.
 */
function summarizeConnectionError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const statusLineMatch = raw.match(/^(\d{3}\s+[^:]+):\s*\{/s);
  const summary = statusLineMatch ? statusLineMatch[1] : raw;
  return summary.length > 160 ? `${summary.slice(0, 160)}…` : summary;
}

/**
 * Whether it's accurate to tell the seller their catalog is listed/
 * discoverable. status !== 'error' is the easy case. In error state it
 * depends on whether a sync EVER completed: last_synced_at set means
 * previously-synced items are still listed (just stale — the CURRENT sync
 * attempt is failing); no last_synced_at means the connection has never
 * produced a listing at all, so nothing is discoverable yet.
 */
function connectionListedLine(conn: { status?: string; last_synced_at?: string | null }, noun: string): string {
  if (conn.status !== "error") {
    return `Products from this ${noun} are listed on Firestarter and discoverable by buyers' agents.`;
  }
  return conn.last_synced_at
    ? `This connection is currently in an error state — products from the last successful sync remain listed, but recent changes in the ${noun} are NOT reflected.`
    : `This connection is in an error state and has never completed a sync, so nothing from it is listed/discoverable yet.`;
}

/**
 * Non-2xx API responses carry structured bodies (code + extra data, e.g. the
 * possession-verification payload on 409s). Keep them on the thrown error so
 * tool catch blocks can render specifics instead of a flattened string.
 */
export class ApiError extends Error {
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

export function makeApiRequest(
  apiKey: string,
  apiBase: string,
  // commerce#824: lets the transport learn that this key's upstream said
  // "credential dead" mid-session, so it can answer the NEXT request with a
  // real HTTP 401 + WWW-Authenticate instead of letting the client retry a
  // dead OAuth grant forever. Only fired for fs_oauth_ bearers — a refresh
  // cannot resurrect a revoked raw API key.
  onAuthError?: () => void,
) {
  return async function apiRequest(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = API_REQUEST_TIMEOUT_MS,
    extraHeaders?: Record<string, string>,
  ) {
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Firestarter-Source": "mcp",
      ...extraHeaders,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // THE trust boundary. Every string in every API response is third-party
    // text on its way to a foreign agent's context, so authority is stripped
    // once, here, rather than at the ~1100 interpolation sites in this file.
    // Four rounds of per-call-site sanitising still left ~45 counterparty
    // surfaces raw; this covers all 83 tools, every helper, every error relay,
    // every resource in resources.ts, and every tool added later (#599).
    const data = neutralizeAuthority(await res.json());
    if (!res.ok) {
      if (
        res.status === 401 &&
        apiKey.startsWith("fs_oauth_") &&
        (data?.code === "EXPIRED_KEY" || data?.code === "INVALID_KEY")
      ) {
        onAuthError?.();
      }
      // data.error is a STRING on every commerce errorResponse, but anything
      // nonstandard in front of the API (a proxy's JSON error page, a
      // non-commerce upstream) can put an OBJECT there — which stringifies to
      // "[object Object]" in the buyer-facing message. Normalize to prose.
      const errText =
        typeof data?.error === "string" && data.error.trim() ? data.error
          : typeof data?.error?.message === "string" && data.error.message.trim() ? data.error.message
            : typeof data?.message === "string" && data.message.trim() ? data.message
              : `API request failed: ${res.status}`;
      throw new ApiError(errText, res.status, data);
    }
    return data;
  };
}

/**
 * #896: render a terminal dispute state as an outcome rather than an error.
 *
 * These mean the order's money has finished moving — escrow paid out, already
 * refunded, or the dispute already settled — so opening a dispute is not
 * "temporarily unavailable", it is over. Returns null for everything else, so a
 * real failure (a 500, a malformed request, an unknown order) keeps reading as
 * a failure and keeps its retry.
 *
 * The fallbacks are named because a buyer in this position is not out of
 * options — they are out of THIS option, and the difference is the whole point
 * of the report.
 */
const DISPUTE_WINDOW_CLOSED_CODES = new Set([
  "ALREADY_RELEASED",
  "ALREADY_REFUNDED",
  "ALREADY_RESOLVED",
  "ALREADY_DECIDED",
  "ALREADY_ADJUDICATED",
  "HOLD_ALREADY_RELEASED",
]);

function disputeWindowClosedText(err: unknown): string | null {
  if (!(err instanceof ApiError) || !err.code || !DISPUTE_WINDOW_CLOSED_CODES.has(err.code)) return null;
  return (
    `**The dispute window for this order has closed.** ${toErrorMessage(err)}\n\n` +
    `That is not an error on your side and retrying will not change it — once escrow has paid out or the order has been refunded, Firestarter can no longer hold the funds.\n\n` +
    `What you can still do:\n` +
    `- **Message the seller directly** — most problems get resolved this way, and they may refund voluntarily.\n` +
    `- **Ask your bank or card issuer for a chargeback**, if the item never arrived or was materially not as described.\n` +
    `- **Contact Firestarter support** with the order id, and a human can look at the case.`
  );
}

/** Plain-language cause for a possession-verification requirement. */
function verificationWhy(reason: unknown): string {
  return reason === "source_conflict"
    ? "its source URL was already imported by another seller"
    : reason === "luxury_category"
      ? "it is a luxury-category item"
      : reason === "buyer_invite"
        ? "a buyer requested an escrow-protected purchase of this exact item, so possession must be proven before it goes live"
        : "it is a high-value item";
}

/** The three things the seller physically does, shared by both renderers. */
function verificationSteps(code: string): string {
  return (
    `Ask the seller to:\n` +
    `1. Write ${code} by hand on a piece of paper\n` +
    `2. Photograph the paper next to the item - both clearly visible in one shot\n` +
    `3. Send that photo here in chat\n\n`
  );
}

/**
 * Render the possession-verification ask (409 VERIFICATION_REQUIRED) as chat
 * instructions the agent can relay verbatim. Returns null for other errors.
 */
function verificationAskText(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "VERIFICATION_REQUIRED") return null;
  const v = err.body?.verification;
  if (!v?.code) return null;
  return (
    `**Possession verification needed before this listing can go live** (${verificationWhy(v.reason)}).\n\n` +
    `Verification code: **${v.code}**\n\n` +
    verificationSteps(v.code) +
    `Then submit it with firestarter_verify (listing_id + the photo URL). A match auto-approves in seconds - no human review on the happy path.`
  );
}

/**
 * commerce#768: the possession gate is now re-evaluated on any price or
 * category change to an already-live listing, not only at activation. When it
 * trips, the API SAVES the seller's new values but pushes the listing back to
 * draft — arriving as a 200 carrying a `verification` block, not the 409 the
 * activation path returns (that one is verificationAskText's job).
 *
 * Without this seam the tool would print "Listing updated. Base price:
 * $305000" and the seller would never learn their listing had gone dark.
 * Returns "" when the gate did not trip, so callers can append unconditionally.
 */
/**
 * How many members a market has, naming the window when "now" and "ever"
 * disagree (commerce#769). A market nobody has left reads exactly as it did
 * before: "Members: 6".
 */
function membersText(program: unknown): string {
  const p = program as any;
  const now = Number(p?.member_count ?? 0);
  const ever = p?.member_count_all_time === undefined ? now : Number(p.member_count_all_time);
  if (!Number.isFinite(ever) || ever <= now) return `Members: ${now}`;
  return `Members: ${now} now · ${ever} have been, all-time (members who left keep the sales they drove)`;
}

function regateNoticeText(listing: unknown): string {
  const v = (listing as any)?.verification;
  if (v?.status !== "required") return "";

  // Only 'high_value' and 'luxury_category' can be CAUSED by a price/category
  // edit. The API carries a listing's pre-existing reason forward, so one once
  // flagged 'source_conflict' would otherwise be explained to its seller as
  // "its source URL was already imported by another seller" — a cause with
  // nothing to do with the edit they just made. Say nothing rather than that.
  const why = v.reason === "high_value" || v.reason === "luxury_category"
    ? ` (${verificationWhy(v.reason)})`
    : "";

  // The code is only needed for the handwritten note. Degrading to silence when
  // it is absent would reinstate the bare-success bug this function exists to
  // prevent, so the "your listing went dark" half must survive without it.
  const steps = v.code
    ? `\n\nVerification code: **${v.code}**\n\n` + verificationSteps(v.code) +
      `Submit it with firestarter_verify (listing_id + the photo URL), then put the listing back live with ` +
      `firestarter_update_listing (status 'active').`
    : `\n\nCall firestarter_verify with this listing_id to get the code and submit the seller's photo, then put ` +
      `the listing back live with firestarter_update_listing (status 'active').`;

  return (
    `\n**This listing is no longer buyer-visible.** The new price/category needs possession verification${why}, ` +
    `so it has been moved back to draft.${steps}`
  );
}

/**
 * commerce#775/#858: photos the API refused, named.
 *
 * Four commerce producers set `rejected_images` — listing-create.ts, the
 * listings PATCH, and two seller-dashboard routes — and until this function
 * existed the field appeared nowhere in this file. A create that stored 2 of 3
 * photos printed "Photos: 2 attached" and the agent reported success; one that
 * stored 0 of 1 printed the NEEDS_IMAGE block, which reads as "you didn't send
 * a photo" to a seller who did.
 *
 * Not an error: the write succeeded and the listing may well be live. This says
 * what did not make it and why, so the agent can offer the photo again instead
 * of asking the seller to re-send something already in the conversation.
 */
function rejectedPhotosText(listing: unknown): string {
  const rejected = (listing as any)?.rejected_images;
  if (!Array.isArray(rejected) || rejected.length === 0) return "";

  const lines = rejected
    .map((r: any) => {
      // The API pairs every entry with a seller-readable reason. Degrading to
      // the bare URL is still better than silence — the point is that the
      // seller learns a photo is missing at all.
      const url = typeof r?.url === "string" && r.url ? r.url : "a photo";
      const reason = typeof r?.reason === "string" && r.reason ? ` — ${r.reason}` : "";
      return `- ${url}${reason}`;
    })
    .join("\n");

  const n = rejected.length;
  return (
    `\n**${n} photo${n === 1 ? "" : "s"} could not be added:**\n${lines}\n` +
    `\nThe rest of the listing saved normally. Offer to try ${n === 1 ? "it" : "them"} again — if the ` +
    `seller attached the photo in this conversation, call firestarter_upload_image first and pass the ` +
    `hosted URL, rather than asking them to re-send it.\n`
  );
}

/**
 * commerce#858/7: a restock the API accepted but did not republish.
 *
 * `PATCH /v1/listings/:id` answers 200 with `restock_blocked` when stock was
 * written while the listing is held — behind possession verification, or on a
 * moderation hold (#751). It used to read as a plain "Listing updated", so a
 * seller restocking a held listing believed they were back on sale and had no
 * way to find out why no orders came.
 */
function blockedRestockText(listing: unknown): string {
  const message = (listing as any)?.restock_blocked?.message;
  if (typeof message !== "string" || !message) return "";
  return `\n**The stock change saved, but the listing did not go back on sale.** ${message}\n`;
}


/**
 * commerce#749/#786: attach evidence to a dispute and post the message.
 *
 * Shared by firestarter_disputes (buyer, /buyer/disputes) and
 * firestarter_seller_disputes (seller, /v1/sellers/disputes). Both sides get
 * the same hosted-URL ingest, the same combined 5-attachment cap, and the same
 * refusal to report a clean success when evidence did not land — a second copy
 * would drift, and every one of these behaviours was a bug the first time.
 */
async function postDisputeMessage(
  apiRequest: ReturnType<typeof makeApiRequest>,
  basePath: string,
  did: string,
  input: { message?: string; image_urls?: string[]; image_base64?: string },
  audience: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { message, image_urls, image_base64 } = input;
  // Dedup: the same URL sent twice would be fetched, stored and shown to the
  // counterparty twice, and would burn two of the five slots.
  const rawUrls = [...new Set((image_urls || []).filter((u): u is string => typeof u === "string" && u.trim() !== ""))];
  // A data: URI in image_urls is the exact mistake the description warns
  // against — name it rather than forwarding it to be rejected as "not a
  // public image", which tells the model nothing about what it did wrong.
  if (rawUrls.some((u) => !/^https?:\/\//i.test(u))) {
    return textBlockOf("image_urls takes public http(s) links only. If you have the raw bytes of an image (a data: URI), pass it as image_base64 instead — one image per call.", true);
  }
  if ((!message || !message.trim()) && !rawUrls.length && !image_base64) {
    return textBlockOf("Add a note (message) or a photo (image_urls) to post to the dispute.", true);
  }

  // ONE list, capped once: the message endpoint keeps 5 attachments, so capping
  // image_urls and image_base64 separately let 6 through and the 6th was
  // dropped server-side while the tool reported it attached.
  // image_base64 FIRST: if the cap has to drop something, drop a URL, which can
  // be re-fetched. Raw bytes the agent is holding cannot be recovered.
  const payloads: Array<Record<string, string>> = [
    ...(image_base64 ? [{ image_base64 }] : []),
    ...rawUrls.map((image_url) => ({ image_url })),
  ];
  const dropped = Math.max(0, payloads.length - MAX_DISPUTE_ATTACHMENTS);
  const capped = payloads.slice(0, MAX_DISPUTE_ATTACHMENTS);

  // Concurrent: each ingest can take tens of seconds (the API fetches the
  // remote image itself), and five in series blew past typical MCP client
  // timeouts before the message was even posted.
  const results = await Promise.all(capped.map(async (payload) => {
    try {
      const up = await apiRequest("POST", `${basePath}/${did}/attachments`, payload, ATTACHMENT_TIMEOUT_MS);
      return up?.url ? { ok: true as const, url: up.url as string } : { ok: false as const, why: "no URL returned" };
    } catch (err) {
      // Keep the API's own words. Swallowing these reported an expired key or a
      // 500 as "that image must be a JPEG under 6MB", so an agent would retry
      // with different photos forever.
      return { ok: false as const, why: toErrorMessage(err) };
    }
  }));
  const attachmentUrls = results.flatMap((r) => (r.ok ? [r.url] : []));
  const failures = results.flatMap((r) => (r.ok ? [] : [r.why]));

  // Every photo failed AND there is no note to salvage — post nothing. With a
  // note, the note still goes: a dispute has a response deadline and losing it
  // to a blob-store blip is worse than losing the photo.
  if (failures.length && !attachmentUrls.length && !(message && message.trim())) {
    const overNote = dropped ? ` (${dropped} further image(s) were over the ${MAX_DISPUTE_ATTACHMENTS}-attachment limit and never attempted)` : "";
    return textBlockOf(`I couldn't attach ${failures.length === 1 ? "that photo" : "those photos"}: ${[...new Set(failures)].join("; ")}${overNote}. Nothing was posted — fix the image or send a text note instead.`, true);
  }
  await apiRequest("POST", `${basePath}/${did}/messages`, {
    message: (message && message.trim()) || "",
    attachment_urls: attachmentUrls,
  });
  const attached = attachmentUrls.length === 1 ? " Photo attached." : attachmentUrls.length > 1 ? ` ${attachmentUrls.length} photos attached.` : "";
  const partial = failures.length ? ` ${failures.length} image(s) could NOT be attached: ${[...new Set(failures)].join("; ")}.` : "";
  const over = dropped ? ` ${dropped} more image(s) were not sent — a dispute message takes at most ${MAX_DISPUTE_ATTACHMENTS}.` : "";
  return textBlockOf(`Posted to dispute ${did}.${attached}${partial}${over} ${audience}`);
}

/** Standard tool result shape. */
function textBlockOf(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Human-readable form of a snake_case status/type. */
function statusLabelOf(v: unknown): string {
  return String(v ?? "").replace(/_/g, " ");
}

/** Dispute statuses where a resolution action is still meaningful. */
const OPEN_DISPUTE_STATES = new Set(["open", "seller_responded", "negotiating", "escalated"]);

/**
 * commerce#786: render a dispute thread from the SIDE that is reading it.
 *
 * The seller view was hand-copied from the buyer view and lost five things in
 * the copy: the three-way sender label (so Firestarter's own arbitration text
 * was attributed to the buyer), the pending offer, the response deadline,
 * status-aware next steps (a closed dispute was advertised as resolvable), and
 * the inline photos the tool description promised. One renderer, told which
 * side is looking, keeps both views honest.
 */
function renderDisputeThread(d: any, viewer: "buyer" | "seller"): string[] {
  const other = viewer === "buyer" ? "Seller" : "Buyer";
  const lines: string[] = [];
  lines.push(`**Dispute ${d.id}** — status: ${statusLabelOf(d.status)}`);
  if (d.execution_id) lines.push(`Order: ${d.execution_id}`);
  // Counterparty free text: cross-principal, so it crosses the trust boundary.
  if (d.reason) lines.push(`${viewer === "seller" ? "Buyer's claim" : "Reason"}: ${sanitizeUntrusted(d.reason, 600)}${d.dispute_type ? ` (${statusLabelOf(d.dispute_type)})` : ""}`);
  if (OPEN_DISPUTE_STATES.has(d.status) && d.seller_deadline_at) {
    lines.push(viewer === "seller"
      ? `**You must respond by ${new Date(d.seller_deadline_at).toUTCString()}.**`
      : `Seller must respond by ${new Date(d.seller_deadline_at).toUTCString()}.`);
  }
  if (!OPEN_DISPUTE_STATES.has(d.status)) {
    const pct = typeof d.buyer_refund_pct === "number"
      ? ` — ${viewer === "buyer" ? `you were refunded ${d.buyer_refund_pct}%` : `buyer refunded ${d.buyer_refund_pct}%`}`
      : "";
    lines.push(`Resolved${d.resolution_type ? ` (${statusLabelOf(d.resolution_type)})` : ""}${pct}.`);
  }

  const offers = Array.isArray(d.offers) ? d.offers : [];
  if (offers.length > 0) {
    lines.push("", "**Offers:**");
    for (const o of offers) {
      const state = o.accepted_at ? "accepted" : o.rejected_at ? "rejected" : "pending";
      const who = o.offered_by === viewer ? "You" : other;
      lines.push(`- ${who}: **${o.buyer_pct}% refund to buyer / ${o.seller_pct}% to seller** — ${state}${o.reasoning ? ` — "${sanitizeUntrusted(o.reasoning, 400)}"` : ""}`);
    }
  }

  const messages = Array.isArray(d.messages) ? d.messages : [];
  if (messages.length > 0) {
    lines.push("", "**Messages:**");
    for (const m of messages) {
      // Three roles, not two: 'admin' is Firestarter's arbiter. Collapsing it
      // into the counterparty made platform instructions read as the
      // adversary's claim.
      const who = m.sender_role === viewer ? "You" : m.sender_role === "admin" ? "Firestarter" : other;
      const nAtt = Array.isArray(m.attachment_urls) ? m.attachment_urls.length : 0;
      lines.push(`- **${who}:** ${sanitizeUntrusted(m.message, 600)}${nAtt ? ` _(${nAtt} photo${nAtt > 1 ? "s" : ""})_` : ""}`);
    }
  }
  return lines;
}

/** Every image on a dispute, for inlining alongside the rendered thread. */
function disputeImageUrls(d: any): string[] {
  const messages = Array.isArray(d?.messages) ? d.messages : [];
  return [
    ...(Array.isArray(d?.evidence_urls) ? d.evidence_urls : []),
    ...(Array.isArray(d?.seller_evidence_urls) ? d.seller_evidence_urls : []),
    ...messages.flatMap((m: any) => (Array.isArray(m.attachment_urls) ? m.attachment_urls : [])),
  ];
}

/**
 * Statuses at which an execution has stopped moving on its own. Anything else
 * (finding, quoting, …) means work is still in flight — which is NOT the same
 * as "nothing was found", and callers must not conflate the two. Exported so
 * the tools that poll can tell a still-running execution from a finished one.
 */
export const TERMINAL_STATUSES = [
  "awaiting_approval", "awaiting_payment_method", "quoted",
  "completed", "failed", "cancelled", "paid", "shipping", "delivered",
];

/** Consecutive /poll failures tolerated before giving up on the wait loop. */
const POLL_MAX_CONSECUTIVE_ERRORS = 3;

async function pollExecution(apiRequest: ReturnType<typeof makeApiRequest>, executionId: string, timeoutMs: number = 60_000): Promise<any> {
  const start = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - start < timeoutMs) {
    // Use the lightweight poll endpoint (1 query) instead of the full
    // execution resource (3 queries + JOIN) during the wait loop.
    try {
      const poll = await apiRequest("GET", `/v1/executions/${executionId}/poll`);
      consecutiveErrors = 0;
      if (poll.has_options || TERMINAL_STATUSES.includes(poll.status)) {
        break;
      }
    } catch (err) {
      // A 404 means this API has no /poll route (older version) — retrying it
      // will never succeed, so stop and fetch the full resource.
      if (err instanceof ApiError && err.status === 404) break;
      // Anything else is transient: a 5xx, a DNS blip, or this request hitting
      // the 12s per-call timeout. This used to `break` on ANY error, so ONE
      // hiccup on the FIRST tick abandoned the whole wait and returned an
      // execution still in `finding` — which the caller then reported to the
      // buyer as "no matches". Cost a tick, not the search.
      if (++consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) break;
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
  // Both reads need a database. Standalone (stdio / this package on its own)
  // there isn't one, so we skip straight to the HTTP fallback; the Firestarter
  // API injects its pool at boot and gets the fast path.
  const { pool, imageStore } = getPlatformAdapters();
  if (!pool && !imageStore) return null;

  try {
    // Thumbnail first — small, fast, and always a supported JPEG.
    try {
      const thumb = imageStore ? await imageStore.getOrCreateThumb(id) : null;
      if (thumb?.bytes) {
        const tmime = (thumb.contentType || "").split(";")[0].trim().toLowerCase();
        const mimeType = SUPPORTED_IMAGE_MIME.has(tmime) ? tmime : sniffImageMime(new Uint8Array(thumb.bytes));
        if (mimeType) return { data: Buffer.from(thumb.bytes).toString("base64"), mimeType };
      }
    } catch { /* thumb unavailable (e.g. Jimp can't decode) — fall back to full */ }

    if (!pool) return null;
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
 * Concrete arrival date for a transit-days ETA — "arrives ~Tue, Jul 28" beats
 * "~5 days" for a buyer asking "when will it get here?". Business-day naive by
 * design (carrier ETAs already are); null for missing/non-finite days. Exported
 * for unit tests.
 */
export function arrivalDateFromDays(days: unknown, now: Date = new Date()): string | null {
  if (days == null) return null; // Number(null) === 0 — don't turn "no ETA" into "today"
  const d = Number(days);
  if (!Number.isFinite(d) || d < 0) return null;
  const arrival = new Date(now.getTime() + Math.ceil(d) * 86_400_000);
  return arrival.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * What the spend cap actually does, told truthfully for the key in hand.
 *
 * Both cap tools promised "purchases that would exceed this cap are
 * automatically rejected" with no qualification. The gate skips test-mode
 * purchases by design (apps/api jobs/worker.ts G6: "Test-mode purchases are
 * simulated (no real money), so a real-money spend cap must not apply to
 * them"), so on a test key that sentence is false — and a QA pass reasonably
 * read a sandbox purchase sailing past a $1 cap as a P0 enforcement failure.
 * A safety control has to be described accurately in the environment the
 * caller is actually in. Exported for unit tests.
 */
export function capEnforcementLine(capCents: number, testKey: boolean): string {
  const cap = `$${(capCents / 100).toFixed(2)}`;
  return testKey
    ? `Purchases that would exceed ${cap} in a calendar month are automatically rejected on a LIVE key. This is a TEST key: sandbox purchases are simulated, so the cap is not applied to them and one going through is not a failure.`
    : `Purchases that would exceed ${cap} in a calendar month are automatically rejected.`;
}

/**
 * A date or timestamp as a buyer should read it (#599 F15).
 *
 * QA found the quote side clean ("Arrives in ~2 days (Wed, Aug 19)") and
 * everything downstream raw: `Date: 2026-08-17T08:31:35.292Z` on the receipt,
 * `Estimated delivery: 2026-08-18` on tracking, and every tracking event
 * stamped with a full ISO timestamp. Same order, two registers.
 *
 * timeZone: "UTC" for the same reason arrivalDateFromDays pins it — this
 * package renders on the BUYER's machine, and a date serialised at UTC midnight
 * would otherwise show as the previous day anywhere west of UTC.
 *
 * An unparseable value is returned as-is rather than dropped: whatever the API
 * sent is more useful to a buyer than nothing, and this must never be able to
 * erase a date. Exported for unit tests.
 */
export function formatBuyerDate(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const raw = typeof value === "string" ? value.trim() : value.toISOString();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const date = d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
  // A date-only value (YYYY-MM-DD) carries no time to show, and a midnight
  // timestamp is a DATE serialised, not something that happened at 00:00.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw) || raw.includes("T00:00:00");
  if (dateOnly) return date;
  const time = d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
  return `${date}, ${time} UTC`;
}

/**
 * One human line for a shipping_provenance value — makes "is this number a real
 * carrier rate or a placeholder?" explicit to the buyer instead of an internal
 * enum. Null for unknown/absent values (nothing worth saying). Exported for
 * unit tests.
 */
export function provenanceLine(p: unknown): string | null {
  switch (p) {
    case "real": return "Rate source: live carrier rate";
    case "seller": return "Rate source: seller's flat shipping price";
    case "flat": return "Rate source: standard flat rate (no live carrier rate was available)";
    case "unknown": return "Rate source: calculated at checkout";
    default: return null;
  }
}

/**
 * Buyer-facing display name for a shipping option's `provider` — the SERVICE
 * THAT QUOTED the price (rating engine / courier / platform), which is not the
 * same thing as the carrier that ships the parcel. Null for absent values.
 * Exported for unit tests.
 */
export function shippingProviderDisplay(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  switch (p.trim().toLowerCase()) {
    case "easypost": return "EasyPost";
    case "dhl": return "DHL";
    case "shippo": return "Shippo";
    case "sendcloud": return "Sendcloud";
    case "platform_estimate": return "Firestarter estimate";
    case "seller": return "seller flat rate";
    case "nash": return "Nash";
    case "lalamove": return "Lalamove";
    case "uber_direct": return "Uber Direct";
    case "doordash": return "DoorDash";
    default: return p.trim();
  }
}

/**
 * Tags for one shipping method row that keep two DIFFERENT facts separate for
 * the buyer:
 *   - WHO SHIPS the parcel — "ships via <carrier>" (or, when no carrier is
 *     knowable before the label is bought, "carrier assigned at fulfillment");
 *   - WHO QUOTED the price — "rate quoted by <provider>" for a live rate
 *     (EasyPost/Shippo/Sendcloud rate many carriers, so the rating service is
 *     real information), or "price: Firestarter estimate — live rate applies at
 *     approval" for a platform fallback tier, which is NOT a carrier's number.
 * Redundant tags are dropped: no "ships via X" when the label already leads
 * with the carrier, and no "rate quoted by X" when the quoter IS the carrier
 * (DHL quoting DHL Express, a courier quoting itself). Shared by every surface
 * that renders a shipping method (delivery-options menu, pre-purchase estimate,
 * shipping-options tool) so the same row never reads differently per tool.
 * Exported for unit tests.
 */
export function shippingMethodTags(m: any, label: string): string[] {
  const tags: string[] = [];
  const carrierName = typeof m.carrier === "string" && m.carrier.trim() ? m.carrier.trim() : null;
  const labelLeadsWithCarrier = !!carrierName && label.toLowerCase().startsWith(carrierName.toLowerCase());
  if (m.is_estimated) {
    if (carrierName && !labelLeadsWithCarrier) tags.push(`ships via ${carrierName}`);
    else if (!carrierName) tags.push("carrier assigned at fulfillment");
    tags.push("price: Firestarter estimate — live rate applies at approval");
    return tags;
  }
  if (carrierName && !labelLeadsWithCarrier) tags.push(`ships via ${carrierName}`);
  const quoted = shippingProviderDisplay(m.provider);
  const quoterIsCarrier = !!quoted && !!carrierName &&
    (carrierName.toLowerCase().startsWith(quoted.toLowerCase()) || quoted.toLowerCase().startsWith(carrierName.toLowerCase()));
  if (quoted && !quoterIsCarrier) tags.push(`rate quoted by ${quoted}`);
  return tags;
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
/**
 * @param canChoose whether the buyer can still act on a choice. False once the
 *   order is past approval: QA saw the full "pick a speed … approve with
 *   shipping_option_index" menu on an order at `charging`, and again at
 *   `delivered`. Offering a choice that can no longer be made invites a calling
 *   agent to re-approve a completed purchase, on a money path (#599). The
 *   speeds stay visible either way — the buyer should still see what they got.
 */
export function renderDeliveryOptions(opt: any, dm: any, canChoose: boolean = true): string[] {
  if (opt.purchasable === false) return [];
  const methods: any[] = Array.isArray(opt.shipping_options) ? opt.shipping_options : [];
  if (methods.length === 0) return [];

  const subtotalCents = Math.round(Number(opt.subtotal ?? 0) * 100);
  // `subtotal` is GROSS — subtract any voucher/community-drop discount so this
  // preview all-in matches the total the charge path (and firestarter_approve)
  // actually computes, instead of overstating it by the discount amount.
  const discountCents = Math.min(subtotalCents, Math.max(0, Math.round(Number(opt.discount ?? 0) * 100)));
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
      const baseCents = subtotalCents - discountCents + priceCents + taxCents;
      const withMargin = marginBps > 0 ? baseCents + marginCentsFor(baseCents, marginBps, capCents) : baseCents;
      allIn = `$${(withMargin / 100).toFixed(2)} all-in`;
    }
    const tags: string[] = [];
    if (Array.isArray(m.badges)) tags.push(...m.badges.filter((b: unknown) => typeof b === "string" && b));
    // Shared quoter-vs-shipper tags: "ships via <carrier>" names who delivers
    // (expectedShipCarrier fills it on estimate tiers when deterministic),
    // "rate quoted by <provider>" / "price: Firestarter estimate" names who
    // priced the row — two different services, kept visibly distinct.
    tags.push(...shippingMethodTags(m, label));
    const parts = [price];
    if (eta) parts.push(eta);
    // Concrete date next to the day count — "when will it arrive?" needs a date,
    // not arithmetic. Skipped for estimate tiers (a fabricated date would imply
    // a promise no carrier made).
    const arrival = !m.is_estimated ? arrivalDateFromDays(m.delivery_days) : null;
    if (arrival) parts.push(`arrives ~${arrival}`);
    if (allIn) parts.push(allIn);
    return { label, parts, tags };
  };

  // Single delivery method: still NAME the service + speed (there is no choice to
  // make, so no [index]) — so shipping is never invisible on a one-option order.
  if (methods.length === 1) {
    const d = describe(methods[0]);
    return [`  Delivery: ${d.label} · ${d.parts.join(" · ")}${d.tags.length ? ` — ${d.tags.join(", ")}` : ""}`];
  }

  // Two or more services. While the buyer can still approve, this is a menu and
  // the indices ARE shipping_option_index. Once they cannot, it is a record of
  // what was available — same rows, no index, no call to action.
  if (!canChoose) {
    return [
      "  Delivery options quoted for this order:",
      ...methods.map((m: any) => {
        const d = describe(m);
        return `   ${d.label} · ${d.parts.join(" · ")}${d.tags.length ? ` — ${d.tags.join(", ")}` : ""}`;
      }),
    ];
  }
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
    // Post-approval transparency: who ships it and who priced it ("ships via
    // DHL Express" / "rate quoted by EasyPost" / "price: Firestarter estimate")
    // — the buyer should know the logistics company behind the number they are
    // about to be charged, not just a tier label.
    const srcTags = shippingMethodTags(s, label);
    if (srcTags.length) lines.push(`Shipping details: ${srcTags.join(", ")}`);
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

/**
 * Render a PRE-PURCHASE shipping estimate (POST /v1/shipping/estimate) for the
 * buyer. Exported for unit tests. This is the standalone listing+destination
 * estimator the web listing page already had — before this tool, an agent's
 * only path to a real rated shipping cost was to START an execution. Two rules
 * shape the output: (1) rows are bulleted, never numbered — these are not
 * shipping_option_index values (no execution exists yet), and a numbered menu
 * here trains agents to approve with an index that means nothing; (2) the
 * soft-ask (SHIPPING_ESTIMATE_NEEDS_FIELDS) and not-shippable cases relay the
 * server's actionable message rather than erroring.
 */
export function renderShippingEstimate(data: any): string[] {
  // Soft ask: the destination was parseable but has no usable locality — relay
  // the server's own "what to collect" message (never a hard error).
  if (data?.code === "SHIPPING_ESTIMATE_NEEDS_FIELDS") {
    const missing = Array.isArray(data.missing) && data.missing.length ? ` (missing: ${data.missing.join(", ")})` : "";
    return [`${data.message || "Need a bit more of the destination to estimate shipping."}${missing}`];
  }
  if (data?.shippable === false) {
    return [`This item can't ship to that destination${data.reason ? `: ${data.reason}` : "."}`];
  }
  const options: any[] = Array.isArray(data?.options) ? data.options : [];
  if (options.length === 0) {
    return ["No shipping rates are available for that destination yet — try a more specific locality (country + ZIP), or start the purchase and rates will be quoted at approval."];
  }

  const lines: string[] = ["Shipping estimate (pre-purchase — informational, nothing is bought):"];
  // From → to route (both coarse localities) so the delivery provider's origin
  // and the buyer's destination are visible alongside the rates.
  if (data.ship_from && data.ship_to) lines.push(`Ships from ${data.ship_from} → ${data.ship_to}`);
  else if (data.ship_from) lines.push(`Ships from: ${data.ship_from}`);
  else if (data.ship_to) lines.push(`Ships to: ${data.ship_to}`);
  for (const m of options) {
    const cur = typeof m.currency === "string" && m.currency && m.currency !== "USD" ? m.currency : null;
    const price = m.price_cents == null
      ? "price at checkout"
      : m.price_cents === 0
        ? "free"
        : cur ? `${(m.price_cents / 100).toFixed(2)} ${cur}` : `$${(m.price_cents / 100).toFixed(2)}`;
    const eta = m.delivery_range || (m.delivery_days != null ? `~${m.delivery_days} day${m.delivery_days === 1 ? "" : "s"}` : null);
    const label = m.label || [m.carrier, m.service].filter(Boolean).join(" ") || m.method_type || "Shipping";
    // Shared quoter-vs-shipper tags (same rules as renderDeliveryOptions).
    const tags = [
      ...(Array.isArray(m.badges) ? m.badges : []),
      ...shippingMethodTags(m, label),
    ];
    const parts = [`- ${label}`, price];
    if (eta) parts.push(eta);
    lines.push(`  ${parts.join(" · ")}${tags.length ? ` — ${tags.join(", ")}` : ""}`);
  }
  if (data.fallback_used) {
    lines.push("  (Prices above are Firestarter's estimate tiers, not carrier quotes — live carrier rates are quoted at approval.)");
  }
  // Route class context (from the estimate's route_class): an international
  // route means the buyer may owe import duties on delivery (DAP — the platform
  // does not collect them), and a hyperlocal route means same-day courier
  // options can appear at checkout. Both change the buying decision, so say so
  // here rather than after approval.
  if (data.route_class === "international") {
    lines.push("  Note: international route — import duties/taxes may be due on delivery (not included above).");
  } else if (data.route_class === "hyperlocal") {
    lines.push("  Note: local route — same-day courier delivery may also be offered at checkout.");
  }
  lines.push("", "To buy at one of these speeds: firestarter_execute with the listing_id, then pick the speed at approval (shipping_option_index). These estimate rows are NOT approve indices.");
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
      // A blocked order is the one status line where the fix is a click away —
      // previously it named the settings page without linking to it.
      lines.push(`**Last step:** this order is waiting on a payment method. The buyer can add a card in ${mdLink("their dashboard settings", DASHBOARD_SETTINGS_URL)} (or call \`firestarter_payment_method\` for a no-login link); the order resumes automatically once added.`);
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

    /**
     * Can the buyer still act on any of this? Everything below that asks the
     * caller to DO something — pick a speed, claim a drop, approve an
     * option_id — is gated on it. Past approval those lines are instructions to
     * re-approve a purchase that is already paid for, on a money path (#599).
     * Facts stay visible either way; only the calls to action go.
     */
    const canStillApprove = exec.status === "awaiting_approval";

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
      // Sanitise the VALUE, then format. Sanitising the pre-formatted string
      // both ate the leading space and let two individually-clean fields
      // compose into a marker across the join: a title ending "<|im_start"
      // plus a condition of "|>" produced output this module would itself
      // reject (#599, round 3).
      const conditionText = sanitizeUntrusted(opt.metadata?.condition, 78);
      const condition = conditionText ? ` (${conditionText})` : "";
      const browseLabel = isOwnListing
        ? " - your listing"
        : unconnectedStore
          ? " - Firestarter listing (not buyable right now)"
          : externalResult
            ? " - browse-only (external)"
            : "";
      // Seller-supplied, on the money path. formatExecution backs execute,
      // status, approve and message, so these land in the calling agent's
      // context right beside a real price and a real approval instruction — a
      // newline here forges a row inside a genuine approval block (#599).
      optLines.push(`\n**${i + 1}. ${sanitizeUntrusted(opt.product_title)}${condition}** from ${sanitizeUntrusted(opt.supplier || opt.store) || "Unknown"}${browseLabel}`);
      // .trim() alone left newlines intact, which is the whole attack.
      const included = sanitizeUntrusted(opt.metadata?.included);
      const missing = sanitizeUntrusted(opt.metadata?.missing);
      if (included) optLines.push(`  Includes: ${included}`);
      if (missing) optLines.push(`  Not included: ${missing}`);
      // Surface the product image URL so the agent can relay it and chat
      // clients auto-unfurl a preview. Bare URL on its own line — Slack,
      // WhatsApp, and Telegram all auto-preview hosted image URLs.
      const imageUrl = opt.image_url || opt.metadata?.image;
      if (imageUrl && /^https?:\/\//i.test(String(imageUrl)) && !isTransientThumbnail(String(imageUrl))) {
        optLines.push(`  ${imageUrl}`);
      }
      // #256: lead with the bold all-in total, then the line-item split, and
      // ALWAYS state the tax status — a silent omission reads as a checkout
      // surprise. The item+shipping split also stops an agent flagging the
      // line-item total as a price discrepancy (debug 2026-06-12: "$55.80" with
      // no context read as a mismatch against a $45.81 listing).
      if (opt.total != null) {
        // Currency-aware + 2dp everywhere (see money()). Options can be
        // non-USD: those stay browse-only because checkout can't charge them,
        // but they are still displayed, and a bare `$` misprices them.
        const cur = opt.currency ?? opt.metadata?.currency;
        const costParts: string[] = [];
        if (opt.subtotal != null) {
          const itemPart = `${money(opt.subtotal, cur)} item${Number(opt.quantity) > 1 ? `s x${opt.quantity}` : ""}`;
          // `subtotal` is GROSS — a voucher/community-drop discount is subtracted
          // separately into `total`, so it must show here too or the joined parts
          // sum to more than the all-in total (looked like a checkout overcharge).
          costParts.push(opt.discount != null && Number(opt.discount) > 0 ? `${itemPart} - ${money(opt.discount, cur)} discount` : itemPart);
        }
        // Always state shipping — a silently-dropped shipping line makes shipping
        // look unresolved. >0 shows the amount, 0 shows "free shipping", and a
        // genuinely-unknown shipping (browse-only / not rated) shows "shipping
        // calculated at checkout" instead of nothing (mirrors firestarter_preview).
        if (opt.shipping != null && Number(opt.shipping) > 0) costParts.push(`${money(opt.shipping, cur)} shipping`);
        else if (opt.shipping != null && Number(opt.shipping) === 0) costParts.push("free shipping");
        else if (opt.shipping == null && (opt.metadata as any)?.shipping_known === false) costParts.push("shipping calculated at checkout");
        const taxPhrase = opt.tax != null && Number(opt.tax) > 0 ? `${money(opt.tax, cur)} tax` : "no tax";
        const breakdown = costParts.length > 0 ? `${costParts.join(" + ")}, ${taxPhrase}` : taxPhrase;
        // "all-in" is a PROMISE. It was printed even when the same line said
        // "shipping calculated at checkout" — self-contradictory, and it is why
        // the step summary quoted a shipping-inclusive total against a
        // shipping-exclusive row for the same item. Claim it only when every
        // component is actually known.
        const shippingKnown = opt.shipping != null;
        const totalLabel = shippingKnown ? "all-in" : "item total — shipping calculated at checkout";
        optLines.push(`  **${money(opt.total, cur)} ${totalLabel}** - ${breakdown}`);
      }
      // #discount-source: state WHICH voucher applied, or why an explicit
      // voucher_code didn't — firestarter_execute's voucher_code param promises
      // "the response explains why it didn't apply", but nothing ever read the
      // voucher_rejected/voucher_code metadata the quote step already stamps on
      // the option, so a buyer got a correct total with no idea a code was
      // tried or which one won. Rejection first (explains the code the buyer
      // gave), then whatever auto-apply fell back to, if anything.
      {
        const rejected = (opt.metadata as any)?.voucher_rejected;
        if (rejected && typeof rejected === "object" && rejected.code) {
          optLines.push(`  Voucher code "${rejected.code}" didn't apply: ${rejected.message || "not eligible for this order"}`);
        }
        const voucherCode = typeof (opt.metadata as any)?.voucher_code === "string" ? (opt.metadata as any).voucher_code : null;
        const voucherDiscountCents = Number((opt.metadata as any)?.voucher_discount_cents) || 0;
        if (voucherCode && voucherDiscountCents > 0) {
          optLines.push(`  Voucher ${voucherCode} applied: -$${(voucherDiscountCents / 100).toFixed(2)}`);
        }
      }
      // An unclaimed community drop on this listing. The quote does NOT include
      // it — claiming is the buyer's call, because it consumes a limited slot —
      // so say so plainly and name the tool that takes it (#599 F8). Without
      // this line a member paid full price and only found the discount by
      // calling firestarter_drops on a hunch.
      {
        const availCents = Number((opt.metadata as any)?.drop_available_cents) || 0;
        const availId = (opt.metadata as any)?.drop_available_id;
        // Only while claiming can still change the price. QA read this line on a
        // DELIVERED order, where "claim it before approving" is an instruction
        // to act on a purchase that is over — the same defect as the menu above.
        if (canStillApprove && availCents > 0 && typeof availId === "string") {
          const who = sanitizeUntrusted((opt.metadata as any)?.drop_available_community, 120);
          optLines.push(
            `  🎁 $${(availCents / 100).toFixed(2)} community discount available${who ? ` from ${who}` : ""} — NOT included above. ` +
            `Claim it before approving: firestarter_drops action "claim", drop_id "${availId}".`,
          );
        }
      }
      // #256: tell the buyer when it arrives (delivery_estimate is a DATE).
      if (opt.delivery_estimate) {
        const d = new Date(opt.delivery_estimate);
        if (!isNaN(d.getTime())) {
          // Anchor the countdown to the same UTC calendar the date is rendered
          // in. Diffing against Date.now() gives the UTC day-gap, which only
          // agrees with `when` for a reader already in UTC: a Los Angeles buyer
          // at 19:00 saw "in ~1 day (Sun, Aug 16)" when Aug 16 was two days out.
          // "Today" is the BUYER's calendar day; the estimate keeps its own
          // UTC day (it is a DATE, not an instant). Anchoring both to UTC was a
          // mathematical no-op — ceil(N - fraction) === N for a UTC-midnight
          // value — so the countdown stayed wrong for exactly the readers the
          // date fix was for: an LA buyer at 19:00 still read "~1 day
          // (Sun, Aug 16)" when Aug 16 was two days out, now contradicting the
          // shipping row directly beneath it. One `new Date()`, because three
          // can straddle a UTC midnight and yield "~367 days".
          const now = new Date();
          const todayLocal = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
          const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - todayLocal) / 86400000);
          // A DATE, not a timestamp. This printed the raw ISO string —
          // "Arrives in ~2 days (2026-08-16T00:00:00.000Z)" — while the
          // delivery-options rows two lines below already rendered the friendly
          // form, so one unformatted field made the whole block look machine
          // generated (#599 F15).
          // timeZone: "UTC" is load-bearing. delivery_estimate is a DATE
          // serialised at UTC midnight, and this package ships a bin + an .mcpb
          // bundle, so it renders on the BUYER's machine. Without it,
          // 2026-08-16 shows as "Sat, Aug 15" anywhere west of UTC — a wrong
          // date that also contradicts the "~2 days" on the same line, on a
          // delivery promise.
          const when = d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
          optLines.push(days > 0 ? `  Arrives in ~${days} day${days === 1 ? "" : "s"} (${when})` : `  Delivery estimate: ${when}`);
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
      // Where it ships FROM → TO — coarse city/state/country only (never exact
      // street/zip/phone). ship_from is present for purchasable internal listings
      // quoted after this was captured; ship_to (the buyer's destination) is
      // execution-level. Show the full route when both are known.
      if (opt.ship_from && exec.ship_to) optLines.push(`  Ships from ${opt.ship_from} → ${exec.ship_to}`);
      else if (opt.ship_from) optLines.push(`  Ships from: ${opt.ship_from}`);
      else if (exec.ship_to) optLines.push(`  Ships to: ${exec.ship_to}`);
      // Delivery-options menu: show the real speed/carrier choices the buyer can
      // pick between (the numbers ARE the shipping_option_index for approve), so
      // shipping stops being an invisible auto-pick. Non-blocking — approving
      // without a choice still uses the cheapest rate.
      if (!browseOnly) {                                                                                    
        for (const shipLine of renderDeliveryOptions(opt, dm, canStillApprove)) optLines.push(shipLine);
        // Cross-border DAP disclosure (stamped on the option at quote time, #332):
        // import duties change what the buyer actually pays — they must hear it
        // WITH the price, before approving, not at the border.
        const duties = opt.metadata?.duties_disclosure;
        if (typeof duties === "string" && duties.trim()) optLines.push(`  ⚠ ${duties.trim()}`);
        else if (opt.metadata?.cross_border === true) optLines.push("  ⚠ International order — import duties/taxes may be due on delivery (not included in the total).");
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
      // The approve handle. `selected_option` is POSITIONAL, and approve
      // resolves it against a RE-FETCH of the execution whose sort key includes
      // MUTABLE fields (selected first, then purchasable, then match_score — see
      // buildExecutionResponse in the API). So the numbering an agent rendered
      // can drift before the buyer says "the second one", notably after a
      // firestarter_message refinement re-quotes. option_id cannot drift.
      // It was documented on firestarter_approve but never printed anywhere, so
      // a text-only agent had no way to obtain one and was forced onto the
      // fragile index path. Rendered only for purchasable options: a browse-only
      // id is not approvable, and showing one only invites an attempt.
      // Gated on the same "can the buyer still act?" test as the delivery menu.
      // It survived the first pass because it is not a shipping line, so on a
      // charging/delivered order the output still handed an agent an approve
      // handle for a purchase that had already been paid for.
      if (!browseOnly && canStillApprove && typeof opt.id === "string" && opt.id) {
        optLines.push(`  option_id: \`${opt.id}\` — pass this to firestarter_approve to buy exactly this one`);
      }
      if (isOwnListing) {
        optLines.push(`  This is your own listing - shown so you can see how it appears to buyers. It is not offered for purchase.`);
      } else if (unconnectedStore) {
        optLines.push(`  This Firestarter listing can't be checked out right now — its seller is not accepting new orders, or the store has not been claimed by its merchant yet. Share the link so the buyer can view it, or use \`firestarter_message\` to refine toward buyable listings. Do not approve this option.`);
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
 *
 * The fallback passes annotations through in their classic positional slot, so
 * the handler stays the 5th argument exactly as a direct `server.tool(...)` call
 * leaves it. Dropping them shifted the handler left by one and silently broke
 * every double that captures it positionally rather than as the last argument.
 */
/**
 * A read-only tool was handed the setter's arguments. Say so, and name the tool
 * that would have worked.
 *
 * These tools declared `{}` as their input schema, so setter-shaped arguments
 * were stripped by validation before the handler ran and the caller got a plain
 * read back — indistinguishable from a successful write. A QA pass reported two
 * P0 "silent no-op" regressions on that basis; the setters had simply never
 * been called. One line of acknowledgement prevents the entire misdiagnosis
 * (#599 F20).
 */
function readOnlyArgsNotice(args: unknown, setterTool: string): string {
  const keys = args && typeof args === "object" ? Object.keys(args as object).filter((k) => (args as any)[k] !== undefined) : [];
  if (keys.length === 0) return "";
  return `\n\n⚠️ This tool only reads — it ignored ${keys.map((k) => `\`${k}\``).join(", ")} and changed nothing. Call \`${setterTool}\` to make that change.`;
}

function registerToolCompat(server: McpServer, name: string, config: any, handler: any): void {
  const s = server as any;
  if (typeof s.registerTool === "function") {
    if (config?._meta?.ui) {
      // UI-enabled tool (MCP Apps): route through registerAppTool so the ui
      // metadata is normalized (modern `_meta.ui.resourceUri` + the legacy
      // flat key) for whichever host version connects.
      //
      // registerAppTool emits neither of ChatGPT's own keys — ext-apps 1.7.5
      // contains no `openai/` string at all — so outputTemplate is added here.
      // It is not redundant with ui.resourceUri: it deliberately names the
      // STABLE alias, because ChatGPT 404s a URI its template store has not
      // ingested while Claude Desktop only ever re-reads a NEW one. Attached
      // centrally so no widget tool can be added without it.
      registerAppTool(server, name, { ...config, _meta: { "openai/outputTemplate": SHOPPING_RESULTS_STABLE_URI, ...config._meta } }, handler);
    } else {
      s.registerTool(name, config, handler);
    }
  } else {
    s.tool(name, config.description, config.inputSchema, config.annotations, handler);
  }
}

/**
 * Human-readable country name from an ISO 3166-1 alpha-2 code, falling back
 * to the code itself for anything Intl can't resolve (a reserved/unassigned
 * code, or an unrecognized country the API already normalized to ""). An
 * agent relaying "we can't pay out to PK" to a seller reads badly next to
 * "...to Pakistan".
 */
const REGION_DISPLAY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
function countryLabel(code: string): string {
  if (!code) return code;
  try {
    return REGION_DISPLAY_NAMES.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** "A", "A and B", "A, B, and C" — for short rail-name lists. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * "<RAIL(S)> decide(s) eligibility at connect time — worth trying." The one
 * sentence for naming a still-"unknown" rail, shared by unpaidCountryHeadline
 * below (the no-rail-confirmed answer) and firestarter_payout_eligibility's
 * supported-rail branch (naming an ALSO-unknown rail alongside one already
 * confirmed) — hand-copying it into both, even with honest wording each
 * time, is exactly the pattern that put this branch's original bug in five
 * places. One source; both call sites read from it.
 */
function unknownRailNote(names: string[]): string {
  const decideVerb = names.length === 1 ? "decides" : "decide";
  return `${joinNames(names)} ${decideVerb} eligibility at connect time — worth trying.`;
}

/**
 * The headline for a country where the top-level `supported` answer is
 * false. Ported from apps/web's usePayoutEligibility.ts (firestarter-commerce
 * #839) so the MCP tool and the seller dashboard derive the same sentence
 * from the same per-rail verdicts, rather than drifting the way the flat
 * "browse-only" copy did.
 *
 * Derived from each rail's VERDICT, never from the flattened `supported`
 * boolean:
 *  - `"unsupported"` (PayPal, which publishes its own payouts country list)
 *    is named specifically — that absence is a real fact, not a guess.
 *  - `"unknown"` (Stripe outside our best-effort seed) is NEVER folded into a
 *    claim that Firestarter can't pay the country — Stripe decides
 *    eligibility per seller at connect time and may well work. This is the
 *    exact distinction #839's four countries (Pakistan, Bangladesh, Nigeria,
 *    Egypt) sit in: PayPal unsupported, Stripe unknown.
 *  - Only when EVERY enabled rail is definitively "unsupported" (nothing left
 *    "unknown") does the confident "we can't pay out to X yet" sentence
 *    appear.
 */
function unpaidCountryHeadline(rails: Array<{ provider: string; verdict: string }>, country: string): string {
  const unsupportedNames = rails.filter((r) => r.verdict === "unsupported").map((r) => r.provider.toUpperCase());
  const unknownNames = rails.filter((r) => r.verdict === "unknown").map((r) => r.provider.toUpperCase());

  if (unknownNames.length === 0) {
    return `We can't pay out to ${country} yet.`;
  }

  const unknownSentence = unknownRailNote(unknownNames);

  if (unsupportedNames.length === 0) return unknownSentence;

  return `${joinNames(unsupportedNames)} can't pay out to ${country} yet. ${unknownSentence}`;
}

/**
 * "Account:" line for firestarter_status — who the configured API key belongs
 * to (the org's owner user + the org), from GET /v1/me. Best-effort by design:
 * identity is garnish on a status check, and an older API without the endpoint
 * (rolling deploy) must not break it — any failure just drops the line.
 */
async function fetchAccountLine(apiRequest: ReturnType<typeof makeApiRequest>): Promise<string | null> {
  try {
    const me = await apiRequest("GET", "/v1/me");
    const parts: string[] = [];
    const person = [me?.user?.name, me?.user?.email ? `<${me.user.email}>` : null].filter(Boolean).join(" ");
    if (person) parts.push(person);
    if (me?.org?.id || me?.org?.name) {
      const plan = me?.org?.plan ? `, ${me.org.plan} plan` : "";
      parts.push(`org "${me.org.name || me.org.id}" (${me.org.id}${plan})`);
    }
    return parts.length ? `Account: ${parts.join(" — ")}` : null;
  } catch {
    return null;
  }
}

/**
 * The listing fields the widget's seller views render (uploader.client.ts):
 * a compact card, and the drop zone's sense of what the listing already holds.
 * Kept small on purpose — this rides in structuredContent next to the text.
 */
function listingSummaryStructured(listing: any): Record<string, unknown> {
  const images = Array.isArray(listing?.images)
    ? listing.images.filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    : [];
  const blocked = Array.isArray(listing?.activation_blocked)
    ? listing.activation_blocked
        .map((b: any) => String(b?.message ?? b?.code ?? "")).filter(Boolean)
    : [];
  const summary: Record<string, unknown> = {
    id: listing?.id,
    title: listing?.product_name ?? undefined,
    price: typeof listing?.base_price === "number" ? listing.base_price : undefined,
    status: listing?.status ?? undefined,
    images,
  };
  const share = listingShareUrl(listing);
  if (share) summary.share_url = share;
  if (blocked.length) summary.blocked = blocked;
  return summary;
}

/**
 * Should the widget request ACTIVATION after attaching a photo? Only when the
 * missing photo is the whole story: any other gate (price, moderation,
 * verification) would make the activation PATCH fail wholesale, so the widget
 * then attaches without flipping status and reports what still blocks.
 * Unknown blocks (no activation_blocked on the payload) err toward attempting
 * — the server is the authority and its refusal is reported, not guessed at.
 */
function shouldActivateAfterPhoto(listing: any): boolean {
  if (listing?.status !== "draft") return false;
  const blocks = Array.isArray(listing?.activation_blocked) ? listing.activation_blocked : null;
  if (!blocks || blocks.length === 0) return true;
  return blocks.every((b: any) => b?.code === "NEEDS_IMAGE");
}

/** Magic-byte sniff for the four formats the API accepts. Local-path uploads
 *  only — everywhere else the server sniffs for itself. */
function sniffImageMimeLocal(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export interface RegisterToolsOptions {
  /**
   * True only on the stdio/MCPB build, whose server is a LOCAL process that can
   * read the user's disk. Gates firestarter_upload_image's `image_path` input:
   * the hosted transports must never advertise a path argument they cannot
   * honor (the file is on the user's machine, not the server's).
   */
  localFiles?: boolean;
}

export function registerTools(server: McpServer, apiKey: string, apiBase: string, onAuthError?: () => void, opts?: RegisterToolsOptions) {
  const apiRequest = makeApiRequest(apiKey, apiBase, onAuthError);
  const localFiles = opts?.localFiles === true;
  /** Sandbox key: several real-money guarantees do not apply — say so where we make them. */
  const isTestKey = typeof apiKey === "string" && apiKey.startsWith("fs_test");

  // MCP App resource backing the buyer-facing shopping tools' inline product
  // grid (firestarter_preview advertises it via _meta.ui.resourceUri). No-op on
  // the unit-test server doubles that don't implement resources.
  registerShoppingApp(server);

  // Tool: firestarter_execute
  server.tool(
    "firestarter_execute",
    "Start a purchase. Step 1 of the buy flow: it finds products matching a natural-language request (or pins to an exact listing), verifies the seller, computes real pricing + shipping, and returns ranked OPTIONS that are AWAITING APPROVAL — it does NOT pay yet. Full flow: firestarter_execute (find/price) → firestarter_approve (confirm + pay) → firestarter_receipt (proof of payment) and firestarter_track_order (delivery). Each purchasable option lists real DELIVERY OPTIONS (Standard / Express / Same-Day with prices and ETAs); the delivery speed is the buyer's choice, selected at approval via shipping_option_index (firestarter_shipping_options re-fetches or previews a speed's total; firestarter_shipping_estimate quotes shipping on a listing BEFORE any purchase starts). No budget, address, or payment method is needed to call this — a card is requested only at the very end, after the buyer approves; browsing, quoting, and comparing shipping never require one. A saved shipping address is used automatically — the buyer's street, zip, and phone are already on file, and the response's `default_delivery` shows a masked view of the ship-to. A new address matters only when none is saved or the order ships somewhere else; a saved `address_id` (from firestarter_addresses) is accepted in place of a re-typed address. When the buyer's `location` (country, and city if known) is provided, results are localized to their country so a buyer in Kenya sees locally-deliverable options first instead of an empty or US-only list. An exact listing id (lst_..., e.g. from a firestarter.network/l/<id> share link or firestarter_catalog_search) can be passed as listing_id to skip search and pin to that exact product. Results may include browse-only options (external, or not buyable right now) that can't be approved — each carries a link that can be shared instead. auto_pay presumes the buyer's explicit prior authorization to buy without a confirmation step.",
    {
      request: z.string().describe("Natural language description of what to buy (e.g. 'specialty coffee beans under $30'). This is the only required field — call with just this and refine later."),
      listing_id: z.string().optional().describe("Exact Firestarter listing id (lst_...) to buy — from a listing or a share link (firestarter.network/l/<id>). Pins the purchase to that listing, skipping product search. Always pass it when you have one."),
      voucher_code: z.string().optional().describe("A discount code the buyer already has (voucher / coupon / promo code). Only meaningful for a code the buyer supplied — the best publicly available voucher is applied automatically, so searching for codes is unnecessary; this field exists for private or targeted codes that auto-apply cannot find. If the code can't be used the order still proceeds at the best price available, and the response explains why it didn't apply."),
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
      priority: z.enum(["cost", "speed", "quality"]).optional().describe("Optimization priority: cost (cheapest), speed (fastest delivery), quality (best rated). Default cost — shipping is quoted and shipped at the cheapest carrier rate unless the buyer asks for speed/quality."),
      auto_pay: z.boolean().optional().describe("If true, automatically pay for the best option within budget WITHOUT a confirmation step — only when the buyer explicitly pre-authorized it. If false (default), options are returned for approval."),
      requested_by: z
        .object({
          name: z.string().optional().describe("Requester's display name, e.g. 'Durga'"),
          id: z.string().optional().describe("Requester's platform user id, e.g. a Slack U... id"),
          channel: z.string().optional().describe("Platform the request came from, e.g. 'slack', 'whatsapp'"),
        })
        .optional()
        .describe("Who asked for this purchase, when relaying someone else's request (e.g. a teammate in chat). Stored as execution metadata so the buyer's dashboard can attribute the order. Integrations set this programmatically; pass it whenever you know the requester."),
      // commerce#771: test mode collapses paid -> shipping -> delivered in one
      // tick, so any test whose precondition is an order SITTING at 'shipped'
      // was unstageable. The API has accepted preferences.hold_at_shipped since
      // commerce#829 — no MCP tool could set it, which left the flag REST-only
      // and the tests it was built for unstageable from any agent surface.
      hold_at_shipped: z
        .boolean()
        .optional()
        .describe("TEST MODE ONLY (fs_test_ keys): park the order at 'shipped' instead of auto-delivering it ~2s later. The mock shipment, tracking number and 'shipped' status all still happen; only the auto-deliver timer is skipped, so the order can be inspected mid-flight and then delivered explicitly with firestarter_confirm_delivery. Ignored on a live key. Use it to stage a shipped-but-not-delivered order for QA."),
      // commerce#899: hold_at_shipped's delivered-side twin. Test mode zeroes
      // the escrow inspection window so a test sell completes end to end on the
      // next tick, which also makes escrow releasable the instant delivery
      // lands — and a released hold cannot be disputed. So the most common real
      // dispute, "it arrived and it's wrong", was unstageable in test mode by
      // any route: hold_at_shipped parks the order BEFORE delivery, and the
      // confirm-delivery paths re-collapse the window when you finally deliver.
      hold_at_delivered: z
        .boolean()
        .optional()
        .describe("Keep the escrow hold in place after delivery, instead of releasing it the moment the order is marked delivered, so the order can still be disputed — which is what firestarter_disputes needs to open a dispute at all. The order still ships and delivers normally; only the payout is held, on the same inspection window a live order gets. REQUIRES the organization's test mode to be ON as well as a test key: a test key on its own runs the mock sandbox, which never creates an escrow hold for this to act on, and the API now refuses the flag there (HOLD_AT_DELIVERED_UNAVAILABLE) rather than accepting a purchase whose hold would be silently dropped. Inert on a live key, where escrow already holds for the full window."),
    },
    // Creates a pending execution and returns priced options — it does not
    // charge anything. Payment happens in firestarter_approve, which is the
    // tool marked destructive. openWorld: it searches the live catalog.
    { title: "Start a Purchase", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ request, listing_id: rawListingId, budget_max, delivery_address, address_id, location, priority, auto_pay, requested_by, voucher_code, hold_at_shipped, hold_at_delivered }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        const body: any = {
          request,
          preferences: { priority: priority || "cost", require_approval: !auto_pay },
        };
        if (listing_id) body.listing_id = listing_id;
        if (voucher_code?.trim()) body.voucher_code = voucher_code.trim();
        // The execute route persists `preferences` verbatim; the worker reads
        // this key inside its test_mode branch only, so forwarding it on a live
        // key is inert rather than dangerous.
        if (hold_at_shipped) body.preferences.hold_at_shipped = true;
        // Same contract as hold_at_shipped: persisted verbatim, consulted only
        // for a test_mode ledger (inside confirmDeliverable), inert on a live key.
        if (hold_at_delivered) body.preferences.hold_at_delivered = true;
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

        // A timed-out create whose error text says "retry" is the double-buy
        // vector (commerce 0018): the server dedupes per org on this header,
        // but only a key that is STABLE across the agent's retry of the same
        // intent dedupes anything — so it is a content hash of the request
        // body, not a random value. The 10-minute time bucket keeps the window
        // short: the server's unique index has no TTL, and the same buyer
        // legitimately re-running an identical request later must still create
        // a fresh execution.
        const bucket = Math.floor(Date.now() / 600_000);
        const idemKey = "exec-" + createHash("sha256")
          .update(JSON.stringify(body)).update(`:${bucket}`).digest("hex").slice(0, 48);
        const created = await apiRequest("POST", "/v1/executions", body, undefined, { "Idempotency-Key": idemKey });
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
        } else if (!TERMINAL_STATUSES.includes(exec.status)) {
          // STILL RUNNING — not a result. An execution in `finding`/`quoting`
          // has no options yet, so it used to fall into the empty-options branch
          // below and be reported to the buyer as a bolded "No matches", while
          // `Status: finding` sat on the line above it. Models follow the bold,
          // action-shaped line, so the agent told the buyer nothing was found
          // while the search was live and about to produce options.
          //
          // Reachable two ways: the 45s poll cap (prod server-side preview
          // latency already peaks around 27s before the agent -> MCP -> gateway
          // -> API hops), and a transient /poll error exhausting the retries.
          blocks.push({
            type: "text",
            text: `\n\n**Still searching — this hasn't finished yet, and nothing has failed.** The search is taking longer than usual (a cold catalog lookup can). Tell the buyer it is still running; do NOT report this as an empty result. Check back in a few seconds with \`firestarter_status\` (execution \`${exec.id}\`); no card is involved at this stage.`,
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
        "Preview real products for a natural-language request WITHOUT starting a purchase. Returns live options with prices, whether each can be bought through Firestarter (vs browse-only), shipping, and per-option eligibility — in budget, can arrive by the deadline, and ships to the destination. Answers \"what can you get me?\" — a view of what's available before any purchase starts (firestarter_execute). Read-only: nothing is bought and no approval is created.",
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
      annotations: { title: "Preview Products", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      // MCP Apps: render these results as an inline product grid (photos) in
      // supporting hosts (Claude Desktop, VS Code). Additive — hosts without
      // MCP Apps support ignore this and fall back to the text + image-block
      // result the handler returns below.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
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
          // Seller-supplied. Sanitised because this line lands verbatim in the
          // CALLING agent's context, which we neither own nor instruct (#599).
          text += `\n${i + 1}. **${sanitizeUntrusted(o.title)}** — ${price}${ship}`;
          if (o.seller) text += ` · ${sanitizeUntrusted(o.seller, 120)}`;
          // Trust bits on their own line: the stars and the sold count are what
          // a buyer asks about after price, and a text-only host sees ONLY this
          // prose — structuredContent never reaches the model in many of them.
          // stars() returns null with no reviews, so a new seller's row simply
          // has no line rather than an "unrated" badge.
          // Product-first with a LABELED fallback. 80 reviews of a seller's
          // OTHER products is a real signal, but an agent must not relay it to
          // a buyer as though it were about this item.
          const dr = displayRating(o);
          const starTxt0 = stars(dr.rating, dr.rating_count);
          const starTxt = starTxt0 ? `${starTxt0}${dr.is_seller_level ? " seller rating" : ""}` : null;
          // >= 3 matches SOLD_MIN on the web: below three sales a count is noise
          // rather than social proof, and "1 sold" reads as a warning.
          const soldTxt = Number((o as any).units_sold) >= 3 ? `${(o as any).units_sold} sold` : null;
          const trustBits = [starTxt, soldTxt].filter(Boolean).join(" · ");
          if (trustBits) text += `\n   ${trustBits}`;
          // A browse-only option's ONLY next action is opening the vendor page,
          // so that gets the click; a buyable option needs no link (it is bought
          // by id) and adding one per row would just dilute the real ones.
          const viewLink = o.url ? mdLink("view on the vendor's site", tidyProductUrl(o.url)) : null;
          text += `\n   ${o.purchasable ? "✓ buyable through Firestarter" : `browse-only${viewLink ? ` — ${viewLink}` : o.url ? ` — view: ${tidyProductUrl(o.url)}` : ""}`}`;
          if (o.purchasable) {
            if (o.eligible) {
              text += `\n   ✓ eligible to buy now`;
            } else {
              const blockers = (o.reasons || []).map((r: string) => PREVIEW_REASON_LABELS[r] || r);
              text += `\n   ⚠ not eligible: ${blockers.join("; ") || "see details"}`;
            }
            // The id the closing line tells the agent to pass. It only ever
            // existed in structuredContent, which many hosts never surface to
            // the model — so on a text-only host a BUYABLE option carried no
            // identifier AND no link (the url is rendered for browse-only rows
            // only). The agent was told "pass a listing_id" having been given
            // none, and fell back to re-running the whole natural-language
            // search, which can rank a different seller's listing first: the
            // buyer picks option 1 and gets option 4. firestarter_catalog_search
            // has always printed its ids; this matches it.
            if (typeof o.id === "string" && o.id) {
              text += `\n   listing_id: \`${o.id}\``;
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
    "The buyer's ORDER HISTORY and order status on Firestarter — check one order, or list recent orders (\"my orders\", \"order history\", \"past orders\", \"what did I buy\"); works on every key, live and test. Also reports the current ENVIRONMENT (test vs live) plus the ACCOUNT the configured API key belongs to (user + organization). Use this to check on orders, see what options were found, get tracking updates, confirm whether you are in test/sandbox mode, or answer 'which account/user am I operating as?' (call it with no arguments for the environment + account summary). Firestarter DOES have a test mode: an `fs_test_…` API key runs every purchase through a fully simulated sandbox (mock payment, shipping, and tracking — no real money moves and no real seller is contacted); an `fs_live_…` key is real. The mode is fixed by the configured API key, not a per-call option.",
    {
      execution_id: z.string().optional().describe("Specific execution ID to check (e.g. 'exec_abc123'). Omit to list recent executions."),
      status_filter: z.string().optional().describe("Filter executions by status: finding, awaiting_approval, approved, paid, shipping, completed, failed, cancelled"),
    },
    { title: "Check Order Status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
        // In parallel with the list fetch; resolves to null on any failure.
        const accountPromise = fetchAccountLine(apiRequest);
        let path = "/v1/executions";
        if (status_filter) path += `?status=${encodeURIComponent(status_filter)}`;
        const data = await apiRequest("GET", path);
        const accountLine = await accountPromise;
        const identity = accountLine ? `\n${accountLine}` : "";
        const executions = data.executions || data;
        if (!Array.isArray(executions) || executions.length === 0) {
          return { content: [{ type: "text" as const, text: `Environment: ${environment}${identity}\n\nNo executions found.` }] };
        }
        const lines = [`Environment: ${environment}${identity}\n`, `**Recent Executions** (${data.total || executions.length} total)\n`];
        // Phase 4: table, not bullets — a buyer with several open orders can
        // scan status/date/amount in columns instead of parsing prose per row.
        lines.push(mdTable(
          ["Order", "Status", "Request", "Date", "Total"],
          // Full list — mdTable itself caps at 10 (opts.cap) and renders the
          // "…and N more" hint. Pre-slicing here starved it of the overflow,
          // so the hint was unreachable dead code.
          executions.map((e: any) => [
            `\`${e.id}\``,
            String(e.status ?? ""),
            `${e.request_text?.slice(0, 48) || ""}${(e.request_text?.length ?? 0) > 48 ? "…" : ""}`,
            formatBuyerDate(e.created_at) || "—",
            e.total != null ? money(e.total, e.currency) : "—",
          ]),
          { cap: 10, moreHint: "pass status_filter or an execution_id to narrow" },
        ));
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_approve
  server.tool(
    "firestarter_approve",
    "Confirm and place an order that is awaiting approval — this is the step that actually BUYS and pays. Lifecycle: firestarter_execute (or a listing_id buy) returns options awaiting approval → firestarter_approve places and pays for the order → the buyer can then get a receipt (firestarter_receipt) and follow delivery (firestarter_track_order). The buyer's SAVED DEFAULT address is used automatically (the execute/approve responses show a masked view of the ship-to); a `delivery_address` (or a saved `address_id` from firestarter_addresses) applies only when the buyer has no saved address or wants THIS order shipped somewhere else. By default it approves the pre-selected (best purchasable) option; a different one is selected with option_id (each purchasable option prints its own `option_id:`; it identifies the product itself rather than a position that can shift between display and approval, which makes it the more reliable selector) or, as a positional fallback, selected_option. Delivery speed is the buyer's choice: the option shows a numbered 'Delivery options' menu (Standard / Express / Same-Day with prices + ETAs) — shipping_option_index (the [number] from that menu) selects a specific speed, and omitting it uses the cheapest. Only Firestarter-purchasable options can be approved — browse-only results (external listings, or Firestarter listings that are not buyable right now) are rejected with a view link instead. When execution_id is omitted (e.g. the user just says \"approve\"/\"confirm\"/\"yes\" without naming an order), the tool resolves the single pending purchase automatically, and lists the candidates when several are pending. A PRICE_CHANGED result means the total changed since the options were shown; placing the order at the new price requires the buyer's explicit confirmation of the exact updated total, expressed as a repeat call with confirm_total set to that exact value AND consent_nonce set to the one-time nonce PRICE_CHANGED returned, verbatim (it is single-use and cannot be guessed). If no address is saved and none is passed, approval of physical goods is rejected.",
    {
      execution_id: z.string().optional().describe("The execution ID to approve (e.g. 'exec_abc123'). Omit when the user simply replied \"approve\": the tool then approves the one execution awaiting approval, surfaces payment-setup guidance if the order is parked awaiting a payment method, or lists the candidates if several are pending."),
      selected_option: z.number().int().min(0).optional().describe("0-based POSITIONAL index into the options list as displayed (the option shown as '1.' is index 0). Prefer option_id: this index is resolved against a fresh read of the execution, and the option order can change if the order was re-quoted or refined with firestarter_message since you displayed it. Omit both to approve the pre-selected best option."),
      option_id: z.string().optional().describe("Exact option id (e.g. 'opt_abc123') to approve — PREFERRED over selected_option, because it identifies the product itself rather than a position that can shift. Each purchasable option in firestarter_execute / firestarter_status output prints its own `option_id:`; copy that value verbatim. Takes precedence over selected_option."),
      address_id: z.string().optional().describe("A saved address id (addr_...) to ship this order to, from firestarter_addresses. Optional — omit to use the buyer's default saved address. Pass only to ship somewhere other than their default."),
      // Permissive, forever-stable boundary (see firestarter_execute): string OR
      // any object, never rejected for shape; the server normalizes + gates.
      delivery_address: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("Optional — pass EITHER a single-line string (e.g. \"123 Main St, Austin, TX 78701, US\") OR an object { name?, street1, street2?, city, state?, zip?, country? }. The buyer's saved default address is used automatically; only pass a NEW address here to ship this order elsewhere, or when the buyer has no saved address. A partial or odd-shaped address is accepted (never rejected for shape); a complete one (ZIP + state for US/CA/AU) is required only at the pay boundary. On a first order with no saved address, the address you pass is saved as their default for next time."),
      shipping_option_index: z.number().int().min(0).optional().describe("0-based index of the delivery speed to use, taken from the numbered 'Delivery options' menu shown for the option (in firestarter_execute / firestarter_status output, or firestarter_shipping_options). Omit to use the cheapest rate; the order total is recalculated server-side for the chosen speed and included in what the buyer approves."),
      confirm_total: z.number().nonnegative().optional().describe("Exact updated total in USD from a prior PRICE_CHANGED response. Pass only after showing that total to the buyer and receiving a new explicit confirmation; never guess or pre-fill it on the first approval."),
      consent_nonce: z.string().optional().describe("The single-use consent_nonce string from a prior PRICE_CHANGED response. Pass it VERBATIM together with confirm_total when re-approving a price change. It is one-time-use and cannot be guessed — never fabricate it; only echo the exact value the last PRICE_CHANGED returned."),
    },
    { title: "Approve and Pay", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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

        // Name WHAT was bought. Approval resolves to one option through three
        // different paths (explicit option_id, a positional selected_option, or
        // the server's pre-selection), and until now none of them told the agent
        // which product actually won — so a positional index that resolved to
        // the wrong row charged the buyer silently. Echoing the title makes a
        // mis-resolution visible in the same message as the total.
        const boughtTitle =
          typeof exec.selected_option?.product_title === "string" ? exec.selected_option.product_title : null;
        const itemLine = boughtTitle ? [`Item: ${sanitizeUntrusted(boughtTitle)}`] : [];

        // #272: when approval transitions to awaiting_payment_method, return a
        // concise one-shot message instead of the full execution dump (which
        // caused repetitive/duplicated output in Slack) — now WITH the shipping
        // service + all-in shown next to the card link.
        if (exec.status === "awaiting_payment_method" && exec.setup_url) {
          const text = [
            "Order approved.",
            ...itemLine,
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
        const headLines = [...itemLine, ...payReady];
        const head = headLines.length ? `Order approved.\n${headLines.join("\n")}\n` : "Execution approved.\n";
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
    "Show and compare the delivery speeds for an order awaiting approval, and preview the re-priced total for a chosen speed — before paying. Returns the numbered 'Delivery options' menu (Standard / Express / Same-Day, each with its price, ETA, and all-in total); the [number] of the buyer's pick is what firestarter_approve takes as shipping_option_index to place the order at that speed. Use this when the buyer asks about delivery speed/cost, wants it faster, or the speed/price trade-off is in question before approval — firestarter_execute already lists these inline, and approving without a pick uses the cheapest rate. Pass refresh:true to re-fetch live carrier rates (e.g. if the quote is stale), and select_index to preview one speed's new total. For a listing the buyer hasn't started buying yet (no execution), use firestarter_shipping_estimate instead.",
    {
      execution_id: z.string().describe("The execution ID (exec_...) to show delivery options for — an order that is awaiting approval."),
      option_id: z.string().optional().describe("Which option's delivery methods to show (opt_...). Omit to use the pre-selected option (the one the buyer is about to approve)."),
      select_index: z.number().int().min(0).optional().describe("Preview a specific delivery speed: the [number] from the menu. Shows that speed's new all-in total and the exact shipping_option_index to approve with. Does NOT select or pay — it's a preview."),
      refresh: z.boolean().optional().describe("Re-fetch live carrier rates and persist them before showing the menu. Use when the stored rates may be stale (e.g. >30 min old). Off by default."),
    },
    { title: "Shipping Options", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
        lines.push(`Delivery options${data.product_title ? ` for ${sanitizeUntrusted(data.product_title)}` : ""} — pick a speed, or approve to use the cheapest:`);
        // From → to route (coarse localities from the structured origin/destination
        // objects), so the delivery provider's origin and the buyer's destination
        // are visible before any speed is chosen.
        if (data.ship_from) {
          const from = [data.ship_from.city, data.ship_from.state, data.ship_from.country].filter(Boolean).join(", ");
          if (from) lines.push(`Ships from: ${from}`);
        }
        if (data.ship_to) {
          const to = [data.ship_to.city, data.ship_to.state, data.ship_to.country].filter(Boolean).join(", ");
          if (to) lines.push(`Ships to: ${to}`);
        }
        if (data.fee_breakdown) {
          // subtotal is GROSS — state the discount (already netted into each
          // option's all-in below) so "item" + "shipping" visibly account for it.
          const discountSuffix = Number(data.fee_breakdown.discount_cents || 0) > 0
            ? ` (- ${fmt(data.fee_breakdown.discount_cents)} discount)`
            : "";
          lines.push(`Item subtotal: ${fmt(data.fee_breakdown.subtotal_cents || 0)}${discountSuffix} · Tax: ${fmt(data.fee_breakdown.tax_cents || 0)} · Shipping: shown per option below`);
          // "Is this a real carrier rate or a placeholder?" — answer it instead
          // of leaving an internal enum invisible.
          const prov = provenanceLine(data.fee_breakdown.shipping_provenance);
          if (prov) lines.push(prov);
        }
        for (const m of methods) {
          const price = m.price_cents == null ? "price at checkout" : m.price_cents === 0 ? "free" : fmt(m.price_cents);
          const eta = m.delivery_range || (m.delivery_days != null ? `~${m.delivery_days} day${m.delivery_days === 1 ? "" : "s"}` : null);
          const label = m.label || [m.carrier, m.service].filter(Boolean).join(" ") || m.method_type || "Shipping";
          const allIn = m.all_in_cents != null ? `${fmt(allInCents(m.all_in_cents))} all-in` : null;
          // Shared quoter-vs-shipper tags — "ships via <carrier>" vs "rate
          // quoted by <provider>" — instead of the old internal-enum dump
          // (provider: easypost, carrier: USPS).
          const tags = [
            ...(Array.isArray(m.badges) ? m.badges : []),
            ...shippingMethodTags(m, label),
          ];
          const parts = [`[${m.index}] ${label}`, price];
          if (eta) parts.push(eta);
          // Concrete arrival date next to the day count (real rates only — a
          // fabricated date on an estimate tier would imply an unmade promise).
          const arrival = !m.is_estimated ? arrivalDateFromDays(m.delivery_days) : null;
          if (arrival) parts.push(`arrives ~${arrival}`);
          if (allIn) parts.push(allIn);
          lines.push(`  ${parts.join(" · ")}${tags.length ? ` — ${tags.join(", ")}` : ""}`);
        }
        // Cross-border DAP disclosure (stamped on the option at quote time): the
        // buyer must hear about import duties BEFORE picking a speed/approving.
        if (data.duties_disclosure) {
          lines.push("", `⚠ ${data.duties_disclosure}`);
        } else if (data.cross_border) {
          lines.push("", "⚠ International order — import duties/taxes may be due on delivery (not included in the totals above).");
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

  // Tool: firestarter_shipping_estimate
  // Pre-purchase parity with the web listing page: POST /v1/shipping/estimate
  // rates a listing+destination pair WITHOUT creating an execution. Before this
  // tool, everything shipping-rich on the MCP surface was execution-bound
  // (firestarter_shipping_options requires an exec_ id), so an agent could not
  // answer "how much is shipping?" while the buyer was still browsing.
  server.tool(
    "firestarter_shipping_estimate",
    "Estimate shipping for a listing BEFORE starting a purchase — read-only: no execution is created, no approval, nothing is bought. Given a listing id (lst_...) and a destination — a saved address_id, or just a country + ZIP (or city); a full street address is NOT needed — returns the rated delivery options (price, ETA, carrier when known) the buyer would see at checkout. Use it to answer \"how much is shipping?\" or \"can this ship to me?\" while the buyer is still browsing, e.g. from firestarter_preview / firestarter_catalog_search results or a firestarter.network/l/<id> share link. The rows are informational, NOT a menu to approve from: buying at a speed happens through firestarter_execute with the listing_id, with the speed selected at approval via shipping_option_index (or firestarter_shipping_options once the order exists). Street-less destinations may get estimate tiers; exact carrier rates are re-quoted at approval.",
    {
      listing_id: z.string().describe("The listing to estimate shipping for (lst_..., from firestarter_preview, firestarter_catalog_search, firestarter_listings, or a firestarter.network/l/<id> share link)."),
      address_id: z.string().optional().describe("A saved buyer address id (addr_..., from firestarter_addresses) to estimate delivery to. Prefer this when the buyer has one on file — no need to ask where they live."),
      country: z.string().optional().describe("Destination country — ISO code or common name (e.g. 'US', 'Thailand'). Pair it with zip or city; used only when address_id is not passed."),
      zip: z.string().optional().describe("Destination ZIP/postal code. Country + ZIP is enough for a real estimate — no street needed."),
      city: z.string().optional().describe("Destination city — an alternative locality when the buyer has no ZIP handy."),
    },
    // Read-only despite being a POST: it creates no execution and changes no
    // state. What matters to a host is whether state moves, not the verb. Marked
    // as a write, it drew a confirmation prompt in the middle of browsing — on
    // the very tool built so a buyer could ask "how much is shipping?" without
    // committing to anything.
    { title: "Estimate Shipping", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ listing_id, address_id, country, zip, city }) => {
      try {
        const body: any = { listing_id: cleanListingId(listing_id) };
        if (address_id) {
          body.address_id = address_id;
        } else {
          const addr: any = {};
          if (zip) addr.zip = zip;
          if (city) addr.city = city;
          if (country) addr.country = country;
          if (Object.keys(addr).length > 0) body.delivery_address = addr;
        }
        if (!body.address_id && !body.delivery_address) {
          // Preempt the API's 400 with the actionable ask (soft-ask style).
          return {
            content: [{
              type: "text" as const,
              text: "Need a destination to estimate shipping — pass a saved address_id (see firestarter_addresses), or a country plus ZIP or city. No street address needed.",
            }],
          };
        }
        const data = await apiRequest("POST", "/v1/shipping/estimate", body);
        return { content: [{ type: "text" as const, text: renderShippingEstimate(data).join("\n") }] };
      } catch (err: any) {
        const msg = err instanceof ApiError ? err.message : err?.message || String(err);
        return {
          content: [{ type: "text" as const, text: `Couldn't estimate shipping: ${msg}` }],
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
    "List the buyer's saved shipping addresses (masked). Shows whether an address is already on file; each entry's `address_id` is accepted by firestarter_execute and firestarter_approve, so a saved address never has to be re-typed. The default address (used automatically at approval) is marked. Values are masked (partial street, no zip/phone); an address is referenced by id, so the full value is not needed.",
    {},
    { title: "Saved Addresses", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
          // A label of "Default" on a NON-default address renders identically
          // to the (default) marker beside it, so QA read a list with one
          // default as having two. The marker is the state; a label repeating
          // the word is noise on the row that is not it.
          const rawLabel = a.label || a.name || "Address";
          const label = !a.is_default && String(rawLabel).trim().toLowerCase() === "default"
            ? "Address"
            : rawLabel;
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
      country: z.string().optional().describe("ISO country code (e.g. US, PK, KE, NG). Recommended whenever the buyer's country is known or named anywhere in the address — when omitted, the API infers the country from the address text, falling back to US only as a last resort."),
      name: z.string().optional().describe("Recipient name"),
      phone: z.string().optional().describe("Phone number for delivery"),
      label: z.string().optional().describe("Label for this address (e.g. 'Home', 'Office', 'Warehouse'). If omitted, a default label is assigned."),
      is_default: z.boolean().optional().describe("Set to true to make this the default shipping address."),
    },
    { title: "Save an Address", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async (args) => {
      try {
        // #449: no blind `country: "US"` default here — a Lagos, Nigeria address
        // saved without an ISO code was stored as country US, which broke every
        // live rate lookup against it. When the agent omits country, the API
        // infers it from the address text instead (delivery-address.ts).
        const body: Record<string, unknown> = {
          street1: args.street1,
          city: args.city,
        };
        if (args.country) body.country = args.country;
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

  // Tool: firestarter_drops — community-sponsored drops (Phase 4)
  server.tool(
    "firestarter_drops",
    "Community-sponsored drops: a community owner funds a discount on a specific listing for the first N members, sometimes opening it to higher tiers first. Use action 'list' with a listing_id to see any live drops on it — each shows the per-claim discount, how many slots remain, and whether it is still in a tier-gated early-access window. Use action 'claim' with a drop_id to reserve a slot for the buyer before checkout — first-come, first-served, one per member; the reserved discount then applies to that buyer's purchase of the listing. test/live follows the API key's environment.",
    {
      action: z.enum(["list", "claim"]).describe("'list' the live drops on a listing, or 'claim' a specific drop_id."),
      listing_id: z.string().optional().describe("Listing to list drops for (required for action 'list')."),
      drop_id: z.string().optional().describe("Drop to claim (required for action 'claim')."),
    },
    { title: "Drops", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ action, listing_id, drop_id }) => {
      try {
        if (action === "claim") {
          if (!drop_id) return { content: [{ type: "text" as const, text: "Pass a drop_id to claim a drop." }], isError: true };
          const res = await apiRequest("POST", `/v1/drops/${encodeURIComponent(drop_id)}/claim`);
          const dollars = ((res.discount_cents ?? 0) / 100).toFixed(2);
          const left = Number(res.remaining ?? 0);
          return { content: [{ type: "text" as const, text: `🎉 Claimed — $${dollars} off is reserved for you on this drop (${left} slot${left === 1 ? "" : "s"} left). It applies when you buy the listing.` }] };
        }
        if (!listing_id) return { content: [{ type: "text" as const, text: "Pass a listing_id to list its drops." }], isError: true };
        const data = await apiRequest("GET", `/v1/drops?listing_id=${encodeURIComponent(listing_id)}`);
        const drops: any[] = data?.drops ?? [];
        if (drops.length === 0) return { content: [{ type: "text" as const, text: "No live community drops on this listing right now." }] };
        const lines = drops.map((d) => {
          const dollars = (Number(d.discount_cents) / 100).toFixed(2);
          const gate = d.in_priority_window && Number(d.min_tier) > 0 ? ` · early access for tier ${d.min_tier}+ until ${d.priority_until}` : "";
          // Name the funder. Two identical live drops on one listing are legal
          // only across DIFFERENT communities (#529), so without this neither
          // the buyer nor the agent can tell an eligible drop from an
          // ineligible one, or two communities from a dedupe regression (#599
          // F19). Creator-supplied, so it goes through the same sanitiser as
          // every other piece of third-party text this file emits.
          const who = sanitizeUntrusted(d.community_name, 120);
          return `- \`${d.id}\` — $${dollars} off${who ? ` · from ${who}` : ""} · ${d.remaining} left${gate}`;
        });
        return { content: [{ type: "text" as const, text: `**Live drops on this listing**\n${lines.join("\n")}\n\nClaim one with action 'claim' and its drop_id.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error with drops: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_payment_method
  server.tool(
    "firestarter_payment_method",
    "Check the buyer's payment method status and get a link to add or update their card. The card is the LAST step of a purchase, NOT a precondition: search (firestarter_execute), shipping estimates, and delivery-speed selection (shipping_option_index) all happen before any card is collected, and browsing, quoting, and comparing shipping never require one. A card is genuinely needed only once an order is parked at awaiting_payment_method (after approval), or when the buyer explicitly asks to add one now. Use this tool when the buyer asks about payment or an order is waiting on a card. Returns a no-login Stripe setup link (works from any channel - WhatsApp, Slack, Telegram) plus a dashboard link.",
    {},
    { title: "Manage Payment Method", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const methods = await apiRequest("GET", "/v1/payments/methods");
        const cards = methods.payment_methods || [];
        if (cards.length > 0) {
          const card = cards.find((c: any) => c.card) || cards[0];
          const detail = card.card ? `${card.card.brand} ending in ${card.card.last4} (expires ${card.card.exp_month}/${card.card.exp_year})` : "saved";
          let text = `**Payment method on file:** ${detail}\n\nOrders will charge this card automatically.\n\n`;
          const setup = await apiRequest("POST", "/v1/billing/setup-payment");
          const updateLink = mdLink("Update or add a card", setup.short_url || setup.url);
          text += updateLink ? `${updateLink} (no login needed)\n\n` : `To update or add a different card:\n${setup.short_url || setup.url}\n\n`;
          text += `Or open ${mdLink("your dashboard settings", DASHBOARD_SETTINGS_URL)}.`;
          return { content: [{ type: "text" as const, text }] };
        }
        // No payment method - get a setup link
        const setup = await apiRequest("POST", "/v1/billing/setup-payment");
        let text = "**No payment method on file.** A card is only needed at the FINAL payment step — after the buyer has run firestarter_execute, seen the shipping estimate, and picked a delivery speed. Browsing, quoting, and comparing shipping never require one.\n\n";
        const addLink = mdLink("Add a card to finish this order", setup.short_url || setup.url);
        text += addLink
          ? `${addLink} — no login needed, works from any device.\n\n`
          : `If an order is already approved and waiting on payment, add a card here to finish it (no login needed, works from any device):\n${setup.short_url || setup.url}\n\n`;
        text += `Or add one from ${mdLink("your dashboard settings", DASHBOARD_SETTINGS_URL)}.\n\n`;
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
    { title: "Cancel Order", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    { title: "Track Delivery", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ execution_id }) => {
      try {
        // API-key-authed route. Do NOT use /commerce/tracking/:id — that one is
        // JWT/dashboard-only and 401s an API key (mis-reported as a revoked key).
        const data = await apiRequest("GET", `/v1/executions/${execution_id}/tracking`);
        if (!data.tracking_number) {
          // Not shipped yet — still answer "when will it arrive?" with everything
          // known pre-shipment: the promised delivery date (from the rate adopted
          // at quote/approval), the chosen service, and the route. A bare "no
          // tracking yet" wastes information the read model already has.
          const status = data.order_status || data.display_status || data.status;
          let text = `**Order ${execution_id}** — Status: ${status || "pending"}. No carrier tracking yet (not shipped, or tracking not added).\n`;
          if (data.promised_delivery_date) text += `Expected delivery: ~${data.promised_delivery_date} (promised when the order was quoted)\n`;
          if (data.shipping_method) {
            const svc = [data.shipping_method.carrier, data.shipping_method.service].filter(Boolean).join(" ");
            // Name the quote source in buyer terms, not the internal enum —
            // "(rate quoted by Firestarter estimate)" beats "(via platform_estimate)".
            const quotedBy = shippingProviderDisplay(data.shipping_method.provider);
            if (svc) text += `Shipping method: ${svc}${quotedBy ? ` (rate quoted by ${quotedBy})` : ""}\n`;
          }
          const route = [
            data.ship_from ? [data.ship_from.city, data.ship_from.country].filter(Boolean).join(", ") : null,
            data.ship_to ? [data.ship_to.city, data.ship_to.country].filter(Boolean).join(", ") : null,
          ].filter(Boolean);
          if (route.length === 2) text += `Route: ${route[0]} → ${route[1]}\n`;
          // A cancelled order will never ship — promising future tracking on it
          // ("appears once the label is added") reads as "still coming".
          text += ["cancelled", "canceled", "refunded", "failed"].includes(String(status))
            ? `\nThis order is ${status} — nothing will ship, so no tracking will appear. Use \`firestarter_status\` for the full order state.`
            : `\nUse \`firestarter_status\` for the full order state; tracking appears here once the label is bought/added.`;
          return { content: [{ type: "text" as const, text }] };
        }
        let text = `**Order ${execution_id} — Shipping**\n`;
        if (data.ship_from) {
          text += `Ships from: ${[data.ship_from.city, data.ship_from.state, data.ship_from.country].filter(Boolean).join(", ")}\n`;
        }
        text += `Carrier: ${sanitizeUntrusted(data.carrier, 80) || "Unknown"}\n`;
        // Post-ship the label is BOUGHT: `provider` is the logistics service the
        // label was purchased through (EasyPost/DHL/Shippo/Sendcloud) — distinct
        // from the carrier moving the parcel. Say it in those terms.
        {
          const bookedVia = shippingProviderDisplay(data.shipping_method?.provider);
          if (bookedVia) text += `Label booked via: ${bookedVia}\n`;
        }
        if (data.shipping_method?.service) text += `Service: ${data.shipping_method.service}\n`;
        text += `Tracking: ${sanitizeUntrusted(data.tracking_number, 80)}\n`;
        // The one link a "where's my order?" answer needs.
        const trackLink = mdLink(
          `Track with ${sanitizeUntrusted(data.carrier, 40) || "the carrier"}`,
          data.tracking_url,
        );
        if (trackLink) text += `${trackLink}\n`;
        else if (data.tracking_url) text += `Track: ${data.tracking_url}\n`;
        // Carrier ETA when the shipment has one; else fall back to the date
        // promised at quote time so "when will it arrive?" always has an answer.
        if (data.estimated_delivery) text += `Estimated delivery: ${formatBuyerDate(data.estimated_delivery)}\n`;
        else if (data.promised_delivery_date) text += `Estimated delivery: ~${formatBuyerDate(data.promised_delivery_date)} (quoted at approval)\n`;
        text += `Status: ${data.status || "in_transit"}\n`;
        if (data.fee_breakdown) {
          const f = data.fee_breakdown;
          const money = (cents: number) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
          // subtotal is GROSS; show the discount that's already subtracted into
          // total so the itemized parts sum to it (see mapOption/tools.ts fix).
          const discountPart = Number(f.discount_cents || 0) > 0 ? ` - ${money(f.discount_cents)} discount` : "";
          text += `Fees: item ${money(f.subtotal_cents)}${discountPart} + shipping ${money(f.shipping_cents)} + tax ${money(f.tax_cents)} = ${money(f.total_cents)}\n`;
          const prov = provenanceLine(f.shipping_provenance);
          if (prov) text += `${prov}\n`;
        }
        if (data.events?.length > 0) {
          text += `\n**Recent events:**\n`;
          for (const e of data.events.slice(-5)) {
            const eventDate = formatBuyerDate(e.datetime || e.date) || "Update";
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
    { title: "Start a Return", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    { title: "Confirm Delivery Received", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    { title: "Leave a Review", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    "Read the buyer's monthly spend cap - the safety limit on total monthly spend - and the alert threshold at which a warning fires. Read-only: use firestarter_set_spend_cap to raise, lower, set, or remove the cap (including after a purchase is rejected with SPEND_CAP_EXCEEDED).",
    // Accepted, never applied: the setter's arguments are taken so the response
    // can SAY they were ignored. With `{}` they were stripped before the handler
    // and the caller saw a plain read (#599 F20).
    {
      // z.unknown(), not z.number(): a typed schema makes a stringified
      // number ("500", which models emit constantly) a hard InvalidParams
      // error whose message names zod, not the setter — failing loudest in
      // exactly the case this notice exists to catch.
      spend_cap_dollars: z.unknown().optional().describe("IGNORED here — this tool only reads. Use firestarter_set_spend_cap."),
      alert_threshold_pct: z.unknown().optional().describe("IGNORED here — this tool only reads. Use firestarter_set_spend_cap."),
      disable: z.unknown().optional().describe("IGNORED here — this tool only reads. Use firestarter_set_spend_cap."),
    },
    { title: "Check Spending Cap", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (args: any = {}) => {
      try {
        const balance = await apiRequest("GET", "/v1/billing/balance");
        const cap = balance.spend_cap_cents;
        const threshold = balance.alert_threshold_pct || 80;
        if (!cap) {
          return { content: [{ type: "text" as const, text: `**No spend cap set.** There is currently no monthly spending limit. Use \`firestarter_set_spend_cap\` with \`spend_cap_dollars\` to set one.${readOnlyArgsNotice(args, "firestarter_set_spend_cap")}` }] };
        }
        // Where they stand against it, not just what it is. Absent on an older
        // API build, so this stays optional rather than printing "$0.00 used"
        // — a wrong number is worse than a missing one on a spend limit.
        const spent = Number(balance.month_to_date_spend_cents);
        const position = Number.isFinite(spent)
          ? `\nUsed this month: $${(spent / 100).toFixed(2)} of $${(cap / 100).toFixed(2)} (${Math.min(999, Math.round((spent / cap) * 100))}%)`
          : "";
        return { content: [{ type: "text" as const, text: `**Monthly spend cap: $${(cap / 100).toFixed(2)}**${position}\nAlert threshold: ${threshold}%\n\n${capEnforcementLine(cap, isTestKey)}${readOnlyArgsNotice(args, "firestarter_set_spend_cap")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error reading spend cap: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_set_spend_cap
  server.tool(
    "firestarter_set_spend_cap",
    "Raise, lower, set, or remove the buyer's monthly spend cap - the safety limit on total monthly spend. Covers any request to increase, raise, bump, set, lower, or change the cap (e.g. 'increase my spending cap to $100', 'raise my limit to $X', 'cap my spending at $X'). The cap is always buyer-adjustable: a purchase rejected with SPEND_CAP_EXCEEDED goes through once the cap is raised here with a higher spend_cap_dollars and the purchase is retried. Set disable:true to remove the cap entirely. Use firestarter_spend_cap to read the current value without changing it.",
    {
      spend_cap_dollars: z.number().min(1).optional().describe("New monthly spend cap in dollars (e.g. 500 = $500/month)."),
      alert_threshold_pct: z.number().int().min(1).max(100).optional().describe("Fire a warning when monthly spend reaches this % of the cap. Default 80."),
      disable: z.boolean().optional().describe("Set to true to remove the spend cap entirely (no limit)."),
    },
    // Overwrites a persistent account-level safety limit — raising it loosens a
    // spending guard, so a host should confirm rather than fire it silently.
    // Re-setting the same value is a no-op, hence idempotent.
    { title: "Set Spending Cap", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ spend_cap_dollars, alert_threshold_pct, disable }) => {
      try {
        if (disable) {
          await apiRequest("PATCH", "/v1/billing/settings", { spend_cap_cents: null });
          return { content: [{ type: "text" as const, text: `**Spend cap removed.** There is no monthly spending limit. Agents can spend without a cap.` }] };
        }
        if (spend_cap_dollars === undefined && alert_threshold_pct === undefined) {
          return {
            content: [{ type: "text" as const, text: "Pass spend_cap_dollars, alert_threshold_pct, or disable. To read the current cap without changing it, use firestarter_spend_cap." }],
            isError: true,
          };
        }
        const body: any = {};
        if (spend_cap_dollars !== undefined) body.spend_cap_cents = Math.round(spend_cap_dollars * 100);
        if (alert_threshold_pct !== undefined) body.alert_threshold_pct = alert_threshold_pct;
        await apiRequest("PATCH", "/v1/billing/settings", body);
        let text = `**Spend cap updated.**\n`;
        if (spend_cap_dollars !== undefined) text += `Monthly limit: $${spend_cap_dollars}\n`;
        if (alert_threshold_pct !== undefined) text += `Alert at: ${alert_threshold_pct}% of cap\n`;
        if (spend_cap_dollars !== undefined) text += `\n${capEnforcementLine(Math.round(spend_cap_dollars * 100), isTestKey)}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error updating spend cap: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_developer_margin (commerce#977)
  server.tool(
    "firestarter_developer_margin",
    "Read this organization's DEVELOPER MARGIN — the markup it adds on top of the item total for purchases made through its own API keys, disclosed to the buyer and paid out to this organization when the seller is paid. Returns the current margin, the platform ceiling, and margin earned so far. Read-only: use firestarter_set_developer_margin to set or change it. NOT the same thing as a community market's share_bps (firestarter_create_market), which is a cut of Firestarter's own platform fee and costs the buyer nothing — this one is money the buyer pays.",
    {
      margin_percent: z.unknown().optional().describe("IGNORED here — this tool only reads. Use firestarter_set_developer_margin."),
    },
    { title: "Read Developer Margin", readOnlyHint: true, openWorldHint: false },
    async (args) => {
      try {
        const cfg = await apiRequest("GET", "/v1/developer/margin");
        // Earnings are a separate endpoint and a nice-to-have: a failure there
        // must not sink the read, and must not be rendered as "$0.00 earned".
        let earnings: any = null;
        try {
          earnings = await apiRequest("GET", "/v1/developer/earnings");
        } catch {
          earnings = null;
        }
        return {
          content: [{
            type: "text" as const,
            text: `${formatDeveloperMargin(cfg, earnings)}${readOnlyArgsNotice(args, "firestarter_set_developer_margin")}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error reading developer margin: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_set_developer_margin (commerce#977)
  server.tool(
    "firestarter_set_developer_margin",
    "Set or change this organization's DEVELOPER MARGIN — the markup added on top of the item total for purchases made through its own API keys (e.g. 'set my developer margin to 10%', 'change my margin', 'take a 5% cut on my integration'). Applies to future purchases only; existing orders keep the margin frozen at the time they were paid. Pass margin_percent: 0 to turn it off. The platform ceiling is 10% and $50 per transaction. NOT the same thing as a community market's share_bps (firestarter_create_market): that is a cut of Firestarter's own platform fee, this is money the buyer pays on top of the item.",
    {
      margin_percent: z.number().min(0).max(10).describe("Margin as a percentage of the item total, 0 to 10 (e.g. 10 = 10%, 2.5 = 2.5%). 0 turns the margin off. The API stores basis points; this is converted for you (10% = 1000 bps)."),
    },
    // Changes what buyers are charged on every future purchase through this
    // org's keys, so a host should confirm rather than fire it silently.
    // Re-setting the same value is a no-op, hence idempotent.
    { title: "Set Developer Margin", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ margin_percent }) => {
      // Checked here as well as by zod, because the ceiling is knowable without
      // a round trip and "you asked for 25%, the maximum is 10%" is a better
      // answer than a 400 relayed from the API.
      //
      // The 10 is MAX_MARGIN_BPS (1000) from the commerce API's lib/margin.ts —
      // a hard-coded constant with no env override, which is the only reason it
      // is safe to state here at all. A zod bound has to be static, so this
      // cannot be served from the API the way the selling-gate thresholds now
      // are (commerce#949). If that constant ever moves, this bound and the two
      // descriptions above move with it; the READ tool already prints the
      // ceiling straight from the API, so it will disagree first and loudest.
      if (typeof margin_percent !== "number" || !Number.isFinite(margin_percent) || margin_percent < 0 || margin_percent > 10) {
        return {
          content: [{ type: "text" as const, text: "margin_percent must be between 0% and 10% — 10% is the platform ceiling on developer margin (and each transaction is capped at $50). Pass 0 to turn the margin off." }],
          isError: true,
        };
      }
      // The API takes an INTEGER bps; 2.5% is 250, and anything finer than a
      // basis point is not representable, so round rather than send a float the
      // route would reject as INVALID_MARGIN_BPS.
      const marginBps = Math.round(margin_percent * 100);
      try {
        await apiRequest("PATCH", "/v1/developer/margin", { margin_bps: marginBps });
        const text = marginBps === 0
          ? "**Developer margin turned off.** Purchases through this organization's API keys are charged at the seller's price from now on. Orders already paid keep the margin they were charged."
          : `**Developer margin set to ${Number((marginBps / 100).toFixed(2))}%** (${marginBps} bps).\n` +
            "Applies to purchases made through this organization's API keys from now on — it is added on top of the item total, disclosed to the buyer, and capped at $50 per transaction. Orders already paid are unchanged.\n" +
            "Read it back any time with firestarter_developer_margin.";
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error setting developer margin: ${toErrorMessage(err)}` }], isError: true };
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
    { title: "Get Receipt", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ execution_id }) => {
      try {
        const data = await apiRequest("GET", `/v1/executions/${execution_id}/receipt`);
        // A sandbox purchase moves no money, contacts no seller, and mints a
        // fake charge id — but the receipt printed exactly like a live one, so
        // it could be screenshotted as proof of payment. Say so, first line.
        // Environment comes from the key prefix, the same signal
        // firestarter_status reports.
        let text = `**Receipt — Order ${execution_id}**\n`;
        if (apiKey.startsWith("fs_test_")) {
          text = `**TEST MODE — simulated order. No money moved, no seller was paid.**\n\n${text}`;
        }
        text += `Date: ${formatBuyerDate(data.paid_at || data.created_at) || "N/A"}\n`;
        if (data.product_title) text += `Item: ${sanitizeUntrusted(data.product_title)}\n`;
        if (data.subtotal_cents != null) text += `Subtotal: $${(data.subtotal_cents / 100).toFixed(2)}\n`;
        // subtotal is GROSS — state the discount so it doesn't look silently
        // dropped between the subtotal and the (already-net) total below.
        if (data.discount_cents != null && data.discount_cents > 0) {
          // Name the source when it's a voucher code — a community drop has no
          // buyer-supplied code to show, so it stays an unattributed discount.
          text += data.voucher_code
            ? `Discount: -$${(data.discount_cents / 100).toFixed(2)} (voucher ${data.voucher_code})\n`
            : `Discount: -$${(data.discount_cents / 100).toFixed(2)}\n`;
        }
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
    "Read the buyer's PERSISTENT, account-level auto-approval limit for purchases. This is a real stored account setting (not a chat note or session memory): orders whose total is at or below the limit are auto-approved and paid without a manual confirmation step, and anything above pauses for approval. It applies to EVERY future order on the account, across all surfaces (chat, dashboard, API), until changed. Read-only: use firestarter_set_auto_approve_limit to change or disable it.",
    // Accepted, never applied — see readOnlyArgsNotice (#599 F20).
    {
      set_limit_usd: z.unknown().optional().describe("IGNORED here — this tool only reads. Use firestarter_set_auto_approve_limit."),
      disable: z.unknown().optional().describe("IGNORED here — this tool only reads. Use firestarter_set_auto_approve_limit."),
    },
    { title: "Check Auto-Approve Limit", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async (args: any = {}) => {
      try {
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
        return { content: [{ type: "text" as const, text: text + readOnlyArgsNotice(args, "firestarter_set_auto_approve_limit") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error reading auto-approval limit: ${toErrorMessage(err)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: firestarter_set_auto_approve_limit
  server.tool(
    "firestarter_set_auto_approve_limit",
    "Set or disable the buyer's PERSISTENT, account-level auto-approval limit for purchases. Orders at or below the limit are auto-approved and paid without a manual confirmation step; anything above pauses for approval. It applies to EVERY future order on the account, across all surfaces (chat, dashboard, API), until changed. Pass set_limit_usd (e.g. 50 for '$50 per order'; 0 makes every order require manual approval) OR disable=true to turn auto-approval off entirely. The maximum limit is $10,000. Because orders under the limit are paid with no confirmation step, the exact dollar amount is safety-critical: the tool stores precisely the value passed, and success is confirmed by the response's echo of the stored setting. Use firestarter_auto_approve_limit to read the current value without changing it.",
    {
      set_limit_usd: z
        .number()
        .min(0)
        .max(10_000)
        .optional()
        .describe("New auto-approve limit in USD. Orders at or below this amount auto-approve; anything above pauses for approval. 0 = require manual approval for every order."),
      disable: z
        .boolean()
        .optional()
        .describe("Set true to turn OFF auto-approval entirely (every order requires manual approval). Mutually exclusive with set_limit_usd."),
    },
    // Mutates a PERSISTENT account-level billing setting (overwrites the prior
    // value), so it is destructive in the MCP sense; re-setting the same value
    // is a no-op, hence idempotent.
    { title: "Set Auto-Approve Limit", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ set_limit_usd, disable }) => {
      try {
        if (set_limit_usd === undefined && !disable) {
          return {
            content: [{ type: "text" as const, text: "Pass set_limit_usd or disable. To read the current limit without changing it, use firestarter_auto_approve_limit." }],
            isError: true,
          };
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
    { title: "Refine Purchase Request", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    { title: "Watch Price or Stock", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    { title: "List Price Monitors", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

  // Tool: firestarter_record_purchase
  server.tool(
    "firestarter_record_purchase",
    "Record a purchase completed OUTSIDE the network — e.g. after driving checkout on Lazada, a Shopify storefront, or any other store — so Firestarter keeps one purchase history across every marketplace and can reorder the item later. Call this right after an off-network checkout succeeds, with whatever details are visible on the confirmation page. Test-environment keys only for now: live keys get a TEST_MODE_ONLY refusal.",
    {
      source: z.string().describe("Where the purchase happened, lowercase (e.g. \"lazada\", \"shopify\", \"shopee\", \"amazon\", \"other\")"),
      title: z.string().describe("Product title as shown by the store"),
      amount: z.number().optional().describe("Total paid, in the purchase currency"),
      currency: z.string().optional().describe("ISO currency code (e.g. \"MYR\", \"USD\")"),
      seller_name: z.string().optional().describe("Store / seller name"),
      seller_domain: z.string().optional().describe("Seller's domain (e.g. \"watsons.com.my\") — powers later reorders and seller discovery"),
      product_url: z.string().optional().describe("Direct product page URL — reorders reopen this"),
      image_url: z.string().optional().describe("Product image URL"),
      external_order_ref: z.string().optional().describe("The store's order id/reference from the confirmation"),
      purchased_at: z.string().optional().describe("ISO 8601 purchase timestamp; omit for 'just now'"),
      raw_payload: z.record(z.string(), z.unknown()).optional().describe("Any extra captured details (confirmation-page fields, shipping, options)"),
    },
    { title: "Record External Purchase", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        const res = await apiRequest("POST", "/v1/external-purchases", args);
        const p = res.purchase;
        const price = p.amount != null ? ` — ${p.currency ?? ""} ${p.amount}`.trimEnd() : "";
        return {
          content: [{
            type: "text" as const,
            text: `**Purchase recorded** (${p.environment} mode) — \`${p.id}\`\n${p.title}${price} · ${p.source}${p.seller_name ? ` · ${p.seller_name}` : ""}\nSee it anytime with \`firestarter_purchases\`.`,
          }],
        };
      } catch (err: any) {
        if (err?.code === "TEST_MODE_ONLY") {
          return { content: [{ type: "text" as const, text: "Purchase capture is test-mode only right now. Use a test key (fs_test_*) or enable test mode for the org — live keys can't record purchases yet." }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Couldn't record the purchase: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_purchases
  server.tool(
    "firestarter_purchases",
    "OFF-NETWORK purchases only — the pilot log of purchases an agent completed on OTHER stores and recorded with firestarter_record_purchase. This is NOT the buyer's Firestarter order history: orders placed through Firestarter (\"my orders\", \"order history\", \"what did I buy here\") live in firestarter_status, which works on every key. This pilot log is test-environment keys only for now; live keys get a TEST_MODE_ONLY refusal — that refusal says nothing about Firestarter order history, which remains fully available via firestarter_status.",
    {
      purchase_id: z.string().optional().describe("Get one purchase (pur_...) with full details. Omit to list."),
      query: z.string().optional().describe("Filter by words in the title or seller name"),
      source: z.string().optional().describe("Only purchases from one marketplace (e.g. \"lazada\")"),
      limit: z.number().optional().describe("Max results (default 20, max 50)"),
    },
    { title: "My Purchases", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ purchase_id, query, source, limit }) => {
      try {
        if (purchase_id) {
          const res = await apiRequest("GET", `/v1/external-purchases/${encodeURIComponent(purchase_id)}`);
          const p = res.purchase;
          let text = `**${p.title}** — \`${p.id}\` (${p.environment} mode)\nSource: ${p.source}${p.seller_name ? ` · ${p.seller_name}` : ""}${p.seller_domain ? ` (${p.seller_domain})` : ""}\n`;
          if (p.amount != null) text += `Paid: ${p.currency ?? ""} ${p.amount}\n`;
          if (p.external_order_ref) text += `Order ref: ${p.external_order_ref}\n`;
          if (p.purchased_at) text += `Purchased: ${p.purchased_at}\n`;
          if (p.product_url) text += `Reorder here: ${p.product_url}\n`;
          return { content: [{ type: "text" as const, text }] };
        }
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        if (source) params.set("source", source);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        const res = await apiRequest("GET", `/v1/external-purchases${qs ? `?${qs}` : ""}`);
        const purchases = res.purchases || [];
        if (purchases.length === 0) {
          return { content: [{ type: "text" as const, text: "No purchases recorded yet. After an off-network checkout, record it with `firestarter_record_purchase`." }] };
        }
        const lines = [`**Your purchases** (${purchases.length})\n`];
        for (const p of purchases) {
          const price = p.amount != null ? ` — ${p.currency ?? ""} ${p.amount}`.trimEnd() : "";
          lines.push(`- **${p.title}**${price} · ${p.source}${p.seller_name ? ` · ${p.seller_name}` : ""}`);
          lines.push(`  id: \`${p.id}\`${p.purchased_at ? ` · ${p.purchased_at.slice(0, 10)}` : ""}${p.product_url ? ` · ${p.product_url}` : ""}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        if (err?.code === "TEST_MODE_ONLY") {
          return { content: [{ type: "text" as const, text: "The OFF-NETWORK purchase log (a test-mode pilot) isn't available on a live key. This does NOT affect Firestarter order history \u2014 for the buyer's orders placed through Firestarter, call `firestarter_status` (works on every key)." }], isError: true };
        }
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
    { title: "Stop Watching", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    { title: "Check Price Monitor", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
  // Persists a product photo to the Firestarter image store and returns a
  // public URL the agent can then pass to firestarter_list /
  // firestarter_update_listing (image_urls) or firestarter_import (photo_urls).
  // commerce#819: takes the photo by URL (server-side fetch + re-host) —
  // base64 is the fallback for images that exist nowhere as a URL, because a
  // data URI rebuilt from a linked image does not survive being emitted as a
  // tool argument (same mechanism as the dispute-photo fix, commerce#749).
  const uploadSuccessResult = (url: string) => ({
    content: [{ type: "text" as const, text: `✅ Image uploaded successfully.\n\nHosted URL: ${url}\n\nUse this URL in the \`image_urls\` array when calling firestarter_list or firestarter_update_listing.` }],
    // The widget reads the hosted URL from here — the drop zone's own upload
    // calls land in this handler, and regexing it back out of prose is the
    // fragile alternative.
    structuredContent: { url },
  });
  registerToolCompat(
    server,
    "firestarter_upload_image",
    {
      description:
        "Upload a product photo and get back a permanent hosted URL, accepted by firestarter_list and firestarter_update_listing image_urls. FOR A PHOTO ATTACHED IN THE CHAT, call this tool with NO image input (plus listing_id when a draft listing needs the photo): an interactive DROP ZONE is displayed in the chat, the seller drops the photo onto it, and the ORIGINAL file uploads at full quality — then attaches to the listing and requests activation automatically. EXCEPTION: a firestarter_list or firestarter_update_listing reply that reports a photoless draft ALREADY displays that drop zone — do not call this tool on top of it (that opens a duplicate zone); just tell the seller to drop the photo and end the turn. Never re-encode a chat attachment as base64 yourself, even via a code sandbox that can read it: model-emitted base64 is fabricated or truncated (a real 360 KB photo arrived as 9.7 KB) and can stall for minutes; the drop zone takes seconds and is lossless. The direct inputs are for other cases: image_url when the photo already exists at a public URL (the server fetches and re-hosts it — always prefer this over any base64)"
        + (localFiles ? "; image_path when the photo is a file on THIS computer (this local build reads it directly — cheap and lossless)" : "")
        + "; image_base64 (data-URI, max 6 MB) ONLY for bytes produced programmatically that exist nowhere else — in practice it is unreliable above ~1 MB. On a host without interactive widgets, direct the seller to the dashboard (https://firestarter.network/seller) or ask for a public URL.",
      inputSchema: {
        image_url: z.string().optional().describe("PREFERRED when a URL exists. Public URL of the photo; the server fetches and re-hosts it (JPEG, PNG, WebP, or GIF under 6 MB)."),
        ...(localFiles ? {
          image_path: z.string().optional().describe("Absolute path of an image file on THIS computer (JPEG, PNG, WebP, or GIF under 6 MB). This local build reads the file from disk itself — no bytes travel through the conversation. Use for any photo the seller references by file location."),
        } : {}),
        image_base64: z.string().optional().describe("LAST RESORT — only for bytes produced programmatically that exist at no URL and in no file. NEVER for a chat-attached photo: model-emitted base64 is fabricated or truncated; call with NO image instead to display the lossless drop zone. Data-URI format, max 6 MB, unreliable above ~1 MB; the server rejects a payload that arrives cut short."),
        filename: z.string().optional().describe("Optional original filename, kept only as a label. It does NOT decide the image format — the server reads that from the bytes — so a .jpg name on PNG data is harmless and a wrong extension can no longer mislabel the stored photo."),
        listing_id: z.string().optional().describe("When displaying the drop zone for a listing that needs its photo: the listing (lst_...) to attach uploads to. The widget attaches every dropped photo to it and requests activation automatically."),
        product_name: z.string().optional().describe("Optional product name to title the drop zone with, so the seller sees which listing the photo is for."),
      },
      annotations: { title: "Upload Product Image", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // The drop zone renders on the same widget resource as the shopping
      // grid; widgetAccessible lets the widget's own upload/attach calls
      // through on hosts that gate widget-originated tool calls.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI }, "openai/widgetAccessible": true },
    },
    async ({ image_url, image_path, image_base64, filename, listing_id, product_name }: {
      image_url?: string; image_path?: string; image_base64?: string; filename?: string;
      listing_id?: string; product_name?: string;
    }) => {
      try {
        // Local build only: read the file ourselves — ~20 tokens through the
        // model for any file size, and the bytes never touch the conversation.
        if (image_path && localFiles) {
          let bytes: Buffer;
          try {
            const info = await stat(image_path);
            if (!info.isFile()) {
              return { content: [{ type: "text" as const, text: `Error: ${image_path} is not a file.` }], isError: true };
            }
            if (info.size > 6 * 1024 * 1024) {
              return { content: [{ type: "text" as const, text: `Error: ${image_path} is ${(info.size / 1024 / 1024).toFixed(1)} MB — the limit is 6 MB. Ask the seller for a smaller export of the photo.` }], isError: true };
            }
            bytes = await readFile(image_path);
          } catch {
            return { content: [{ type: "text" as const, text: `Error: could not read ${image_path}. Check the path — it must be a file this machine can open.` }], isError: true };
          }
          const mime = sniffImageMimeLocal(bytes);
          if (!mime) {
            return { content: [{ type: "text" as const, text: `Error: ${image_path} is not a supported image. JPEG, PNG, WebP, or GIF only.` }], isError: true };
          }
          const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
          const res = await apiRequest("POST", "/v1/sellers/upload-image", { image_base64: dataUri, filename: filename || basename(image_path) }, UPLOAD_IMAGE_TIMEOUT_MS);
          const url = (res as any)?.url;
          if (!url) {
            return { content: [{ type: "text" as const, text: "Error: image upload returned no URL. The file may not be a valid image." }], isError: true };
          }
          return uploadSuccessResult(url);
        }
        if (image_url) {
          const res = await apiRequest("POST", "/v1/sellers/upload-image", { image_url, filename }, UPLOAD_IMAGE_TIMEOUT_MS);
          const url = (res as any)?.url;
          if (!url) {
            return { content: [{ type: "text" as const, text: "Error: image upload returned no URL. The URL must point to a public JPEG, PNG, WebP, or GIF under 6 MB." }], isError: true };
          }
          return uploadSuccessResult(url);
        }
        if (!image_base64) {
          // No image input at all: this is the DROP ZONE request. Look the
          // listing up (best-effort) so the widget knows the existing gallery
          // — image_urls replaces wholesale, forgetting them would delete
          // them — and whether a photo is the only thing blocking activation.
          const uploadRequest: Record<string, unknown> = {};
          let summary: Record<string, unknown> | null = null;
          if (listing_id) {
            const id = cleanListingId(listing_id);
            uploadRequest.listing_id = id;
            try {
              const listing = await apiRequest("GET", `/v1/listings/${id}`);
              summary = listingSummaryStructured(listing);
              uploadRequest.existing_image_urls = summary.images;
              uploadRequest.activate = shouldActivateAfterPhoto(listing);
              if (!product_name && typeof (listing as any)?.product_name === "string") {
                uploadRequest.product_name = (listing as any).product_name;
              }
            } catch {
              // The drop zone still works without the lookup; the widget just
              // starts from an empty gallery and attempts activation.
              uploadRequest.existing_image_urls = [];
              uploadRequest.activate = true;
            }
          }
          if (product_name) uploadRequest.product_name = String(product_name).slice(0, 120);
          const attachNote = uploadRequest.listing_id
            ? ` Every dropped photo attaches to listing ${uploadRequest.listing_id} at full quality${uploadRequest.activate ? " and activation is requested automatically" : ""}.`
            : " The hosted URLs will be reported back in the conversation.";
          // Same STOP phrasing as the firestarter_list draft reply — a
          // conditional fallback here would be executed immediately by a model
          // that cannot see whether the widget rendered.
          return {
            content: [{ type: "text" as const, text: `An upload drop zone is displayed — tell the seller to drop the product photo(s) onto it, or click it to pick files (several at once is fine; the first becomes the cover, and more can be dropped afterwards to grow the gallery).${attachNote} A \`[photo-upload widget]\` note will report the result — do NOT call this or any other tool again now, and END YOUR TURN after telling the seller. Only if the seller REPLIES that no drop zone is visible: send them to the dashboard uploader (https://firestarter.network/seller) or take a public photo URL from them. Never re-encode a chat-attached photo as base64 — that path truncates the image and can stall.` }],
            structuredContent: summary ? { upload_request: uploadRequest, listing: summary } : { upload_request: uploadRequest },
          };
        }
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

        const res = await apiRequest("POST", "/v1/sellers/upload-image", {
          image_base64,
          filename,
        }, UPLOAD_IMAGE_TIMEOUT_MS);
        const url = (res as any)?.url;
        if (!url) {
          return { content: [{ type: "text" as const, text: "Error: image upload returned no URL. The image may be invalid or too large (max 6 MB)." }], isError: true };
        }
        return uploadSuccessResult(url);
      } catch (err: any) {
        const msg = toErrorMessage(err);
        // commerce#849: toErrorMessage answers every timeout with "retry in a
        // few seconds". On an upload that is an instruction to repeat a request
        // that will fail identically — the reporter followed it until their
        // Claude quota ran out — and it is not even reliably true that nothing
        // happened, since the API can finish an ingest after the client stops
        // waiting. Say what to do DIFFERENTLY instead.
        if (isTimeoutMessage(msg)) {
          const nextStep = image_base64 && !image_url
            ? "Do not resend the same base64 — a large data URI is the slow path. For a chat-attached photo, call this tool again with NO image to display the drop zone; otherwise get a public URL and pass it as image_url."
            : "Do not immediately repeat the same call. Check the listing first: the upload may have completed on the server after this call stopped waiting.";
          return {
            content: [{ type: "text" as const, text: `The image upload didn't return in time. ${nextStep}` }],
            isError: true,
          };
        }
        // A base64 payload that arrived broken (truncated/invalid): hand the
        // agent the working path, not an invitation to retry the same way.
        const brokenBase64Hint = image_base64 && !image_url
          ? " For a photo attached in this chat, call this tool again with NO image to display the drop zone — never rebuild the base64."
          : "";
        return { content: [{ type: "text" as const, text: `Error uploading image: ${msg}${brokenBase64Hint}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_register_seller
  server.tool(
    "firestarter_register_seller",
    "Register the current account as a seller on Firestarter. Registration is the precondition for creating listings (firestarter_list), importing products (firestarter_import), and connecting a store (firestarter_connect_shopify): a NO_SELLER_PROFILE error from those tools means this registration hasn't happened yet, and they succeed once it has. Only requires a business_name. Idempotent: if the account is already a seller, returns the existing profile without error. After registration the seller can immediately list products - payouts (firestarter_payouts) can be set up later.",
    {
      business_name: z.string().describe("REQUIRED. The seller's business or brand name, e.g. \"Tania's Art Studio\" or \"QuickShip Electronics\"."),
      type: z.enum(["retailer", "wholesaler", "manufacturer", "reseller"]).optional().describe("Optional. Seller type. Defaults to 'retailer'. Only ask if the seller mentions they're a wholesaler/manufacturer."),
      // Captured here so firestarter_payouts never has to interrupt to ask. It
      // stays OPTIONAL because registration must not become a gate — listing is
      // the point of this tool, and payouts can be set up later.
      country: z.string().optional().describe("Optional. ISO 3166-1 alpha-2 code of the country the seller's business BANKS IN, e.g. 'MY', 'TH', 'US'. Pass it if the seller has already mentioned where they are — it is required later for Stripe payouts and recording it now saves an extra round-trip. Never invent one: omit it rather than guessing from language or timezone, because Stripe locks it permanently at account creation."),
    },
    { title: "Register as Seller", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ business_name, type, country }) => {
      try {
        const body: any = { business_name };
        if (type) body.type = type;
        if (country) body.country = country;
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
        text += `\n**Payouts:** Not required to start selling — connect one later with \`firestarter_payouts\` when ready to receive money. Until then, listings go live and sell normally; earnings wait safely in escrow (${sellingGateSentence(null)}). Not sure a country is payable? Check first with \`firestarter_payout_eligibility\`.\n`;
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
  registerToolCompat(
    server,
    "firestarter_list",
    {
      description:
        "List (create) a product for sale on Firestarter. ONLY two fields are required: product_name and base_price (USD). Everything else is OPTIONAL with sensible defaults, so a listing can be created from minimal information and refined afterwards; the response echoes the resulting settings. Defaults when omitted: inventory unlimited, shipping = estimated live at checkout by the delivery provider (based on the buyer's destination; sellers no longer set a flat/free rate), ship-from = account default address, ships worldwide (cross-border buyers get a duties disclosure; restrict with shipping_policy). Also optionally settable: brand, condition, sku, return policy, dispatch time, country of origin, physical dimensions/weight, materials, tags, and size/color variants — all of them can be filled in later with firestarter_update_listing. image_urls accepts photo URLs that already exist (e.g. hosted URLs returned by firestarter_upload_image); for a photo ATTACHED IN THE CHAT, create the listing WITHOUT image_urls — the draft response displays a drop zone the seller drops the photo onto, which attaches it losslessly and activates the listing (never re-encode an attachment as base64). The listing goes live instantly unless something blocks activation (e.g. no product photo yet — see allow_imageless), in which case it's saved as a draft and the response lists exactly what to fix. To VIEW or edit listings you already have, use firestarter_listings / firestarter_update_listing instead; to BROWSE other sellers' products, use firestarter_catalog_search.",
      inputSchema: {
        product_name: z.string().describe("REQUIRED. What's being sold, e.g. 'Logitech MX Master 3S Wireless Mouse'."),
      base_price: z.number().describe("REQUIRED. Sale price in USD, e.g. 49.99."),
      category: z.string().optional().describe("Optional. Product category (e.g. 'electronics/audio/earbuds'). Infer a reasonable one from the product name if obvious; otherwise omit — don't ask."),
      floor_price: z.number().optional().describe("Never sell below this price"),
      ceiling_price: z.number().optional().describe("Never surge above this price"),
      dynamic_pricing: z.boolean().optional().describe("Enable demand-based pricing"),
      inventory_qty: z.number().optional().describe("Optional. Available quantity. Omit for unlimited — don't ask the seller unless they mention stock limits."),
      image_urls: z.array(z.string()).optional().describe("Public product photo URLs (first is the primary image), e.g. hosted URLs returned by firestarter_upload_image. For a photo the seller ATTACHED IN THE CHAT, do NOT try to pass it here — create the listing without photos and the draft response displays a drop zone that uploads the original file losslessly. Never rebuild an attachment as a base64 data-URI, and never ask the seller to re-send a photo already in the conversation."),
      video_urls: z.array(z.string()).optional().describe("Product video URLs (MP4 or WebM, up to 25 MB and about 60 seconds each, max 3). The server fetches and re-hosts each one, so pass any public https URL — there is no separate upload step and no base64 form: a 25 MB video does not survive being emitted as a tool argument. Omit to leave existing videos untouched; pass an empty array to remove them. Videos are shown alongside the photos on the listing page and the share page."),
      source_url: z.string().url().optional().describe("Optional. If the seller mentions or pastes a link to their OWN existing listing for this product elsewhere (their Etsy/eBay/Shopify page, etc.), pass it here. Firestarter will fetch it once and fill in whatever descriptive details (description, category, brand, materials, tags, condition) the seller didn't already give you — it never overwrites anything you explicitly set. Best-effort: if the fetch fails or finds nothing, the listing is still created normally."),
      shipping: z.number().optional().describe("Deprecated and ignored — shipping is always estimated live from a delivery service provider based on the buyer's destination; sellers no longer set a flat/free shipping price. Accepted for backward compatibility only."),
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
      fulfillment_mode: z.enum(["platform", "seller_managed"]).optional().describe("How orders for this listing get shipped. 'seller_managed' = NO platform label is ever bought: each paid order holds in awaiting_shipment until the seller ships it with their own carrier and enters tracking via firestarter_ship_order. 'platform' = the platform always books the carrier label. Omit for auto: platform label when a carrier-ratable ship-from exists, otherwise seller-managed. Pass 'seller_managed' when the seller says they ship orders themselves / with their own courier."),
      allow_imageless: z.boolean().optional().describe("Override the NEEDS_IMAGE activation gate and let this listing go live with no photo. Only pass true if the seller explicitly can't provide one right now."),
      allow_duplicate: z.boolean().optional().describe("Create this listing even though the seller already has one with the same name. Only pass true if the seller confirms they genuinely want a second, separate listing."),
      ...listingDetailFields,
      },
      annotations: { title: "Create Listing", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // MCP Apps: a draft that needs its photo renders the drop zone right in
      // this tool's reply — one step, not a follow-up upload_image call; a
      // clean create renders the listing card.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
    },
    async ({ product_name, base_price, category, floor_price, ceiling_price, dynamic_pricing, inventory_qty, image_urls, video_urls, source_url, shipping, ship_from, shipping_policy, fulfillment_mode, allow_imageless, allow_duplicate, ...details }: any) => {
      try {
        const body: any = { product_name, base_price };
        if (category) body.category = category;
        if (floor_price !== undefined) body.floor_price = floor_price;
        if (ceiling_price !== undefined) body.ceiling_price = ceiling_price;
        if (dynamic_pricing !== undefined) body.dynamic_pricing = dynamic_pricing;
        if (inventory_qty !== undefined) body.inventory_qty = inventory_qty;
        if (image_urls?.length) body.images = image_urls;
        if (video_urls?.length) body.video_urls = video_urls;
        if (source_url) body.source_url = source_url;
        // `shipping` is deprecated/ignored (always estimated live) — not forwarded.
        void shipping;
        if (ship_from) body.ship_from = ship_from;
        if (shipping_policy) body.shipping_policy = shipping_policy;
        if (fulfillment_mode) body.fulfillment_mode = fulfillment_mode;
        if (allow_imageless !== undefined) body.allow_imageless = allow_imageless;
        if (allow_duplicate !== undefined) body.allow_duplicate = allow_duplicate;
        for (const [key, value] of Object.entries(details)) {
          if (value !== undefined) body[key] = value;
        }
        const listing = await apiRequest("POST", "/v1/listings", body, listingWriteTimeoutMs(body));
        let text = `**Listing created: ${listing.product_name}**\nID: \`${listing.id}\`\nStatus: ${listing.status || "active"}\nBase price: $${listing.base_price}\n`;
        if (listing.floor_price) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing) text += `Dynamic pricing: enabled\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        text += `Shipping: estimated at checkout by the delivery provider, based on the buyer's destination\n`;
        if (listing.fulfillment_mode === "seller_managed") text += `Fulfillment: seller-managed — each paid order holds in awaiting_shipment until you ship it and add tracking with firestarter_ship_order\n`;
        if (Array.isArray(listing.images) && listing.images.length) text += `Photos: ${listing.images.length} attached\n`;
        // ...and the ones that did NOT attach. "Photos: 2 attached" on a
        // 3-photo create is true and still leaves the seller believing all
        // three landed (commerce#858/3).
        text += rejectedPhotosText(listing);
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
          text += `Share link: ${mdUrlLink(listingShareUrl(listing)) ?? listingShareUrl(listing)}\n`;
          text += `\nPaste the share link bare in chat — it unfurls into a product card, humans see "ask your AI agent to buy this", and any agent that opens it gets purchase instructions. Buyers' agents also discover this via network search. Use \`firestarter_listings\` to view it anytime.`;
        } else {
          text += `\n**Sandbox-only listing.** No public share link is created in test mode. It remains available through test-mode catalog and listing tools.`;
        }
        // No photo on the listing → this reply CARRIES the drop zone (widget
        // hosts render it inline via structuredContent.upload_request below),
        // so the seller drops the photo on the listing confirmation itself —
        // no follow-up tool call. Non-widget hosts get the dashboard deep link.
        const needsPhoto = !(Array.isArray(listing.images) && listing.images.length);
        if (needsPhoto) {
          // Build via URL so a base with an existing query string / trailing
          // path still yields a valid, encoded link (never `...?a=b?edit=`).
          const uploaderUrl = new URL(SELLER_DASHBOARD_URL);
          uploaderUrl.searchParams.set("edit", String(listing.id));
          // Phrased as a STOP, not a fallback menu. The model cannot see
          // whether the host rendered the widget, so a conditional "if no drop
          // zone is visible, call X" reads as an instruction and gets executed
          // immediately — which is exactly the double-drop-zone bug: a second
          // upload_image call in the same turn, before the seller could touch
          // the first zone. The rule is therefore unconditional: end the turn;
          // act again only on the seller's word or the widget's own note.
          text += `\n\n📷 **Add a photo.** This reply already displays a photo DROP ZONE on hosts that render widgets. Tell the seller to drop the photo(s) onto it — the original files upload at full quality, attach to this listing, and it goes live automatically; a \`[photo-upload widget]\` note will report the result. Do NOT call firestarter_upload_image or any other tool now — that would open a second, duplicate drop zone. END YOUR TURN after telling the seller. Only if the seller REPLIES that no drop zone is visible: ${mdLink("send them to the dashboard uploader", uploaderUrl.toString()) ?? `send them to ${uploaderUrl.toString()}`}, or take a public photo URL from them. Never re-encode a chat-attached photo as base64.`;
        }
        // Surface payout warnings — listing is active but seller should
        // connect Stripe to actually receive earnings.
        if (Array.isArray(listing.activation_warnings) && listing.activation_warnings.length > 0) {
          for (const warn of listing.activation_warnings) {
            if (warn.code === "SELLER_PAYOUTS_RECOMMENDED") {
              text += `\n\n⚠️ **Payouts not connected.** The listing is live and sellable — earnings just wait in escrow until a payout method is connected (${sellingGateSentence(null)}). Call \`firestarter_payouts\` to connect one (~2 minutes), or \`firestarter_payout_eligibility\` to check a country first.`;
            }
          }
        }
        // Widget payload: the listing card, plus the drop zone whenever the
        // gallery is empty (activate only when the photo is the sole gate —
        // see shouldActivateAfterPhoto).
        const structured: Record<string, unknown> = { listing: listingSummaryStructured(listing) };
        if (needsPhoto) {
          structured.upload_request = {
            listing_id: listing.id,
            product_name: listing.product_name,
            existing_image_urls: [],
            activate: shouldActivateAfterPhoto(listing),
          };
        }
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
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

  // Tool: firestarter_bulk_list
  // Same shape as firestarter_list, but accepts many products in one call —
  // for a seller migrating an existing catalog. Calls POST /v1/listings/bulk
  // (same REST hop every other listing tool here makes via apiRequest).
  server.tool(
    "firestarter_bulk_list",
    "Create MANY products at once — for migrating an existing catalog (e.g. from a CSV or spreadsheet the seller pasted/described). Each product needs product_name and base_price at minimum; everything firestarter_list accepts per-item is accepted here too (brand, condition, sku, variants, etc.). Up to 100 products per call — for more, call this tool again with the next batch. One bad item never blocks the others: the response reports exactly which products were created and which failed, with why. For a SINGLE product, use firestarter_list instead — it has richer per-listing guidance in its response.",
    {
      products: z.array(z.object({
        product_name: z.string().optional().describe("REQUIRED per item — an item missing this will fail and be reported in the response's failed list; other items still succeed."),
        base_price: z.number().optional().describe("REQUIRED per item — an item missing this will fail and be reported in the response's failed list; other items still succeed."),
        category: z.string().optional(),
        inventory_qty: z.number().optional(),
        image_urls: z.array(z.string()).optional().describe("Public product photo URLs (first is primary)."),
        ...listingDetailFields,
      })).min(1).max(100).describe("The products to create, up to 100 per call."),
    },
    { title: "Create Listings in Bulk", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ products }) => {
      try {
        const body = {
          products: products.map(({ image_urls, ...rest }) => ({
            ...rest,
            ...(image_urls?.length ? { images: image_urls } : {}),
          })),
        };
        const result = await apiRequest("POST", "/v1/listings/bulk", body);
        const created: any[] = result.created || [];
        const failed: any[] = result.failed || [];
        let text = `**Bulk import: ${created.length} created, ${failed.length} failed** (of ${products.length} submitted)\n`;
        if (created.length) {
          text += `\nCreated:\n`;
          for (const c of created) text += `- [${c.index}] \`${c.id}\` (${c.status}) — ${products[c.index]?.product_name || ""}\n`;
        }
        if (failed.length) {
          text += `\nFailed:\n`;
          for (const f of failed) text += `- [${f.index}] ${products[f.index]?.product_name || ""}: ${f.error} (${f.code})\n`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error bulk-creating listings: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_import
  // A2: the Cole-chat seller claim funnel. Wraps POST /v1/listings/import -
  // the draft is reviewed in chat, then activated via firestarter_update_listing.
  server.tool(
    "firestarter_import",
    "Import a seller's EXISTING listing from another marketplace (Craigslist, Gumtree, their own site) into Firestarter. Give it the listing URL, or pasted listing text plus photo URLs, and it creates a DRAFT listing for the seller to review - not live, not buyable, no share link yet. Amazon, Walmart, eBay, Etsy, Facebook Marketplace, OfferUp, Mercari and Shopee usually block server fetches: a fetch is still attempted, but for these platforms a call carrying BOTH source_url (for provenance) AND raw_text + photo_urls succeeds in one round trip where the fetch alone rarely does. Other sites that fail return PLATFORM_BLOCKED or EXTRACTION_EMPTY - a retry with the seller's pasted listing text in raw_text (plus photo_urls) recovers the import. Activation (firestarter_update_listing, status 'active') requires a positive price (firestarter_reprice if the import found none) and at least one photo.",
    {
      source_url: z.string().optional().describe("URL of the seller's existing listing (e.g. a Craigslist post). For known bot-blocking platforms (Amazon, eBay, Etsy, Facebook, OfferUp, Mercari, Walmart, Shopee), still include this for provenance, but pair it with raw_text up front."),
      raw_text: z.string().optional().describe("Pasted listing text (title, price, description - at least 10 characters). Send this alongside source_url up front for known bot-blocking platforms (Amazon, eBay, etc.) - a fetch will still be tried but is unlikely to succeed. Required whenever source_url is omitted or a fetch fails; also fills gaps URL extraction missed."),
      photo_urls: z.array(z.string()).optional().describe("Photo URLs for the listing, e.g. image links the seller pasted in chat. Seller photos lead the images array."),
    },
    { title: "Import Catalog", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    "BUYER-side tool: the user found a listing on another site (Craigslist, Facebook Marketplace, Gumtree, ...) and wants to pay through Firestarter escrow instead of cash/wire. Creates an escrow invite with a claim link for the SELLER, plus a ready-to-send message. Firestarter never contacts external sellers: the invite reaches the seller only when the buyer sends that message themselves through the platform where they found the listing. Needs the listing URL and the buyer's email (that is where the goes-live notification lands). Facebook Marketplace / eBay / Etsy / OfferUp / Mercari usually block the fetch - a fetch is still attempted, and a call that also carries the item title and price yields an invite with real data even when the fetch fails.",
    {
      source_url: z.string().describe("URL of the external listing the buyer wants to purchase"),
      buyer_email: z.string().describe("Buyer's email address - notified when the seller claims and the listing goes live"),
      buyer_name: z.string().optional().describe("Buyer's first name (shown to the seller on the claim page)"),
      title: z.string().optional().describe("Item title, buyer-supplied. Ask for this up front for platforms that usually block fetches (Facebook Marketplace etc.) - the fetch is tried but is unlikely to succeed."),
      price: z.number().optional().describe("Asking price in the listing's currency, buyer-supplied (for platforms that usually block fetches)"),
    },
    { title: "Request Escrow", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
          text += `Share link: ${mdUrlLink(r.share_url) ?? r.share_url}\n\nNo invite needed - the buyer can pay through escrow right now from that link.`;
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
    "Get pickup+delivery quotes for a PHYSICAL item, including loading/unloading help (a courier crew) for bulky or heavy things - weight racks, sofas, appliances. Use when a buyer or seller asks how to move an item, or proactively when an item is clearly bulky. Pure price check: books nothing, charges nothing. Include lat/lng for both stops when the user shared a location pin - some couriers (Lalamove in Thailand) cannot quote without coordinates. Returns quotes cheapest-first, each with a quote_ref that firestarter_assist_book takes to book it; booking is a real dispatch with a real charge and requires the human's prior confirmation of the exact price.",
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
    { title: "Assist Quote", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
          // test_mode_gated (routes/assist.ts): the request never reached a
          // provider at all — this environment sits assist out for every
          // test-mode order (see assist-test-mode-isolation.test.ts) unless
          // ASSIST_SANDBOX is set. That is not a market-coverage gap, so don't
          // render the coverage-doubt / arrange-it-yourselves fallback for it.
          const text = r.test_mode_gated
            ? (r.message || "No quote: this is a test-mode order and this environment has no assist sandbox configured — this is not a coverage gap.")
            : `${r.message || "No courier could quote this route (outside coverage, or the item may be too large)."} Suggest the parties arrange the handoff themselves.`;
          return { content: [{ type: "text" as const, text }] };
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
    "Book a courier from a firestarter_assist_quote result. Booking dispatches a real crew and the fee is charged to the buyer's order; it requires the human's prior explicit confirmation of the exact quoted price. When the booking is linked to a purchase execution, the courier's proof-of-delivery photo starts the escrow inspection window automatically.",
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
    // Dispatches a real courier crew and charges the fee to the buyer's order.
    // The description tells the model to confirm the price with a human first;
    // annotating it non-destructive told the host it need not prompt, leaving
    // that guarantee resting entirely on the model obeying prose.
    { title: "Assist Book", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
        if (r.tracking_url) text += `${mdLink("Track this shipment", r.tracking_url) ?? `Tracking: ${r.tracking_url}`}\n`;
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
    "Manage seller payout method — this is how a seller RECEIVES money, not permission to sell. A seller with no payout method lists and sells normally; earnings wait in escrow, and selling pauses automatically only once held earnings pass a cap or the oldest hold has been waiting a long time — call this tool for the current thresholds rather than quoting one, they are set by the API and change. Two providers, and NEITHER reaches everywhere: Stripe pays into bank accounts in ~44 documented recipient countries (incl. much of Europe, JP, SG, HK, MY, TH, IN) and its reach is UNKNOWN — not necessarily no — outside that list; PayPal covers more (~92) but excludes Pakistan, Bangladesh, Nigeria and Egypt among others. Do not promise either rail for a country without checking. Call with no arguments to check current status. Pass `provider` to set up a new method. Stripe eligibility is decided by Stripe from the seller's real country — there is no client-side ineligible-country list. To check a specific country before the seller invests any effort, call firestarter_payout_eligibility.",
    {
      // Wise/Payoneer are implemented but not selectable — neither connect flow
      // yields a destination its adapter can spend, and the API answers 501
      // PROVIDER_NOT_AVAILABLE for both. See services/payouts/providers.ts.
      //
      // Both manifests advertised all four here long after this enum narrowed,
      // and firestarter-commerce's /discovery route serves mcp.json verbatim —
      // so the live .well-known manifest offered two rails whose follow-up call
      // this very enum then rejected. mcp-manifest-parity.test.ts now compares
      // enum VALUES, not just parameter names, so that cannot drift again.
      provider: z.enum(["stripe", "paypal"]).optional().describe("Which payout provider to set up. Omit to check current status. 'stripe' = Stripe Connect (eligibility is Stripe's call, not a fixed list), 'paypal' = PayPal email (global, needs only the account email)."),
      country: z.string().optional().describe("ISO 3166-1 alpha-2 code of the country the seller's business BANKS IN, e.g. 'MY', 'TH', 'SG', 'US'. REQUIRED for provider='stripe' unless the seller recorded one at registration: the API refuses to guess, because Stripe locks the country permanently at account creation and a wrong one can only be fixed by discarding the account. If Stripe does not support it you get a clear 422 naming the country — do not pre-filter on the seller's behalf. Irrelevant for PayPal."),
      paypal_email: z.string().optional().describe("PayPal email for receiving payouts. Required when provider='paypal'."),
    },
    // Sets where every future payout for this seller is sent. That makes it the
    // most attractive target on the surface for a prompt-injected agent, and it
    // was running unprompted.
    // destructiveHint: this tool multiplexes read and write — calling it bare
    // lists, calling it with arguments MOVES MONEY. MCP annotations are
    // per-tool, not per-invocation, so the classification has to cover the
    // worst it can do. The cost is a host confirmation on the read path too;
    // that is the right trade against an unprompted refund/payout change.
    { title: "View Payouts", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ provider, country, paypal_email }) => {
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
            // Only the two rails the `provider` enum above accepts. Wise and
            // Payoneer were listed here for a long time: neither connect flow
            // yields a destination its adapter can spend, so a seller who picked
            // one was steered into a rail that can never pay them. Stripe's
            // reach was also given as "US/GB/CA/AU only", which was a hardcoded
            // API allowlist that no longer exists — eligibility is Stripe's
            // call now, so quoting a country list here only talks sellers out of
            // the rail that would have worked.
            text = `**No payout method configured.** You can still list and sell — earnings wait safely in escrow — but ${sellingGateSentence(status?.selling_gate)}.\n\nAvailable providers:\n- **Stripe** — bank payouts wherever Stripe Connect operates, incl. much of Asia-Pacific; ~5 min setup. Needs the country the business banks in (locked permanently once connected).\n- **PayPal** — ~2 min setup (just an email), but its payouts list does not cover every country.\n\nNot sure we can pay your country? Call \`firestarter_payout_eligibility\` first.\n\nCall \`firestarter_payouts\` with \`provider\` set to your choice.`;
          }
          return { content: [{ type: "text" as const, text }] };
        }

        // Set up the chosen provider
        if (provider === "stripe") {
          // Existing Stripe Connect flow
          const body: Record<string, string> = {};
          if (country) body.country = country;
          const link = await apiRequest("POST", "/v1/sellers/stripe-connect", Object.keys(body).length > 0 ? body : undefined);
          let text: string;
          if (!link.onboarding_url) {
            // Test-mode accounts are auto-approved server-side (routes/sellers.ts) —
            // there is no onboarding link because none is needed. Without this branch
            // the tool interpolated the missing link straight into the reply as the
            // literal string "null".
            text = `**Stripe Connect setup (test mode)**\n\n${link.message || "Test mode: Stripe Connect account auto-approved — no onboarding needed."}\n\nListings are now purchasable by buyers.`;
          } else {
            text = `**Stripe Connect setup**\n\n${mdLink("Complete Stripe onboarding", link.onboarding_url) ?? `Send the seller this onboarding link (a secure Stripe-hosted page):\n${link.onboarding_url}`} — a secure Stripe-hosted page; send it to the seller.\n`;
            text += `\nAfter they finish, run \`firestarter_payouts\` again to verify.`;
          }
          return { content: [{ type: "text" as const, text }] };
        }

        if (provider === "paypal") {
          if (!paypal_email) {
            return { content: [{ type: "text" as const, text: "To set up PayPal payouts, call `firestarter_payouts` with `provider: \"paypal\"` and `paypal_email: \"seller@email.com\"`. The seller will receive payouts to that PayPal account." }] };
          }
          const result = await apiRequest("POST", "/v1/sellers/payout-method/paypal", { email: paypal_email });
          // #478 made this a two-step, ownership-proven flow: a fresh submission
          // comes back pending_confirmation/confirmed:false until the seller clicks
          // the emailed link, and nothing pays out to it until then. Claiming
          // "connected" here used to contradict result.message in the same reply.
          const text = result.confirmed
            ? `**PayPal payouts confirmed!**\nEmail: ${paypal_email}\nStatus: confirmed — this is the account earnings pay out to\n\n${result.message}\n\nListings are purchasable by buyers.`
            : `**PayPal address submitted — confirmation required.**\nEmail: ${paypal_email}\nStatus: pending confirmation — nothing pays out here until the seller clicks the emailed link\n\n${result.message}\n\nListings are purchasable by buyers now; earnings wait safely in escrow until the address is confirmed.`;
          return { content: [{ type: "text" as const, text }] };
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

  // Tool: firestarter_payout_eligibility
  server.tool(
    "firestarter_payout_eligibility",
    "Check whether Firestarter can pay a seller in a given country BEFORE they invest any effort — no seller account required. Takes an ISO 3166-1 alpha-2 country code and returns each payout rail's verdict for it. PayPal publishes its own payouts country list, so its 'unsupported' verdict is authoritative; Stripe decides eligibility per seller at connect time, so it comes back 'unknown' for any country outside a small documented snapshot — never treat 'unknown' as 'no'. Use this whenever someone asks 'can I sell on Firestarter from <country>' or before walking a seller through registration, so an unsupported country is caught up front instead of after earnings accrue that cannot be withdrawn. A seller in an unsupported (or still-undetermined) country can still register, list, and sell — earnings wait in escrow — but selling eventually pauses once held earnings pass a cap or the oldest hold has been waiting a long time (call firestarter_payouts for the current thresholds), which is exactly why checking first is worth it.",
    {
      country: z.string().length(2).describe("ISO 3166-1 alpha-2 country code, e.g. 'PK', 'NG', 'MY'."),
    },
    {
      title: "Check Payout Eligibility",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ country }) => {
      try {
        const res = await apiRequest("GET", `/v1/payouts/eligibility?country=${encodeURIComponent(country)}`);
        const rails = (res?.rails ?? []) as Array<{
          provider: string;
          supported: boolean;
          verdict: "supported" | "unsupported" | "unknown";
          requirements: string[];
        }>;
        const label = countryLabel(res?.country || country);

        const usable = rails.filter((r) => r.verdict === "supported");
        if (usable.length > 0) {
          const lines = usable
            .map((r) => `- **${r.provider.toUpperCase()}** — needs: ${r.requirements.length ? r.requirements.map((x) => x.replace(/_/g, " ")).join(", ") : "no extra setup"}`)
            .join("\n");
          const parts = [`**We can pay sellers in ${label}.**\n\n${lines}`];
          // A rail already confirmed does not make a still-"unknown" rail (e.g.
          // Stripe outside our best-effort seed) worth hiding — the whole point
          // of carrying "unknown" through this tool is that it can ALSO work,
          // decided per seller at connect time. Dropping it here would flatten
          // the exact distinction unpaidCountryHeadline exists to preserve.
          const maybe = rails.filter((r) => r.verdict === "unknown");
          if (maybe.length > 0) {
            parts.push(unknownRailNote(maybe.map((r) => r.provider.toUpperCase())));
          }
          parts.push(`Set one up with \`firestarter_payouts\`.`);
          return {
            content: [{
              type: "text" as const,
              text: parts.join("\n\n"),
            }],
          };
        }

        // No rail confirmed yet. The headline is derived from each rail's
        // VERDICT, never from the flattened `supported: false` — an "unknown"
        // rail (Stripe, which decides per seller at connect time) must never
        // be folded into "we can't pay this country". See unpaidCountryHeadline.
        const parts = [unpaidCountryHeadline(rails, label)];
        parts.push(`A seller can still register, list, and sell from ${label} right now — earnings wait safely in escrow — but ${sellingGateSentence(null)}.`);
        if (res?.waitlist_available) {
          parts.push(`We're tracking demand for ${label}; ask the seller if they'd like to be notified when a confirmed rail opens.`);
        }
        return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
      } catch (err: any) {
        if (err instanceof ApiError && err.code === "INVALID_COUNTRY") {
          return {
            content: [{ type: "text" as const, text: "Pass a two-letter ISO country code, e.g. 'PK' or 'MY'." }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Couldn't check eligibility: ${toErrorMessage(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: firestarter_connect_shopify
  server.tool(
    "firestarter_connect_shopify",
    "Connect a seller's Shopify store to Firestarter — step 1 of the Shopify flow: connect_shopify → (catalog syncs automatically) → firestarter_listings to see imported products → firestarter_sync_shopify to refresh after store edits → orders arrive via firestarter_seller_orders → firestarter_ship_order. Called with NO arguments: if a store is already connected it returns the connection status, store name, and last sync time; if not, the response reports that the store handle is the missing input. Called with shop_handle: mints a one-click install link — the seller clicks it, approves on Shopify, and their whole catalog syncs into Firestarter automatically (no tokens to paste). Use this whenever a seller mentions Shopify, wants to connect/link their store, or asks why their products aren't showing up. The store handle is the part before .myshopify.com in their Shopify admin URL (Settings > Domains > the permanent xxxxx.myshopify.com, NOT their custom domain). To force a fresh catalog pull on an already-connected store, use firestarter_sync_shopify instead.",
    {
      shop_handle: z.string().optional().describe("Optional. The seller's Shopify store handle (e.g. 'matrix-store' from matrix-store.myshopify.com). Omit on the first call to check existing connection status — only needed when no store is connected yet. Accepts the bare handle or the full myshopify.com domain (it's normalized). If the seller doesn't know it, tell them: Shopify admin > Settings > Domains > the permanent .myshopify.com address."),
    },
    { title: "Connect Shopify", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ shop_handle }) => {
      try {
        // Check existing connections first
        const conns = await apiRequest("GET", "/v1/connections");
        const shopifyConn = (conns.connections || []).find((c: any) => c.platform === "shopify");

        if (shopifyConn) {
          let text = `**Shopify store connected:** ${shopifyConn.shop_name || shopifyConn.shop_domain}\n`;
          text += `Status: ${shopifyConn.status}\n`;
          if (shopifyConn.last_synced_at) text += `Last catalog sync: ${shopifyConn.last_synced_at}\n`;
          const shopifyErrSummary = summarizeConnectionError(shopifyConn.error_message);
          if (shopifyErrSummary) text += `Error: ${shopifyErrSummary}\n`;
          text += `\n${connectionListedLine(shopifyConn, "store")}`;
          if (shopifyConn.status !== "error") text += ` View them with firestarter_listings.`;
          // #556: point the agent at the right next action instead of leaving it stuck.
          if (shopifyConn.status === "error") {
            text += `\n\nRun firestarter_sync_shopify to retry the catalog sync. If it keeps failing, the seller may need to reconnect from the Firestarter dashboard.`;
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
    "Connect a seller's TikTok Shop to Firestarter so their catalog syncs and orders flow back. If a TikTok Shop is already connected, returns its status. TikTok Shop currently connects by ACCESS TOKEN (not one-click OAuth yet): the seller authorizes Firestarter in TikTok Shop Partner Center and provides their shop access token + shop id/region. Call with no arguments to check status or get setup instructions; call with access_token AND shop_domain to create the connection. Use this whenever a seller mentions TikTok Shop or wants to sync their TikTok products. The access token is a secret credential: it is stored encrypted server-side and never echoed in any response.",
    {
      access_token: z.string().optional().describe("The seller's TikTok Shop access token (from TikTok Shop Partner Center authorization). Omit to check status or get instructions. This is a secret — never echo it back."),
      shop_domain: z.string().optional().describe("The seller's TikTok Shop identifier (shop id, shop cipher, or region/store name). Required together with access_token to create the connection."),
    },
    { title: "Connect TikTok Shop", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ access_token, shop_domain }) => {
      try {
        // Check existing connection first.
        const conns = await apiRequest("GET", "/v1/connections");
        const tiktokConn = (conns.connections || []).find((c: any) => c.platform === "tiktok_shop");

        if (tiktokConn) {
          let text = `**TikTok Shop connected:** ${tiktokConn.shop_name || tiktokConn.shop_domain}\n`;
          text += `Status: ${tiktokConn.status}\n`;
          if (tiktokConn.last_synced_at) text += `Last catalog sync: ${tiktokConn.last_synced_at}\n`;
          const errSummary = summarizeConnectionError(tiktokConn.error_message);
          if (errSummary) text += `Error: ${errSummary}\n`;
          // #556 fixed this claim for Shopify but missed TikTok: a connection
          // stuck in 'error' either never finished a catalog sync (nothing
          // listed) or is only stale (prior sync's items are still listed) —
          // either way "products are listed and discoverable" alone was wrong.
          text += `\n${connectionListedLine(tiktokConn, "shop")}`;
          if (tiktokConn.status === "error") {
            text += ` TikTok Shop connects by access token, not OAuth — if the token expired or was revoked, ask the seller for a fresh access token and call firestarter_connect_tiktok again with it (disconnect the old one from the dashboard first).`;
          }
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

  // Tool: firestarter_connect_store
  // Covers the platforms without a dedicated tool. Shopify/TikTok Shop keep
  // their own richer tools (one-click link / documented OAuth-pending flow) -
  // this one is deliberately generic since the other 5 platforms all connect
  // the same way /v1/connections already expects: a manually-obtained token.
  server.tool(
    "firestarter_connect_store",
    "Connect a seller's BigCommerce, Shopee, Lazada, Wix, or WooCommerce store to Firestarter. For Shopify use firestarter_connect_shopify instead (one-click install link); for TikTok Shop use firestarter_connect_tiktok. Call with just `platform` first to check for an existing connection or get platform-specific credential instructions; call again with credentials to connect.",
    {
      // shopify/tiktok_shop are accepted here ONLY so the handler below can catch
      // them and redirect to the right tool with a friendly message — a strict
      // 5-value enum previously rejected those two at the schema-parse stage,
      // before the handler's redirect code ever ran, surfacing a raw MCP
      // validation error instead.
      platform: z.enum(["bigcommerce", "shopee", "lazada", "wix", "woocommerce", "shopify", "tiktok_shop"]),
      access_token: z.string().optional().describe("Required for bigcommerce/shopee/lazada/wix. Not used for woocommerce — use consumer_key/consumer_secret instead."),
      shop_domain: z.string().optional().describe("Store identifier: BigCommerce store hash, Shopee/Lazada shop id, Wix account id, or — for WooCommerce — your store's domain WITHOUT `https://` (e.g. `mystore.com`)."),
      consumer_key: z.string().optional().describe("WooCommerce only — from WooCommerce > Settings > Advanced > REST API."),
      consumer_secret: z.string().optional().describe("WooCommerce only — paired with consumer_key."),
    },
    { title: "Connect a Store", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ platform, access_token, shop_domain, consumer_key, consumer_secret }) => {
      if ((platform as string) === "shopify" || (platform as string) === "tiktok_shop") {
        return { content: [{ type: "text" as const, text: `Use firestarter_connect_shopify or firestarter_connect_tiktok for ${platform} — this tool only covers bigcommerce/shopee/lazada/wix/woocommerce.` }] };
      }
      try {
        const conns = await apiRequest("GET", "/v1/connections");
        const existing = (conns.connections || []).find((c: any) => c.platform === platform);
        if (existing) {
          let text = `**${platform} store connected:** ${existing.shop_name || existing.shop_domain}\n`;
          text += `Status: ${existing.status}\n`;
          if (existing.last_synced_at) text += `Last catalog sync: ${existing.last_synced_at}\n`;
          const errSummary = summarizeConnectionError(existing.error_message);
          if (errSummary) text += `Error: ${errSummary}\n`;
          // Mirrors the #556 fix on firestarter_connect_shopify: a connection
          // stuck in 'error' either never finished a catalog sync (nothing
          // listed) or is only stale (prior sync's items are still listed) —
          // either way "products are listed and discoverable" alone was wrong.
          text += `\n${connectionListedLine(existing, "store")}`;
          if (existing.status === "error") {
            text += ` Run firestarter_sync_shopify with connection_id "${existing.id}" to retry. If it keeps failing, double-check the credentials (they may have expired or been revoked) and reconnect.`;
          }
          return { content: [{ type: "text" as const, text }] };
        }

        const credentialInstructions: Record<string, string> = {
          bigcommerce: "Go to your BigCommerce admin > Settings > API > API Accounts > Create API Account. Give it read-only access to Products and Orders. Copy the Access Token (as access_token) and use your store hash as shop_domain.",
          shopee: "Go to Shopee Open Platform > My Apps. Generate an access token (as access_token) and provide your shop id as shop_domain.",
          lazada: "Go to Lazada Open Platform > App Console. Generate an access token (as access_token) and provide your shop identifier as shop_domain.",
          wix: "Go to your Wix dashboard > Developer Tools > API Keys > Generate API Key with 'Wix Stores - Read Products' permission (as access_token), and your account id as shop_domain.",
          woocommerce: "Go to your WordPress admin > WooCommerce > Settings > Advanced > REST API > 'Add Key', set permissions to 'Read'. Provide the Consumer Key and Consumer Secret separately (consumer_key/consumer_secret, not access_token) and your store's domain WITHOUT `https://` (e.g. `mystore.com`) as shop_domain.",
        };

        if (platform === "woocommerce") {
          if (!consumer_key || !consumer_secret || !shop_domain) {
            return { content: [{ type: "text" as const, text: `**No WooCommerce store connected.**\n\n${credentialInstructions.woocommerce}` }] };
          }
          // Defensive: the adapter (catalog-sync/adapters.ts's woocommerceAdapter)
          // builds its request URL as `https://${shop_domain}/wp-json/...` — a
          // leading scheme here would produce "https://https://mystore.com/..."
          // and every sync request would fail. Strip one if a well-meaning agent
          // included it anyway despite the bare-domain instructions above.
          const wooDomain = shop_domain.replace(/^https?:\/\//i, "");
          const encoded = Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");
          await apiRequest("POST", "/v1/connections", { platform, access_token: encoded, shop_domain: wooDomain });
          return { content: [{ type: "text" as const, text: `**WooCommerce connected: ${wooDomain}**\nCatalog sync started - check results with firestarter_listings shortly.` }] };
        }

        if (!access_token || !shop_domain) {
          return { content: [{ type: "text" as const, text: `**No ${platform} store connected.**\n\n${credentialInstructions[platform]}` }] };
        }
        await apiRequest("POST", "/v1/connections", { platform, access_token, shop_domain });
        return { content: [{ type: "text" as const, text: `**${platform} connected: ${shop_domain}**\nCatalog sync started - check results with firestarter_listings shortly.` }] };
      } catch (err: any) {
        if (err?.code === "NO_SELLER_PROFILE") {
          return { content: [{ type: "text" as const, text: "The seller isn't registered on Firestarter yet. Call `firestarter_register_seller` with their business name first, then connect their store." }], isError: true };
        }
        if (err?.code === "ALREADY_CONNECTED") {
          return { content: [{ type: "text" as const, text: `A ${platform} store is already connected for this seller. Disconnect it from the dashboard before reconnecting.` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Error connecting ${platform}: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_sync_shopify
  // #556: the manual re-sync step the lifecycle was missing. connect_shopify only
  // re-checks status; this actually re-pulls the catalog (POST /v1/connections/:id/sync)
  // so store edits made after the initial connect show up on Firestarter.
  server.tool(
    "firestarter_sync_shopify",
    "Re-sync a connected store's catalog into Firestarter — pulls the latest products, prices, and inventory from Shopify (or another connected platform) so changes the seller made in their store show up on Firestarter. Use whenever the seller says they added/edited/removed products, prices look stale, a previous sync errored, or items aren't appearing. Requires an already-connected store (firestarter_connect_shopify creates the connection). Syncing runs in the background and returns immediately; the refreshed products appear in firestarter_listings once the sync completes, which can take a moment. Read-mostly: it imports/updates Firestarter listings from the store but never changes the seller's Shopify store. By default it syncs the seller's connected Shopify store; pass connection_id to target a specific connection when several platforms are linked.",
    {
      connection_id: z.string().optional().describe("Optional. The platform connection id (conn_...) to re-sync. Omit to sync the seller's Shopify store automatically — only needed to disambiguate when the seller has connected more than one platform."),
    },
    { title: "Sync Shopify Catalog", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
          // The connections list we just fetched already told us this — don't
          // let a retry-in-progress read as an all-clear when the connection
          // was already known broken (e.g. an expired/revoked token); a retry
          // with unchanged credentials will fail again the same way.
          conn.status === "error"
            ? `Note: this connection was in an error state before this retry${summarizeConnectionError(conn.error_message) ? ` (${summarizeConnectionError(conn.error_message)})` : ""} — if the credentials haven't changed, expect it to fail again the same way. Check firestarter_listings after; if it's still erroring, the seller likely needs to reconnect with fresh credentials.`
            : `Check the results with firestarter_listings once it finishes. If products still look wrong after a sync, the seller may need to reconnect the store from the Firestarter dashboard.`,
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

  // --- firestarter_catalog_search query hygiene -----------------------------
  // Agents relay buyer phrasing like "wireless earbuds under 50" verbatim.
  // The catalog's q matches TEXT only, so a price phrase left in the query can
  // only hurt recall while the buyer's actual price cap goes unenforced. Pull
  // "under/over/between $N" phrases OUT of the free text and into the
  // min_price/max_price filters (never overriding explicitly-passed args).
  const PRICE_NUM = "\\$?\\s*(\\d+(?:\\.\\d{1,2})?)";
  function extractPriceFilters(raw: string): { query: string; min?: number; max?: number } {
    let query = raw;
    let min: number | undefined;
    let max: number | undefined;
    const strip = (re: RegExp, assign: (a: number, b?: number) => void): void => {
      const m = query.match(re);
      if (!m || m.index == null) return;
      assign(parseFloat(m[1]), m[2] != null ? parseFloat(m[2]) : undefined);
      query = (query.slice(0, m.index) + " " + query.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim();
    };
    // Ranges first ("between $10 and $50", "$10-$50", "$10 to 50") so their
    // numbers aren't half-consumed by the single-bound patterns below.
    strip(new RegExp(`between\\s+${PRICE_NUM}\\s+and\\s+${PRICE_NUM}`, "i"), (a, b) => { min = a; max = b; });
    strip(/\$(\d+(?:\.\d{1,2})?)\s*(?:-|to)\s*\$?(\d+(?:\.\d{1,2})?)/, (a, b) => { min = a; max = b; });
    strip(new RegExp(`(?:under|below|less\\s+than|at\\s+most|up\\s+to|no\\s+more\\s+than|cheaper\\s+than|max(?:imum)?(?:\\s+of)?)\\s+${PRICE_NUM}`, "i"), (a) => { max = a; });
    strip(new RegExp(`(?:over|above|more\\s+than|at\\s+least|starting\\s+at|min(?:imum)?(?:\\s+of)?)\\s+${PRICE_NUM}`, "i"), (a) => { min = a; });
    if (min != null && max != null && min > max) [min, max] = [max, min];
    return { query, min, max };
  }

  // Head noun of a multi-word query, for the zero-result broadened retry.
  // English noun phrases are head-final ("red leather WALLET"), so the last
  // substantive word is the best single-term approximation of what the buyer
  // wants. Returns null for single-word queries (nothing to broaden to).
  function broadenTerm(q: string): string | null {
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^\d+$/.test(w));
    return words.length >= 2 ? words[words.length - 1] : null;
  }

  // Tool: firestarter_product — the buyer "zoom in" (phase 3).
  // GET /v1/listings/:id serves a PUBLIC cross-org projection for active live
  // listings: full gallery, attributes, and a curated seller-trust subset
  // including the rating aggregate and units sold — so this works against the
  // live API today. Individual review comments need a commerce endpoint that
  // does not exist yet; the aggregate is shown and comments are not promised.
  registerToolCompat(
    server,
    "firestarter_product",
    {
      description: "Show one product from the Firestarter catalog in full detail — all photos, description, attributes, price, buyability, and the seller's trust profile (rating, review count, units sold, time on platform). This is the buyer's ZOOM-IN after firestarter_catalog_search or firestarter_preview: pass the listing id (lst_..., also parsed from a firestarter.network/l/<id> share link). Read-only — to buy, pass the same listing_id to firestarter_execute; for a shipping quote first, use firestarter_shipping_estimate.",
      inputSchema: {
        listing_id: z.string().describe("The listing to show (lst_..., from catalog search, preview, or a share link)."),
      },
      annotations: { title: "View Product", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      // Declared at REGISTRATION, not just on the result: Claude Desktop honours
      // a result-level `_meta.ui`, but ChatGPT reads the tool descriptor, so the
      // widget never rendered there for this tool. registerAppTool mirrors it to
      // the legacy flat key for older hosts.
      //
      // widgetAccessible is what lets the detail view call this tool for
      // itself: ChatGPT refuses a widget-initiated tools/call without it, and
      // the view's description, seller and reviews would never arrive. It is
      // granted to this read-only tool alone — nothing that moves money is
      // reachable from a sandboxed iframe rendering third-party product data.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI }, "openai/widgetAccessible": true },
    },
    async ({ listing_id: rawId }: { listing_id: string }, extra?: { _meta?: unknown }) => {
      const listing_id = cleanListingId(rawId);
      try {
        const l = await apiRequest("GET", `/v1/listings/${listing_id}`);
        const name = sanitizeUntrusted(l.product_name) || "Untitled";
        const cur = l.currency;
        const lines: string[] = [`**${name}**`];
        const dr = displayRating(l);
        const starTxt = stars(dr.rating, dr.rating_count);
        const sold = Number(l.units_sold) > 0 ? `${l.units_sold} sold` : null;
        // The label is the whole point of the fallback: unlabeled seller stars
        // read as this product's, which is the misattribution product-first
        // ratings exist to prevent.
        const trustBits = [starTxt ? `${starTxt}${dr.is_seller_level ? " seller rating" : ""}` : null, sold].filter(Boolean).join(" · ");
        if (trustBits) lines.push(trustBits);
        lines.push(`${money(l.current_price, cur)}${l.condition ? ` · ${String(l.condition).replace(/_/g, " ")}` : ""}${l.category ? ` · ${sanitizeUntrusted(l.category, 60)}` : ""}`);
        if (l.inventory_qty != null) lines.push(l.inventory_qty > 0 ? `In stock: ${l.inventory_qty}` : "Out of stock");
        if (l.description) lines.push(`\n${sanitizeUntrusted(l.description, 600)}`);
        const attrs: string[] = [];
        if (l.brand) attrs.push(`Brand: ${sanitizeUntrusted(l.brand, 60)}`);
        if (Array.isArray(l.materials) && l.materials.length) attrs.push(`Materials: ${sanitizeUntrusted(l.materials.join(", "), 120)}`);
        const dims = [l.length_in, l.width_in, l.height_in].filter((v: unknown) => v != null);
        if (dims.length === 3) attrs.push(`Dimensions: ${dims.join(" x ")} in`);
        if (l.weight_oz != null) attrs.push(`Weight: ${l.weight_oz} oz`);
        if (l.country_of_origin) attrs.push(`Made in: ${l.country_of_origin}`);
        if (l.return_policy) attrs.push(`Returns: ${sanitizeUntrusted(l.return_policy, 120)}`);
        if (l.ship_time_days != null) attrs.push(`Dispatch: ${l.ship_time_days} day(s)`);
        if (attrs.length) lines.push(`\n${attrs.join("\n")}`);
        // Seller trust block — public curated subset only.
        const sellerBits = [
          l.seller_name ? `**Seller:** ${sanitizeUntrusted(l.seller_name, 80)}` : null,
          l.seller_verified ? "verified" : null,
          l.seller_since ? `on Firestarter since ${String(l.seller_since).slice(0, 10)}` : null,
          [l.seller_region, l.seller_country].filter(Boolean).join(", ") || null,
        ].filter(Boolean).join(" · ");
        if (sellerBits) lines.push(`\n${sellerBits}`);
        const gallery = (Array.isArray(l.images) ? l.images : []).filter((u: unknown) => typeof u === "string" && /^https?:\/\//i.test(String(u)));
        if (gallery.length > 0) {
          lines.push(`\nPhotos (${gallery.length}):`);
          for (const img of gallery.slice(0, 8)) lines.push(`  ${img}`);
        }
        // Video, when the listing has any. A bare URL rather than an embed:
        // the calling agent decides how to present it, and several hosts
        // already render a media URL as a player. Silent when there is none —
        // "0 videos" would be noise on the vast majority of listings.
        const vids = safeVideos(l.videos);
        if (vids.length > 0) lines.push("", ...videoLines(l.videos));
        // Review text. Buyer-authored free text bound for a CALLING agent's
        // context window — an agent we neither own nor instruct — so every
        // quote goes through sanitizeUntrusted, is capped so one review cannot
        // own the response, and is flattened to a single line. Only rating,
        // comment and date are read: the API never sends a buyer identity, and
        // this would not relay one if that ever changed upstream.
        const quotes = Array.isArray(l?.reviews?.top) ? l.reviews.top.slice(0, 3) : [];
        const reviewOut = quotes.map((r: any) => ({
          rating: Number(r?.rating) || 0,
          comment: sanitizeUntrusted(String(r?.comment ?? "").replace(/\s+/g, " "), 200),
          created_at: typeof r?.created_at === "string" ? r.created_at : null,
        })).filter((r: any) => r.comment);
        if (reviewOut.length > 0) {
          const n = Number(l?.reviews?.count) || reviewOut.length;
          lines.push(`\n**What buyers say** (${n} review${n === 1 ? "" : "s"})`);
          for (const r of reviewOut) {
            const stars0 = "\u2605".repeat(Math.max(1, Math.min(5, Math.round(r.rating))));
            lines.push(`- ${stars0} _"${r.comment}"_ — verified buyer`);
          }
        }
        const share = listingShareUrl(l);
        if (share) lines.push(`\nShare: ${mdUrlLink(share) ?? share}`);
        lines.push(`\nTo buy: \`firestarter_execute\` with listing_id \`${l.id}\`. Shipping quote first: \`firestarter_shipping_estimate\`.`);
        // The zoom-in is THE "show me this product" surface and was the only
        // image surface that never inlined: preview, catalog and listings all
        // call this, so a text-only host got bare URLs here and pictures
        // everywhere else. Capped by MAX_EMBED_IMAGES and the response budget.
        //
        // Except when the shopping widget is the caller: its detail view calls
        // this tool for the description, seller and review quotes a search row
        // never carries, and renders the photos itself from the urls above. The
        // base64 copies would be most of the 1MB budget spent on bytes that
        // view never displays. A host that drops the marker just pays for them.
        const productImages = isWidgetCall(extra?._meta) ? [] : await inlineImageBlocks(gallery);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }, ...productImages],
          structuredContent: {
            product: {
              id: l.id, title: l.product_name ?? null, description: l.description ?? null,
              price: l.current_price ?? null, currency: cur ?? "USD",
              images: gallery, videos: vids, share_url: share ?? null,
              reviews: { count: Number(l?.reviews?.count) || 0, top: reviewOut },
              seller: l.seller_name ?? null, seller_verified: l.seller_verified === true,
              rating: dr.rating,
              rating_count: dr.rating_count,
              rating_is_seller_level: dr.is_seller_level,
              product_rating: l.product_rating != null ? Number(l.product_rating) : null,
              product_rating_count: Number(l.product_rating_count) || 0,
              seller_rating: l.seller_rating != null ? Number(l.seller_rating) : null,
              seller_rating_count: Number(l.seller_rating_count) || 0,
              units_sold: Number(l.units_sold) || 0,
              in_stock: l.inventory_qty == null || l.inventory_qty > 0,
            },
          },
          _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
        };
      } catch (err: any) {
        const msg = toErrorMessage(err);
        if (err instanceof ApiError && (err.code === "NOT_FOUND" || err.status === 404)) {
          return { content: [{ type: "text" as const, text: `No active listing matched \`${listing_id}\`. It may be a draft, out of stock, sandbox-only, or the id may be wrong — find products with firestarter_catalog_search.` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Error loading product: ${msg}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_catalog_search
  registerToolCompat(
    server,
    "firestarter_catalog_search",
    {
      description: "Search the Firestarter NETWORK catalog — products listed for sale by ALL sellers — without starting a purchase. This is the BUYER-facing browse tool: use it to see what's available before buying, compare prices, or check whether the network carries an item. Different from firestarter_listings, which only shows YOUR OWN seller listings. Each result includes a listing id (lst_...) you can pass to firestarter_execute (as listing_id) to buy it, the share link, and a `buyable` flag — buyable means it can be purchased now; browse-only means it cannot be checked out right now — the seller is not accepting new orders, or the store has not been claimed by its merchant (the share link still shows the item). Results lead with buyable, cheapest first. Pass `country` to filter for items that ship to the buyer's country. test/live follows the API key's environment. Returns up to `limit` matches (default 20, max 50); when more exist the result notes it — a narrower query or higher `limit` surfaces the rest. Read-only: never charges or changes anything.",
      inputSchema: {
        query: z.string().optional().describe("Free-text product search of product name, description, and category — matches best on real product nouns, e.g. 'leather conditioner', 'wireless earbuds'. Price constraints belong in max_price rather than the query ('under $50' is a filter, not a search term), and filler words like 'cheap' or 'best' add no signal; price phrases that do slip into the query are auto-extracted into the price filters."),
        category: z.string().optional().describe("Filter by category, e.g. 'Rings', 'Accessories', 'Stickers'."),
        country: z.string().optional().describe("ISO 3166-1 alpha-2 country code (e.g. 'TH', 'US', 'GB'). Filters for listings that ship to this country. Pass the buyer's country to see locally-deliverable options."),
        min_price: z.number().optional().describe("Minimum price in the listing currency (inclusive)."),
        max_price: z.number().optional().describe("Maximum price in the listing currency (inclusive)."),
        buyable_only: z.boolean().optional().describe("If true, return only listings that can be purchased now (seller checkout enabled). Default false (includes browse-only listings, which are clearly tagged)."),
        limit: z.number().optional().describe("Max results to return, 1-50. Default 20."),
      },
      outputSchema: catalogOutputShape,
      annotations: { title: "Search Catalog", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      // MCP Apps: render catalog hits as the same inline product grid
      // firestarter_preview uses (photos, price, buyability). Additive — hosts
      // without app support fall back to the text + image-block result below.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
    },
    async ({ query, category, country, min_price, max_price, buyable_only, limit }: {
      query?: string; category?: string; country?: string; min_price?: number; max_price?: number; buyable_only?: boolean; limit?: number;
    }) => {
      try {
        // Pull price phrases out of the free text into the price filters
        // (explicit min_price/max_price args always win).
        let q = query;
        let minP = min_price;
        let maxP = max_price;
        if (q) {
          const extracted = extractPriceFilters(q);
          q = extracted.query;
          if (typeof minP !== "number" && extracted.min != null) minP = extracted.min;
          if (typeof maxP !== "number" && extracted.max != null) maxP = extracted.max;
        }

        const buildParams = (searchText: string | undefined): URLSearchParams => {
          const params = new URLSearchParams();
          if (searchText) params.set("q", searchText);
          if (category) params.set("category", category);
          if (country) params.set("country", country);
          if (typeof minP === "number") params.set("min_price", String(minP));
          if (typeof maxP === "number") params.set("max_price", String(maxP));
          if (buyable_only) params.set("buyable_only", "true");
          if (typeof limit === "number") params.set("limit", String(limit));
          return params;
        };

        let data = await apiRequest("GET", `/v1/listings/catalog?${buildParams(q).toString()}`);
        let listings: any[] = data.listings || [];

        // Zero-result broadened retry (one extra call, at most): the catalog
        // matches text lexically, so a specific multi-word query can miss
        // items a single head noun finds ("red leather wallet" -> "wallet").
        // Retrying here saves the agent a whole round-trip through the buyer.
        let broadenedTo: string | null = null;
        if (listings.length === 0 && q) {
          const term = broadenTerm(q);
          if (term) {
            const retry = await apiRequest("GET", `/v1/listings/catalog?${buildParams(term).toString()}`);
            const retryListings: any[] = retry.listings || [];
            if (retryListings.length > 0) {
              data = retry;
              listings = retryListings;
              broadenedTo = term;
            }
          }
        }

        if (listings.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No catalog listings matched${q && q !== query ? ` for "${q}"` : ""}. Try a broader search term (a single product noun), remove price/category filters, or drop \`buyable_only\`.`,
            }],
            // An outputSchema makes structuredContent mandatory on every result
            // that is not isError — an empty grid, not a validation failure.
            structuredContent: toCatalogStructured(data, [], null),
          };
        }

        const buyableCount = listings.filter((l) => l.buyable).length;
        // The buyer's community, when they're in one. Named on its own line so
        // the agent can attribute a pick ("Analog picks this") rather than
        // showing an unexplained star.
        const communityName: string | null =
          typeof data.query?.community?.name === "string" ? data.query.community.name : null;
        const pickCount = listings.filter((l) => l.picked_by_community).length;
        const lines = [
          `**Firestarter catalog** — ${listings.length} result${listings.length === 1 ? "" : "s"} (${data.query?.environment || "live"} mode, ${buyableCount} buyable now)${data.has_more ? " · more available, narrow the search or raise `limit`" : ""}`,
        ];
        if (broadenedTo) {
          lines.push(`No exact matches for "${q}" — showing matches for **${broadenedTo}** instead.`);
        }
        if (q !== query) {
          const applied = [
            typeof min_price !== "number" && typeof minP === "number" ? `min $${minP}` : null,
            typeof max_price !== "number" && typeof maxP === "number" ? `max $${maxP}` : null,
          ].filter(Boolean).join(", ");
          if (applied) lines.push(`Price phrase moved out of the search text and applied as a filter (${applied}).`);
        }
        if (communityName && pickCount > 0) {
          lines.push(`★ = picked by **${sanitizeUntrusted(communityName, 120)}**, the community you're in (${pickCount} here).`);
        }
        lines.push("");
        for (const l of listings) {
          const price = `${l.currency || "USD"} ${Number(l.current_price).toFixed(2)}`;
          const tag = l.buyable ? "✅ buyable" : "👁 browse-only";
          // #611: surface the first product image URL on its own line so chat
          // clients auto-unfurl a preview and agents have a fetchable, CORS-open
          // image URL (the network image endpoint) instead of guessing a link.
          const img0 = Array.isArray(l.images) && typeof l.images[0] === "string" && /^https?:\/\//i.test(l.images[0]) ? l.images[0] : null;
          // The curator's note is the whole point of a pick — a bare badge says
          // "someone chose this", the note says why, which is what a buyer
          // actually weighs. Rendered on its own line, quoted, when present.
          const picked = l.picked_by_community === true;
          const note = picked && typeof l.pick_note === "string" && l.pick_note.trim() ? l.pick_note.trim() : null;
          // #catalog-share-null (2026-08-10): share_url is null for a test-mode
          // listing (publicShareUrl in services/listing-create.ts) — every
          // catalog_search result rendered "· null" in sandbox instead of a
          // link or an explanation. Mirrors firestarter_listings' own
          // sandbox-only wording.
          // ONE clickable thing per row, on the product name itself, instead of
          // a bare share URL on the id line: a 50-row result with a link per row
          // plus a separate URL per row is a wall of blue. The address stays in
          // the link target, so an agent relaying it still has the bare URL.
          const name = sanitizeUntrusted(l.product_name);
          const nameCell = mdLink(name, l.share_url) ?? name;
          // Phase 2 wiring: renders the moment the catalog API starts returning
          // rating aggregates; absent fields render nothing (never "0 reviews").
          const cdr = displayRating(l);
          const starTxt = stars(cdr.rating ?? l.rating, cdr.rating_count || l.rating_count);
          const shareText = l.share_url ? null : "sandbox-only, no public link yet";
          lines.push(
            `- ${picked ? "★ " : ""}**${nameCell}** — ${price} [${tag}]${l.category ? ` · ${sanitizeUntrusted(l.category, 80)}` : ""}` +
            `${note ? `\n  _"${sanitizeUntrusted(note)}"_${communityName ? ` — ${sanitizeUntrusted(communityName, 120)}` : ""}` : ""}` +
            `${starTxt ? `\n  ${starTxt}` : ""}\n  id: \`${l.id}\`${shareText ? ` · ${shareText}` : ""}${img0 ? `\n  ${img0}` : ""}`,
          );
        }
        lines.push(
          "\nTo buy a **buyable** item, call `firestarter_execute` with `listing_id` set to its id. **Browse-only** items can't be checked out here — share the link so the buyer can view them instead.",
        );
        // Inline each listing's first photo so MCP clients render them; the URLs
        // also remain in the text above for chat clients that unfurl links.
        const catalogImages = await inlineImageBlocks(listings.map((l) => (Array.isArray(l.images) ? l.images[0] : null)));
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }, ...catalogImages],
          // Drives the shopping-results MCP App grid (its client reads
          // structuredContent.listings); also a typed contract for agents.
          structuredContent: toCatalogStructured(data, listings, broadenedTo),
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error searching catalog: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_listings
  registerToolCompat(
    server,
    "firestarter_listings",
    {
      description: "View your own product listings (seller side): name, current price, inventory, status, demand, and live share link when available. Pass listing_id for full detail on one listing; omit it to list every listing you have, including drafts that still need to be activated. Use this when a seller wants to see, verify, or share what they have listed. Active live listings have a public share link; sandbox and draft listings do not.",
      inputSchema: {
        listing_id: z.string().optional().describe("Specific listing ID (lst_...) for full detail. Omit to list every listing you have, drafts included."),
      },
      outputSchema: sellerListingsOutputShape,
      annotations: { title: "List My Listings", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      // MCP Apps: render the seller's own products as the same inline grid the
      // buyer-facing tools use. Additive — hosts without app support fall back
      // to the text + image-block result below.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
    },
    async ({ listing_id: rawListingId }: { listing_id?: string }) => {
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
          const attrBits: string[] = [];
          if (l.brand) attrBits.push(`brand ${l.brand}`);
          if (l.sku) attrBits.push(`sku ${l.sku}`);
          if (l.condition) attrBits.push(l.condition.replace(/_/g, " "));
          if (attrBits.length) text += `${attrBits.join(", ")}\n`;
          const dims = [l.length_in, l.width_in, l.height_in].filter((v) => v != null);
          if (dims.length === 3) text += `Dimensions: ${dims.join(" x ")} in\n`;
          if (l.weight_oz != null) text += `Weight: ${l.weight_oz} oz\n`;
          if (l.country_of_origin) text += `Country of origin: ${l.country_of_origin}\n`;
          if (Array.isArray(l.materials) && l.materials.length) text += `Materials: ${l.materials.join(", ")}\n`;
          if (Array.isArray(l.tags) && l.tags.length) text += `Tags: ${l.tags.join(", ")}\n`;
          if (Array.isArray(l.variants) && l.variants.length) {
            text += `Variants (${l.variants.length}): ${l.variants.map((v: any) => v.label || v.sku || "?").join(", ")}\n`;
          }
          if (l.return_policy) text += `Return policy: ${l.return_policy}\n`;
          if (l.ship_time_days != null) text += `Dispatch time: ${l.ship_time_days} day(s)\n`;
          if (l.verification_status && l.verification_status !== "verified") {
            text += `Verification: ${l.verification_status}${l.verification_code ? ` (code ${l.verification_code})` : ""}${l.verification_reason ? ` — ${l.verification_reason}` : ""}\n`;
          }
          if (Array.isArray(l.images) && l.images.length > 0) {
            if (l.images.length === 1) {
              text += `Image: ${l.images[0]}\n`;
            } else {
              text += `Images (${l.images.length}):\n`;
              for (const img of l.images) text += `  - ${img}\n`;
            }
          }
          if (l.demand_score != null) text += `Demand score: ${l.demand_score}\n`;
          if (l.created_at) text += `Listed: ${formatBuyerDate(l.created_at) || l.created_at}\n`;
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
          return {
            content: detailBlocks,
            // A one-card grid for the detail view. An outputSchema makes
            // structuredContent mandatory on every result that is not isError.
            structuredContent: toSellerListingsStructured([l]),
          };
        }
        const data = await apiRequest("GET", "/v1/listings");
        const listings = data.listings || [];
        if (listings.length === 0) {
          return {
            content: [{ type: "text" as const, text: "You have no active listings. Use `firestarter_list` to create one." }],
            structuredContent: toSellerListingsStructured([]),
          };
        }
        const utcToday = new Date().toISOString().slice(0, 10);
        const listedTodayUtc = listings.filter((l: any) => {
          const ts = typeof l?.created_at === "string" ? l.created_at : "";
          return ts.slice(0, 10) === utcToday;
        }).length;

        let text = `**Your listings (${listings.length})**\n`;
        text += `Listed today (UTC): ${listedTodayUtc}\n\n`;
        // Phase 4: the inventory answer IS a table — name, status, price, qty,
        // listed date (#527 kept), id — with share links gathered below so the
        // table stays scannable. Sandbox listings have no public link.
        text += mdTable(
          ["Listing", "Status", "Price", "Qty", "Listed", "ID"],
          listings.map((l: any) => [
            String(l.product_name ?? ""),
            String(l.status ?? ""),
            money(l.current_price, l.currency),
            l.inventory_qty != null ? String(l.inventory_qty) : "∞",
            String(l.created_at ?? "").slice(0, 10) || "—",
            `\`${l.id}\``,
          ]),
          { moreHint: "pass a listing ID for full detail" },
        ) + "\n";
        const shareLines = listings.slice(0, 20)
          .map((l: any) => ({ l, url: listingShareUrl(l) }))
          .filter((x: any) => x.url)
          .map((x: any) => `- ${mdUrlLink(x.url) ?? x.url}`);
        if (shareLines.length > 0) text += `\nShare links:\n${shareLines.join("\n")}\n`;
        text += `\nPass a listing ID for full detail. Active live listings include a public share link; sandbox listings remain accessible only through test-mode tools.`;
        // #611 follow-up: thumbnail the first photos so "show my products" has
        // visuals in the list view too (the detail path already embeds them).
        // inlineImageBlocks caps at MAX_EMBED_IMAGES and enforces the response
        // image budget, so a long list can never blow the 1MB tool-result cap.
        const listImages = await inlineImageBlocks(listings.map((l: any) => (Array.isArray(l.images) ? l.images[0] : null)));
        return {
          content: [{ type: "text" as const, text }, ...listImages],
          // Drives the shopping-results grid; also a typed contract for agents.
          structuredContent: toSellerListingsStructured(listings),
        };
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
    { title: "View Demand Signals", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ listing_id: rawListingId, category }) => {
      const listing_id = rawListingId ? cleanListingId(rawListingId) : undefined;
      try {
        let data: any;
        if (listing_id) {
          data = await apiRequest("GET", `/v1/listings/${listing_id}/demand`);
        } else {
          data = await apiRequest("GET", "/v1/demand/feed?hours=24");
        }
        // /v1/demand/feed returns { feed: [...] }; the single-listing endpoint
        // returns a bare object (no listing-array shape at all — wrap it in one).
        let items = data.feed || data.signals || data.demand || [data];
        if (!listing_id && category && Array.isArray(items)) {
          const needle = category.toLowerCase();
          items = items.filter((item: any) => typeof item?.category === "string" && item.category.toLowerCase().includes(needle));
        }
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
        } else if (items && typeof items === "object") {
          // The per-listing shape is a small metrics object — say it in words,
          // not JSON (the only tool output a seller saw as a raw dump).
          const m = items as Record<string, unknown>;
          const row = (label: string, v: unknown) => { if (v != null) text += `- ${label}: ${v}\n`; };
          row("Searches (24h)", m.searches_24h);
          row("Purchase attempts (24h)", m.executions_24h);
          row("Active monitors watching (7d)", m.active_monitors_7d);
          if (typeof m.avg_price_point === "number") text += `- Average buyer price point: $${(m.avg_price_point as number).toFixed(2)}\n`;
          if (m.searches_24h === 0 && m.executions_24h === 0 && m.active_monitors_7d === 0) {
            text += "\nNo buyer activity in the last 24 hours for this listing.";
          }
        } else {
          text += String(items);
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error checking demand: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // ── Vouchers ──────────────────────────────────────────────────────────────
  //
  // Sellers can run every other part of their store through an agent — list,
  // reprice, ship, read analytics — but not discounts, which were reachable
  // only from the dashboard. These close that gap.
  //
  // Synonyms live in the descriptions ("voucher, coupon, promo code, discount
  // code") on purpose: tool selection is semantic, and a seller may say any of
  // them. The schema and API say "voucher" so there is one canonical name.

  // Tool: firestarter_create_voucher
  server.tool(
    "firestarter_create_voucher",
    "Create a voucher (also called a coupon, promo code, or discount code) that buyers can apply to your listings. Requires a SELLER account with at least one listing — a community-market owner who only recommends other sellers' products has nothing of their own to discount; tiered access (firestarter_set_market_tiers) is the member-reward mechanism for that case. Supports percentage off, a fixed amount off, or free shipping, with an optional start/end date, usage cap, per-buyer limit, minimum order value, and scoping to a single listing. YOU FUND THE DISCOUNT: it comes out of your proceeds, and the platform fee is charged on the discounted total. Dates accept natural language — 'next Friday', 'in 2 weeks' — as well as ISO dates. A discount above 50% requires confirm_deep_discount — a flag attesting that the seller has confirmed that unusually deep number. If the voucher would leave the seller's cheapest orders below the payable minimum the call is rejected with an explanation rather than creating something whose orders would fail at payment.",
    {
      code: z.string().describe("The code buyers type, e.g. 'SUMMER20'. 2-64 characters: letters, numbers, dashes or underscores. Case-insensitive; stored uppercase."),
      discount_percent: z.number().int().min(1).max(100).optional().describe("Percent off, 1-100. Use this OR discount_amount_cents, not both."),
      discount_amount_cents: z.number().int().min(1).optional().describe("Fixed amount off in cents (e.g. 500 = $5 off). Use instead of discount_percent."),
      free_shipping: z.boolean().optional().describe("Set true for a free-shipping voucher instead of a discount off the item price."),
      max_uses: z.number().int().min(1).optional().describe("Total redemptions allowed across all buyers. Omit for unlimited."),
      per_buyer_limit: z.number().int().min(1).optional().describe("How many times one buyer may use it. Omit for unlimited."),
      min_order_cents: z.number().int().min(0).optional().describe("Minimum order subtotal in cents before the voucher applies."),
      listing_id: z.string().optional().describe("Restrict the voucher to one of your listings (lst_...). Omit to apply across all of them."),
      starts_at: z.string().optional().describe("When it becomes usable. Natural language ('tomorrow') or ISO. Omit to start immediately."),
      expires_at: z.string().optional().describe("When it stops working. Natural language ('next Friday') or ISO. Omit for no expiry."),
      discoverable: z.boolean().optional().describe("Default true: buyer agents can find and auto-apply it. Set false for a targeted code usable only by someone you give it to."),
      confirm_deep_discount: z.boolean().optional().describe("Required to create a discount above 50%. Only pass it after the seller has confirmed that exact number."),
    },
    // The seller funds this discount out of their own proceeds, at up to 100%.
    { title: "Create Voucher", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ code, discount_percent, discount_amount_cents, free_shipping, ...rest }) => {
      try {
        const body: any = { code, ...rest };
        if (free_shipping) body.discount_type = "free_shipping";
        else if (discount_amount_cents !== undefined) {
          body.discount_type = "fixed";
          body.discount_amount_cents = discount_amount_cents;
        } else {
          body.discount_type = "percent";
          body.discount_percent = discount_percent;
        }

        const { voucher } = await apiRequest("POST", "/v1/sellers/vouchers", body);
        let text = `**Voucher ${voucher.code} created** (id \`${voucher.id}\`)\n`;
        text += `${describeVoucherValue(voucher)}\n`;
        if (voucher.listing_id) text += `Applies to listing ${voucher.listing_id} only\n`;
        if (voucher.min_order_cents) text += `Minimum order: $${(voucher.min_order_cents / 100).toFixed(2)}\n`;
        if (voucher.max_uses) text += `Limited to ${voucher.max_uses} uses\n`;
        if (voucher.expires_at) text += `Expires ${new Date(voucher.expires_at).toUTCString()}\n`;
        if (voucher.discoverable === false) text += `Targeted: buyer agents won't surface it automatically.\n`;
        text += `\nYou fund this discount — it comes out of your proceeds.`;
        // The id is the handle firestarter_update_voucher needs to pause, resume,
        // or adjust this later — surface it here so managing it needs no lookup.
        text += `\nTo pause, resume, or adjust it later, call firestarter_update_voucher with voucher_id \`${voucher.id}\`.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        if (err instanceof ApiError && err.code === "NO_SELLER") {
          return { content: [{ type: "text" as const, text: "Vouchers are a seller tool: they discount your OWN listings and come out of your proceeds, so this account needs to be a seller with at least one product first. List one with firestarter_create_listing, then create the voucher. (A community market that only recommends other sellers' products has nothing of its own to discount — reward members with tiered early access via firestarter_set_market_tiers / firestarter_set_market_picks instead.)" }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Could not create the voucher: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_vouchers
  server.tool(
    "firestarter_vouchers",
    "List your vouchers (coupons / promo codes / discount codes) with their status and what each one has cost you so far. Status is one of active, scheduled (start date not reached), expired, exhausted (hit its usage cap), or paused. Use this to answer 'what discounts am I running?' or 'how is SUMMER20 doing?'.",
    {},
    { title: "Vouchers", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const { vouchers } = await apiRequest("GET", "/v1/sellers/vouchers");
        if (!vouchers?.length) {
          return { content: [{ type: "text" as const, text: "You have no vouchers yet. Create one with firestarter_create_voucher." }] };
        }
        let text = `**Your vouchers** (${vouchers.length})\n\n`;
        for (const v of vouchers) {
          text += `- **${v.code}** — ${describeVoucherValue(v)} · ${v.state}\n`;
          const used = v.max_uses ? `${v.redemption_count}/${v.max_uses} used` : `${v.redemption_count} used`;
          text += `  ${used} · you've funded $${((v.total_discount_funded_cents || 0) / 100).toFixed(2)}\n`;
          if (v.expires_at) text += `  expires ${new Date(v.expires_at).toUTCString()}\n`;
          // The id is what firestarter_update_voucher needs to pause/resume/adjust
          // this row; the code alone won't resolve there. Keep it human-quiet but
          // present so the management flow is reachable without a separate lookup.
          text += `  id: \`${v.id}\` (use with firestarter_update_voucher)\n`;
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Could not list vouchers: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_update_voucher
  server.tool(
    "firestarter_update_voucher",
    "Pause, resume, extend, or adjust the limits on an existing voucher. Pausing (active=false) stops it being redeemed without deleting it, so its history is kept. The code and the discount VALUE cannot be changed — buyers may already hold the code, and repricing an offer someone was given is a different voucher — the supported path is pausing this one and creating another.",
    {
      voucher_id: z.string().describe("The voucher id (promo_...) from firestarter_vouchers."),
      active: z.boolean().optional().describe("false pauses it, true resumes it."),
      discoverable: z.boolean().optional().describe("Whether buyer agents may surface and auto-apply it."),
      expires_at: z.string().optional().describe("New expiry. Natural language ('next Friday') or ISO."),
      max_uses: z.number().int().min(1).optional().describe("New total redemption cap."),
      per_buyer_limit: z.number().int().min(1).optional().describe("New per-buyer cap."),
      min_order_cents: z.number().int().min(0).optional().describe("New minimum order subtotal in cents."),
    },
    { title: "Update Voucher", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ voucher_id, ...patch }) => {
      try {
        if (Object.values(patch).every((v) => v === undefined)) {
          return { content: [{ type: "text" as const, text: "No changes given. Specify at least one field to update." }], isError: true };
        }
        const { voucher } = await apiRequest("PATCH", `/v1/sellers/vouchers/${voucher_id}`, patch);
        return {
          content: [{
            type: "text" as const,
            text: `**Voucher ${voucher.code} updated** — ${describeVoucherValue(voucher)} · ${voucher.active ? "active" : "paused"}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Could not update the voucher: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_reprice
  server.tool(
    "firestarter_reprice",
    "Adjust pricing or rules for an existing listing. Update base price, floor/ceiling limits, dynamic pricing settings, or pricing rules. Shipping is always estimated live from a delivery service provider and can no longer be set per-listing. Repricing re-fires the possession-verification gate whenever the listing would END UP at or above $500, or is in a luxury category at ANY price - so it can trip on a price CUT too (e.g. a watch dropped from $40 to $30), and it applies to paused and out-of-stock listings, not just live ones. When it trips, the new price is saved but the listing is moved back to draft and stops being buyable until the seller submits a photo via firestarter_verify; the tool output states this explicitly whenever it happens, so such a response is a conditional success, not a plain one.",
    {
      listing_id: z.string().describe("The listing ID to reprice"),
      base_price: z.number().optional().describe("New base price in USD"),
      floor_price: z.number().optional().describe("New floor price"),
      ceiling_price: z.number().optional().describe("New ceiling price"),
      dynamic_pricing: z.boolean().optional().describe("Enable/disable dynamic pricing"),
      shipping: z.number().optional().describe("Deprecated and ignored — shipping is always estimated live from a delivery service provider based on the buyer's destination. Accepted for backward compatibility only."),
    },
    // destructiveHint: a reprice can now take a live listing OFF the market
      // (the possession re-gate demotes it to draft), which is exactly what this
      // flag is for — a client that auto-approves non-destructive tools must not
      // run this unattended.
      { title: "Change Listing Price", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async ({ listing_id: rawListingId, base_price, floor_price, ceiling_price, dynamic_pricing, shipping }) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        const body: any = {};
        if (base_price !== undefined) body.base_price = base_price;
        if (floor_price !== undefined) body.floor_price = floor_price;
        if (ceiling_price !== undefined) body.ceiling_price = ceiling_price;
        if (dynamic_pricing !== undefined) body.dynamic_pricing = dynamic_pricing;
        // `shipping` is deprecated/ignored (always estimated live) — not forwarded.
        void shipping;
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "No pricing changes provided. Specify at least one field to update." }], isError: true };
        }
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, body, listingWriteTimeoutMs(body));
        let text = `**Listing ${listing_id} updated**\n`;
        if (listing.base_price !== undefined) text += `Base price: $${listing.base_price}\n`;
        if (listing.floor_price != null) text += `Floor: $${listing.floor_price}\n`;
        if (listing.ceiling_price != null) text += `Ceiling: $${listing.ceiling_price}\n`;
        if (listing.dynamic_pricing !== undefined) text += `Dynamic pricing: ${listing.dynamic_pricing ? "enabled" : "disabled"}\n`;
        // Show what a buyer actually pays, not just the input this call
        // changed — base_price alone can silently diverge from it. Off, the
        // route snaps current_price to base_price on this same PATCH (they'll
        // match). On, a pricing worker owns current_price and this base_price
        // change does NOT move it, which reads as a no-op if only base_price
        // is shown (QA report, 2026-08-10 — "reprice reports success but the
        // buyer-facing price never moves").
        if (listing.current_price !== undefined) {
          // "Buyer-facing price right now" on a listing no buyer can see reads
          // as "it is on sale at this price" (2026-08-19 sandbox run, on a
          // draft). Only an active listing has a buyer-facing price.
          const live = listing.status === undefined || listing.status === "active";
          text += live
            ? `Buyer-facing price right now: $${listing.current_price}\n`
            : `Price if it goes live: $${listing.current_price} — this listing is ${listing.status}, so no buyer can see or buy it right now.\n`;
          if (listing.dynamic_pricing && base_price !== undefined && listing.current_price !== base_price) {
            text += `Note: dynamic pricing is ON, so the buyer-facing price is set by the pricing engine and did NOT move to match the new base price. Disable dynamic pricing to make base_price the live price.\n`;
          }
        }
        text += `Shipping: estimated at checkout by the delivery provider, based on the buyer's destination\n`;
        // commerce#768: a reprice past the possession-verification bar succeeds
        // AND takes the listing offline. Never report only the first half.
        text += regateNoticeText(listing);
        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error repricing: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_update_listing
  registerToolCompat(
    server,
    "firestarter_update_listing",
    {
      description:
        "Update a listing's product details — name, description, category, inventory, status, brand, condition, sku, return policy, dispatch time, country of origin, physical dimensions/weight, materials, tags, or variants. Use this to rename a product, change its description, update stock levels, pause/reactivate a listing, or fill in/correct any of those detail fields. Also activates imported drafts (status 'active') - drafts need a positive price and at least one photo. High-value (>= $500) and luxury-category drafts additionally require a possession-verification photo: activation returns the instructions and an FS-XXXX code for the seller, and firestarter_verify submits the seller's photo. For pricing changes, use firestarter_reprice instead.",
      inputSchema: {
        listing_id: z.string().describe("The listing ID to update"),
      product_name: z.string().optional().describe("New product name/title"),
      description: z.string().optional().describe("New product description"),
      category: z.string().optional().describe("New category (e.g. 'sports/tennis')"),
      inventory_qty: z.number().optional().describe("Updated inventory quantity"),
      status: z.enum(["active", "paused", "out_of_stock"]).optional().describe("New listing status"),
      image_urls: z.array(z.string()).optional().describe("Replace the listing's photos with these public image URLs (replaces the WHOLE gallery — include existing photos to keep them). For a photo the seller ATTACHED IN THE CHAT, call firestarter_upload_image with NO image and this listing_id instead: a drop zone appears and the original file attaches losslessly. Never rebuild an attachment as a base64 data-URI, and never ask the seller to re-send a photo already in the conversation."),
      video_urls: z.array(z.string()).optional().describe("Product video URLs (MP4 or WebM, up to 25 MB and about 60 seconds each, max 3). The server fetches and re-hosts each one, so pass any public https URL — there is no separate upload step and no base64 form: a 25 MB video does not survive being emitted as a tool argument. Omit to leave existing videos untouched; pass an empty array to remove them. Videos are shown alongside the photos on the listing page and the share page."),
      fulfillment_mode: z.enum(["platform", "seller_managed"]).nullable().optional().describe("How orders for this listing get shipped. 'seller_managed' = NO platform label is ever bought: each paid order holds in awaiting_shipment until the seller ships it with their own carrier and enters tracking via firestarter_ship_order. 'platform' = the platform always books the carrier label. Pass null to clear back to auto (platform label when a carrier-ratable ship-from exists, otherwise seller-managed)."),
      allow_imageless: z.boolean().optional().describe("Override the NEEDS_IMAGE activation gate and let this listing go live with no photo. Only pass true if the seller explicitly can't provide one right now."),
      ...listingDetailFields,
      },
      annotations: { title: "Update Listing", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // MCP Apps: renders the listing card (or the drop zone, when the update
      // leaves a draft still photoless). widgetAccessible lets the drop zone's
      // own attach/activate calls through on hosts that gate widget calls.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI }, "openai/widgetAccessible": true },
    },
    async ({ listing_id: rawListingId, product_name, description, category, inventory_qty, status, image_urls, video_urls, fulfillment_mode, allow_imageless, ...details }: any) => {
      const listing_id = cleanListingId(rawListingId);
      try {
        const body: any = {};
        if (product_name !== undefined) body.product_name = product_name;
        if (description !== undefined) body.description = description;
        if (category !== undefined) body.category = category;
        if (inventory_qty !== undefined) body.inventory_qty = inventory_qty;
        if (status !== undefined) body.status = status;
        if (image_urls !== undefined) body.images = image_urls;
        // undefined vs [] is load-bearing on the API: absent leaves the column
        // alone, empty removes the videos. Forward the distinction, do not
        // collapse it with a truthiness check.
        if (video_urls !== undefined) body.video_urls = video_urls;
        if (fulfillment_mode !== undefined) body.fulfillment_mode = fulfillment_mode;
        if (allow_imageless !== undefined) body.allow_imageless = allow_imageless;
        for (const [key, value] of Object.entries(details)) {
          if (value !== undefined) body[key] = value;
        }
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "No updates provided. Specify at least one field to change." }], isError: true };
        }
        const listing = await apiRequest("PATCH", `/v1/listings/${listing_id}`, body, listingWriteTimeoutMs(body));
        let text = `**Listing ${listing_id} updated**\n`;
        if (listing.product_name) text += `Name: ${listing.product_name}\n`;
        if (listing.description) text += `Description: ${listing.description.slice(0, 100)}${listing.description.length > 100 ? "..." : ""}\n`;
        if (listing.category) text += `Category: ${listing.category}\n`;
        if (listing.inventory_qty !== undefined) text += `Inventory: ${listing.inventory_qty}\n`;
        if (listing.status) text += `Status: ${listing.status}\n`;
        // An edit replaces the gallery wholesale, so a refused photo here can
        // mean the seller ended up with FEWER photos than they started with
        // (commerce#775). Never report that as a clean update.
        text += rejectedPhotosText(listing);
        // commerce#858/7: stock written on a held listing answers 200. Without
        // this the seller thinks they are back on sale.
        text += blockedRestockText(listing);
        // commerce#768: a category change can trip the possession gate on a
        // live listing, which succeeds AND takes the listing offline.
        text += regateNoticeText(listing);
        // Widget payload: the listing card — plus the drop zone when the
        // update leaves the gallery empty, so "remove the photos" or an edit
        // to a photoless draft keeps the one-drop path in reach.
        const structured: Record<string, unknown> = { listing: listingSummaryStructured(listing) };
        if (!(Array.isArray(listing?.images) && listing.images.length)) {
          structured.upload_request = {
            listing_id,
            product_name: listing?.product_name,
            existing_image_urls: [],
            activate: shouldActivateAfterPhoto(listing),
          };
          // Same STOP phrasing as firestarter_list: the model cannot see the
          // widget, so any conditional fallback would fire immediately and
          // open a duplicate drop zone.
          text += `\nThis listing has no photo — this reply already displays a photo DROP ZONE on hosts that render widgets. Tell the seller to drop the photo(s) onto it, do NOT call firestarter_upload_image now (that would duplicate the zone), and END YOUR TURN. A \`[photo-upload widget]\` note will report the result.`;
        }
        return { content: [{ type: "text" as const, text }], structuredContent: structured };
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
    { title: "Set Shipping Policy", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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

  // Ship-from locations (#audit: was JWT/dashboard-only, yet the PRIMARY
  // location is what the quote engine resolves as the rate-shop origin — a
  // wrong or missing one silently mis-prices every shipping quote. One render
  // helper shared by all three tools so a location always reads the same.
  const renderShipFromLocation = (l: any): string => {
    const place = [l.street1, l.city, l.state, l.zip, l.country].filter(Boolean).join(", ");
    const label = l.label ? `${l.label} — ` : "";
    return `- \`${l.id}\`${l.is_primary ? " **(primary — quotes ship from here)**" : ""} ${label}${place}`;
  };

  // Tool: firestarter_ship_from_locations
  server.tool(
    "firestarter_ship_from_locations",
    "List the seller's ship-from (fulfillment) locations. The PRIMARY location is the origin every shipping quote is rated from — wrong shipping prices or 'can't ship there' reports usually trace back to it. Use firestarter_save_ship_from to add/correct one and firestarter_delete_ship_from to remove one. Seller accounts only.",
    {},
    { title: "Ship From Locations", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const data = await apiRequest("GET", "/v1/sellers/locations");
        const rows: any[] = Array.isArray(data?.locations) ? data.locations : [];
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No ship-from locations yet — shipping quotes fall back to the platform origin. Add the seller's real dispatch address with firestarter_save_ship_from (set is_primary: true) so rates are quoted from where parcels actually ship." }] };
        }
        const lines = ["**Ship-from locations** (primary = rate-quote origin):", ...rows.map(renderShipFromLocation)];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error listing ship-from locations: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_save_ship_from
  server.tool(
    "firestarter_save_ship_from",
    "Add or update a seller ship-from (fulfillment) location — the address shipping rates are quoted FROM. Three forms: (1) no location_id → create (street1 + city required; state/zip also required for US/CA/AU origins); (2) location_id + address fields → update that location; (3) location_id + is_primary true and NO address fields → just make it the primary. Set is_primary on the address parcels actually dispatch from — the primary drives every quote's origin. Seller accounts only.",
    {
      location_id: z.string().optional().describe("Existing location id (floc_...) to update or promote. Omit to create a new location."),
      street1: z.string().optional().describe("Street address line 1 (required when creating)"),
      street2: z.string().optional().describe("Street address line 2"),
      city: z.string().optional().describe("City (required when creating)"),
      state: z.string().optional().describe("State/province — required for US/CA/AU origins"),
      zip: z.string().optional().describe("Postal/ZIP — required for US/CA/AU origins"),
      country: z.string().optional().describe("ISO country code (e.g. US, TH). Defaults to US."),
      phone: z.string().optional().describe("Pickup contact phone"),
      label: z.string().optional().describe("Label, e.g. 'Bangkok warehouse'"),
      is_primary: z.boolean().optional().describe("Make this the primary (rate-quote origin)."),
    },
    { title: "Save Ship From", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ location_id, is_primary, ...addr }) => {
      const hasAddress = Object.values(addr).some((v) => typeof v === "string" && v.trim());
      try {
        let data: any;
        if (location_id && !hasAddress) {
          if (!is_primary) {
            return { content: [{ type: "text" as const, text: "Nothing to change — pass address fields to update this location, or is_primary: true to promote it." }], isError: true };
          }
          data = await apiRequest("POST", `/v1/sellers/locations/${location_id}/primary`);
        } else if (location_id) {
          data = await apiRequest("PUT", `/v1/sellers/locations/${location_id}`, { ...addr, is_primary });
          if (is_primary) data = await apiRequest("POST", `/v1/sellers/locations/${location_id}/primary`);
        } else {
          data = await apiRequest("POST", "/v1/sellers/locations", { ...addr, is_primary });
        }
        const l = data?.location ?? data;
        const lines = [
          location_id ? "**Ship-from location updated.**" : "**Ship-from location added.**",
          renderShipFromLocation(l),
        ];
        if (l.is_primary) lines.push("Shipping quotes now rate from this origin.");
        else lines.push("Note: not the primary — quotes still rate from the current primary location.");
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error saving ship-from location: ${toErrorMessage(err)}` }], isError: true };
      }
    }
  );

  // Tool: firestarter_delete_ship_from
  server.tool(
    "firestarter_delete_ship_from",
    "Delete a seller ship-from (fulfillment) location by id (floc_..., from firestarter_ship_from_locations). Deleting the primary leaves quotes rated from the platform origin until another location is added or promoted via firestarter_save_ship_from. Seller accounts only.",
    {
      location_id: z.string().describe("The location id (floc_...) to delete"),
    },
    { title: "Delete Ship From", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async ({ location_id }) => {
      try {
        await apiRequest("DELETE", `/v1/sellers/locations/${location_id}`);
        return { content: [{ type: "text" as const, text: `**Deleted** ship-from location \`${location_id}\`. Check firestarter_ship_from_locations — if it was the primary, promote another so quotes rate from the right origin.` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error deleting ship-from location: ${toErrorMessage(err)}` }], isError: true };
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
    { title: "Verify Listing", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
    "Remove one of your listings from the network (soft delete). Takes the product off the market immediately: buyers' agents can no longer find or buy it, and its share link goes dark.",
    {
      listing_id: z.string().describe("The listing ID (lst_...) to delist"),
    },
    { title: "Remove Listing", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
    { title: "View Incoming Orders", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const data = await apiRequest("GET", "/v1/sellers/orders");
        const orders = data.orders || [];
        if (orders.length === 0) {
          return { content: [{ type: "text" as const, text: "No orders yet. Once a buyer purchases one of your listings, orders will appear here." }] };
        }
        // This list has no test-mode filter, but seller analytics excludes
        // test orders from revenue — so an unlabelled test sale reads exactly
        // like a real one and the two surfaces appear to contradict each other
        // (firestarter-commerce#726). Mark them here and in the header count.
        const testCount = orders.filter((o: any) => o.test_mode === true).length;
        const header = testCount > 0
          ? `**Your Orders** (${orders.length}, ${testCount} in test mode)\n`
          : `**Your Orders** (${orders.length})\n`;
        // Phase 4: a statement-style table — one row per order, identical
        // columns, honest cap — instead of a bullet per order whose fields
        // drifted around the line. order_id stays in a code span (#556: the
        // agent chains it into confirm/ship without re-asking).
        let anyPending = false;
        const rows = orders.map((o: any) => {
          if (o.status === "pending" || o.status === "confirmed") anyPending = true;
          const amount = o.amount_cents ? money(o.amount_cents / 100, o.currency) : "pending";
          const payout = o.net_payout_cents ? money(o.net_payout_cents / 100, o.currency) : "—";
          const status = `${o.status}${o.test_mode === true ? " (test mode)" : ""}`;
          const tracking = o.tracking_number ? `${o.carrier || "carrier"} ${o.tracking_number}` : "—";
          return [String(o.product_title ?? ""), `x${o.quantity ?? 1}`, amount, payout, status, tracking, `\`${o.id}\``];
        });
        const lines = [header, mdTable(
          ["Product", "Qty", "Amount", "Net payout", "Status", "Tracking", "order_id"],
          rows,
          { moreHint: "ask for a specific order or status to narrow" },
        )];
        if (orders.some((o: any) => o.tracking_url)) {
          lines.push("");
          for (const o of orders.slice(0, 20)) {
            const link = o.tracking_url ? mdLink(`Track ${o.tracking_number}`, o.tracking_url) : null;
            if (link) lines.push(`- ${link}`);
          }
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
    "Accept a pending incoming order — step 2 of the seller fulfillment flow (firestarter_seller_orders → firestarter_confirm_order → firestarter_ship_order). Use when a seller wants to accept/confirm an order a buyer placed. Confirming notifies the buyer that the order is accepted and is the gate before shipping. Pass the order_id exactly as shown by firestarter_seller_orders (the order_id field, NOT the exec_... execution id). Only orders still in 'pending' can be confirmed — an order that's already confirmed or shipped doesn't need this — firestarter_ship_order handles its next step.",
    {
      order_id: z.string().describe("REQUIRED. The order_id from firestarter_seller_orders (the seller_earnings id, not the exec_... execution id)."),
    },
    { title: "Confirm Order as Seller", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    { title: "Ship an Order", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    { title: "Seller Analytics", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async () => {
      try {
        const data = await apiRequest("GET", "/v1/sellers/analytics");
        return { content: [{ type: "text" as const, text: formatSellerAnalytics(data) }] };
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
    "View and resolve disputes on orders the user is SELLING (their own catalog/store). This is the SELLER side only. If the user is asking about something they BOUGHT — 'is there a dispute on my order?', a purchase that didn't arrive or arrived wrong — use firestarter_disputes instead. Call with NO arguments to list open disputes on the seller's sales (each shows its dispute_id). Pass dispute_id ALONE to read the full thread - what the buyer actually claimed, and any photos they attached. To act, add an action: 'message' (reply with a note and/or evidence photos, e.g. the packing shot taken before dispatch - use image_urls), 'refund' (refund the buyer in full and lift the escrow freeze), 'contest' (reject the claim and state your case), or 'split' (propose a partial refund - include buyer_pct and seller_pct that sum to 100). Use when a seller mentions a dispute, complaint, refund, chargeback, or return on something they sell.",
    {
      dispute_id: z.string().optional().describe("Dispute ID to act on (disp_...). Omit to list all disputes. Pass it with NO action to read the full thread first."),
      action: z.enum(["message", "refund", "contest", "split"]).optional().describe("What to do with the dispute: 'message' = reply to the buyer with a note and/or evidence photos (no money moves); 'refund' = full refund to the buyer; 'contest' = reject the claim; 'split' = propose a partial refund (also set buyer_pct + seller_pct)."),
      message: z.string().optional().describe("For 'message': the text to post to the dispute thread, in the seller's words."),
      image_urls: z.array(z.string()).optional().describe("For 'message': evidence photos as public https URLs — a packing shot, the item before dispatch, proof of postage. THIS IS THE ONE TO USE when a photo is attached in the conversation: pass its URL straight through. Never fetch an image and rebuild it as a base64 data-URI, which is far too large to survive being printed into a tool call. Up to 5."),
      image_base64: z.string().optional().describe("For 'message': an evidence photo as a base64 data-URI ('data:image/jpeg;base64,…'). Only for an image you genuinely hold as raw bytes — if you have a URL for it, use image_urls instead."),
      buyer_pct: z.number().min(0).max(100).optional().describe("For action 'split': percent refunded to the buyer. buyer_pct + seller_pct must equal 100."),
      seller_pct: z.number().min(0).max(100).optional().describe("For action 'split': percent the seller keeps. buyer_pct + seller_pct must equal 100."),
      reasoning: z.string().optional().describe("Optional note explaining the decision, recorded on the dispute and shown to the buyer."),
    },
    // action "refund" issues a full refund and releases the escrow freeze.
    // destructiveHint: this tool multiplexes read and write — calling it bare
    // lists, calling it with arguments MOVES MONEY. MCP annotations are
    // per-tool, not per-invocation, so the classification has to cover the
    // worst it can do. The cost is a host confirmation on the read path too;
    // that is the right trade against an unprompted refund/payout change.
    { title: "Seller Disputes", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async ({ dispute_id, action, message, image_urls, image_base64, buyer_pct, seller_pct, reasoning }) => {
      try {
        if (dispute_id) {
          const did = cleanListingId(dispute_id);
          // #786: dispute_id with no action READS the thread. A seller was
          // previously told to pick a resolution without being able to see what
          // the buyer had claimed or attached — deciding blind on a money call.
          if (!action) {
            const detail = await apiRequest("GET", `/v1/sellers/disputes/${did}`);
            const d = detail?.dispute;
            if (!d) {
              return { content: [{ type: "text" as const, text: `Couldn't load dispute ${dispute_id}. Call firestarter_seller_disputes with no arguments to list the ones on your sales.` }], isError: true };
            }
            const lines = renderDisputeThread(d, "seller");
            lines.push("");
            // Status-aware: a resolved dispute must not be advertised as
            // refundable — /resolve answers 409 INVALID_STATUS for those.
            const pendingBuyerOffer = (Array.isArray(d.offers) ? d.offers : [])
              .find((o: any) => o.offered_by === "buyer" && !o.accepted_at && !o.rejected_at);
            if (!OPEN_DISPUTE_STATES.has(d.status)) {
              lines.push(`This dispute is closed — no further action is possible.`);
            } else if (pendingBuyerOffer) {
              lines.push(`The buyer is proposing **${pendingBuyerOffer.buyer_pct}% refund to them / ${pendingBuyerOffer.seller_pct}% to you**. Reply with action "message", or resolve with "refund", "contest", or "split" (a counter-proposal).`);
            } else {
              lines.push(`Reply with action "message" (add image_urls to attach evidence such as a packing photo), or resolve with "refund", "contest", or "split".`);
            }
            // The description promises the seller can see the buyer's photos;
            // a count is not seeing them.
            const imageBlocks = await inlineImageBlocks(disputeImageUrls(d));
            return { content: [{ type: "text" as const, text: lines.join("\n") }, ...imageBlocks] };
          }
          // #786: reply with a note and/or evidence photos. No money moves —
          // this is the step that was missing entirely, so a seller's only
          // agent-side options were to accept, reject, or propose a number.
          if (action === "message") {
            // `reasoning` is this tool's note field for the resolve actions; an
            // agent reaching for it here would otherwise have its text dropped.
            return await postDisputeMessage(apiRequest, "/v1/sellers/disputes", did, { message: message ?? reasoning, image_urls, image_base64 }, "The buyer will see it.");
          }
          const ENGINE_ACTION = { refund: "voluntary_refund", contest: "contest", split: "propose_split" } as const;
          const engineAction = ENGINE_ACTION[action];
          const payload: Record<string, unknown> = { action: engineAction };
          // Accept either field: `message` is the natural word for a note and
          // was previously discarded on these actions without a word.
          const note = reasoning ?? message;
          if (note) payload.reasoning = note;
          if (engineAction === "propose_split") {
            payload.buyer_pct = buyer_pct ?? 50;
            payload.seller_pct = seller_pct ?? 50;
          }
          await apiRequest("PUT", `/v1/sellers/disputes/${did}/resolve`, payload);
          const summary =
            engineAction === "voluntary_refund" ? "Full refund issued to the buyer. The escrow freeze is lifted and the order is closed."
              : engineAction === "contest" ? "Claim contested. The buyer has been notified and can respond, counter, or escalate."
                : `Split proposed to the buyer: ${payload.buyer_pct}% refund / ${payload.seller_pct}% to you. It applies once the buyer accepts.`;
          return { content: [{ type: "text" as const, text: `**Dispute ${did} updated.** ${summary}` }] };
        }
        // #786 review: without a dispute_id this used to fall through to the
        // list, silently discarding a note and its evidence photos while
        // returning a non-error — the same silent-discard the message path
        // exists to remove.
        if (action) {
          return { content: [{ type: "text" as const, text: `I need the dispute_id (disp_…) to ${action === "message" ? "post that" : `${action} a dispute`}. Nothing was sent. Call firestarter_seller_disputes with no arguments to list the disputes on your sales.` }], isError: true };
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
          lines.push(`- **${sanitizeUntrusted(d.product) || "Order"}** (${d.id}) - Reason: ${sanitizeUntrusted(d.reason, 300) || "Not specified"} - Status: ${d.status}${d.resolution ? ` - Resolution: ${sanitizeUntrusted(d.resolution, 300)}` : ""}`);
        }
        lines.push(`\nCall again with a dispute_id and NO action to read the full thread first — what the buyer claimed and any photos. Then reply with action "message" (attach evidence via image_urls), or resolve with refund / contest / split.`);
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
    // One implementation; the module-level helper is identical.
    const textBlock = textBlockOf;

    server.tool(
      "firestarter_disputes",
      "For BUYERS: open, check, and resolve disputes on orders the user BOUGHT. Use this whenever a buyer asks 'is there a dispute on my order?', wants to open a dispute (item never arrived, arrived damaged / wrong / not as described), or needs to respond to one — post a note or photo, accept / reject / counter the seller's partial-refund offer, withdraw, or escalate to Firestarter. Call with NO arguments to list the buyer's disputes; pass an order's execution_id (exec_…) to check whether THAT order has a dispute; pass a dispute_id (disp_…) to see the full thread. This is the BUYER side — for disputes on orders the user is SELLING, use firestarter_seller_disputes instead.",
      {
        action: z.enum(["open", "message", "accept", "reject", "counter", "withdraw", "escalate"]).optional().describe("What to do. OMIT to list the buyer's disputes, or to view one (pass dispute_id, or execution_id to look up the dispute on that order). 'open' = file a new dispute (needs execution_id + reason). 'message' = post a note and/or photo to the thread (needs dispute_id or execution_id, plus message and/or image_urls — pass a photo's URL, never rebuild it as base64). 'accept' / 'reject' = respond to the seller's split offer (offer_id optional — defaults to the latest pending seller offer). 'counter' = propose your own split (needs buyer_pct + seller_pct). 'withdraw' = drop the dispute. 'escalate' = ask Firestarter to review."),
        execution_id: z.string().optional().describe("Order / execution id (exec_…). Required for 'open'. With no action, pass this to check whether a specific order has a dispute. May also stand in for dispute_id on actions — the dispute on that order is looked up."),
        dispute_id: z.string().optional().describe("Dispute id (disp_…). Identifies which dispute to view or act on for message / accept / reject / counter / withdraw / escalate."),
        reason: z.string().optional().describe("For 'open': what went wrong, in the buyer's words (e.g. 'Package never arrived, tracking stuck for two weeks'). Also used as the optional note on a 'counter' or 'escalate'."),
        type: z.enum(["not_received", "not_as_described", "damaged", "missing_item", "wrong_item", "other"]).optional().describe("For 'open': the category of problem. Use 'not_received' when the order never arrived. Defaults to 'not_as_described'."),
        message: z.string().optional().describe("For 'message': the text to post to the dispute thread."),
        image_urls: z.array(z.string()).optional().describe("For 'message': evidence photos the buyer already has, as public https URLs. THIS IS THE ONE TO USE when a photo is attached in the conversation — pass its URL straight through. Never fetch an image and rebuild it as a base64 data-URI to fill image_base64: a photo is far too large to survive being printed into a tool call, which is why attaching used to fail. Up to 5."),
        image_base64: z.string().optional().describe("For 'message': an evidence photo as a base64 data-URI ('data:image/jpeg;base64,…'). Only for an image you genuinely hold as raw bytes and small enough to inline — if you have a URL for it, use image_urls instead."),
        offer_id: z.string().optional().describe("For 'accept' / 'reject': the specific offer id to respond to. Omit to act on the latest pending seller offer."),
        buyer_pct: z.number().min(0).max(100).optional().describe("For 'counter': the percent YOU (the buyer) would be refunded. buyer_pct + seller_pct must equal 100."),
        seller_pct: z.number().min(0).max(100).optional().describe("For 'counter': the percent the seller keeps. buyer_pct + seller_pct must equal 100."),
      },
      // "accept" settles the escrow at the seller's split; "withdraw" abandons
      // the claim and unfreezes the funds. Both are irreversible money moves.
      // destructiveHint: this tool multiplexes read and write — calling it bare
      // lists, calling it with arguments MOVES MONEY. MCP annotations are
      // per-tool, not per-invocation, so the classification has to cover the
      // worst it can do. The cost is a host confirmation on the read path too;
      // that is the right trade against an unprompted refund/payout change.
      { title: "Buyer Disputes", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ action, execution_id, dispute_id, reason, type, message, image_urls, image_base64, offer_id, buyer_pct, seller_pct }) => {
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
            return await postDisputeMessage(apiRequest, "/buyer/disputes", did, { message, image_urls, image_base64 }, "The seller will see it.");
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
            // Counterparty free text in the detail view, same as the thread below.
            if (d.reason) lines.push(`Reason: ${sanitizeUntrusted(d.reason, 600)}${d.dispute_type ? ` (${statusLabel(d.dispute_type)})` : ""}`);
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
                lines.push(`- ${who}: **${o.buyer_pct}% refund to you / ${o.seller_pct}% to seller** — ${state}${o.reasoning ? ` — "${sanitizeUntrusted(o.reasoning, 400)}"` : ""}`);
              }
            }

            const messages = Array.isArray(d.messages) ? d.messages : [];
            if (messages.length > 0) {
              lines.push("", "**Messages:**");
              for (const m of messages) {
                const who = m.sender_role === "buyer" ? "You" : m.sender_role === "seller" ? "Seller" : "Firestarter";
                const nAtt = Array.isArray(m.attachment_urls) ? m.attachment_urls.length : 0;
                // The counterparty types this straight into the reader's
                // context during a refund negotiation. Cross-principal, so the
                // "sellers read back their own text" exemption does not apply.
                lines.push(`- **${who}:** ${sanitizeUntrusted(m.message, 600)}${nAtt ? ` _(${nAtt} photo${nAtt > 1 ? "s" : ""})_` : ""}`);
              }
            }

            // Status-aware next step. Withdraw/counter need an open, pre-escalation
            // dispute; escalate only works after the seller has engaged.
            // A closed/resolved dispute can still carry an offer row that was
            // never explicitly accepted or rejected — prompting "accept /
            // reject / counter" on it invites actions that can no longer apply.
            const disputeActionable = !["closed", "resolved", "dismissed", "auto_resolved"].includes(String(d.status));
            const pendingSellerOffer = disputeActionable
              ? offers.find((o: any) => o.offered_by === "seller" && !o.accepted_at && !o.rejected_at)
              : undefined;
            lines.push("");
            if (!disputeActionable) {
              lines.push("This dispute is closed — no further actions apply. If something is still wrong with the order, open a new dispute on it.");
            } else if (pendingSellerOffer) {
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
            // Don't stutter "closed (closed)" when the status label already
            // says the dispute is over; the suffix is only for open-sounding
            // labels on disputes that are in fact closed.
            const label = statusLabel(d.status);
            const closedSuffix = d.is_open || /closed|resolved|dismissed/i.test(label) ? "" : " (closed)";
            outLines.push(`- **${d.product || "Order"}** — ${d.id} — ${label}${closedSuffix}${d.execution_id ? ` — order ${d.execution_id}` : ""}`);
          }
          outLines.push(`\nSee one in full: firestarter_disputes with its dispute_id (or the order's execution_id).`);
          return textBlock(outLines.join("\n"));
        } catch (err: any) {
          // #896: a closed dispute window is a business RULE, not a failure.
          //
          // A buyer whose escrow had already paid out got a red "Failed" — with
          // the correct advice printed underneath it. The tool knew the right
          // answer and presented it as a system error, which invites a retry
          // that can never work.
          //
          // Only terminal states qualify: the order's money has finished
          // moving, so no amount of retrying opens a dispute. A 500, a
          // malformed request and an unknown order all stay errors.
          const closed = disputeWindowClosedText(err);
          if (closed) return textBlock(closed);
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
      "Set up a community/affiliate 'market' on Firestarter so a community owner or influencer earns a share of Firestarter's platform fee on every sale their community drives. Use when a user asks to create, set up, or start a community market, affiliate program, or 'store for my audience' (e.g. Discord/Telegram/X following). Market creation is independent of seller onboarding and country: it does NOT require being a Firestarter seller, connecting Stripe, or living in a payout-supported country — it works from ANY country, including ones where seller payouts aren't yet available. (A payout method is only needed LATER to withdraw accrued earnings, and can be connected any time.) Creates an attribution PROGRAM owned by the caller. `share_bps` is the cut of the PLATFORM FEE in basis points (1000 = 10%); it is capped at the platform self-serve max and the response returns the effective value. Optionally claim a `handle` now for a memorable community URL (firestarter.network/m/<handle>); it can also be set or changed later with firestarter_set_market_handle. A share code for the community comes from firestarter_market_link.",
      {
        share_bps: z.number().int().min(0).max(10000).describe("Cut of Firestarter's platform fee in basis points (1000 = 10%). Capped at the platform self-serve max; the response returns the effective value."),
        type: z.enum(["community", "developer"]).optional().describe("Program type. Default 'community'."),
        display_name: z.string().max(60).optional().describe("Buyer-facing community name, e.g. 'Analog'. Displayed on join/browse/community surfaces."),
        tagline: z.string().max(80).optional().describe("One-line 'what this community is about', shown under the name on the join page and in firestarter_market_preview. Change it later with firestarter_update_market."),
        handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/i, "handle must be 2-31 chars: letters, digits and hyphens, starting with a letter or digit").optional().describe("Optional vanity handle for the community URL — firestarter.network/m/<handle> instead of a random share code. 2-31 chars: letters, digits and hyphens, must start with a letter or digit. Case is ignored (normalized to lowercase), so 'Analog' and 'analog' are the same handle. Must be unique; the API rejects handles that are reserved or shaped like a share code. If it's taken the whole create fails, so retry with a different handle (or omit it and claim one later with firestarter_set_market_handle)."),
      },
      { title: "Create Market", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ share_bps, type, display_name, tagline, handle }) => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/programs", { type: type ?? "community", override_bps: share_bps, display_name, tagline, slug: handle?.toLowerCase() });
          const p = res.program ?? {};
          let text = `**Market created.**${p.display_name ? ` ${p.display_name}.` : ""} Program id: \`${p.id}\`. Your share: ${(Number(p.override_bps ?? 0) / 100).toFixed(2)}% of the platform fee`;
          if (res.override_bps_capped) text += ` (capped from your request to the platform max of ${(Number(res.max_self_serve_bps ?? 0) / 100).toFixed(2)}%)`;
          text += ".";
          if (p.slug) text += `\n\nYour community URL: ${mdUrlLink(`${MARKET_LINK_BASE}/${p.slug}`) ?? `${MARKET_LINK_BASE}/${p.slug}`}`;
          text += `\n\nNext: firestarter_market_link with program_id \`${p.id}\` to get a share code your community joins through. Then curate what your community recommends with firestarter_set_market_picks — those picks are the first thing buyers see. Track earnings with firestarter_market_earnings; connect payouts (to withdraw) with firestarter_connect_payouts.`;
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
      "Mint a shareable join code for a market you own (from firestarter_create_market). Give the code to your community — when a member redeems it (firestarter_join_market) they are attributed to your program so you earn on their activity. Optionally tag a channel/campaign for tracking.",
      {
        program_id: z.string().describe("The market/program id from firestarter_create_market."),
        channel: z.string().optional().describe("Optional channel tag, e.g. 'discord', 'x', 'telegram'."),
        campaign: z.string().optional().describe("Optional campaign tag for tracking."),
      },
      { title: "Market Link", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ program_id, channel, campaign }) => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/links", { program_id, channel, campaign });
          const code = res.link?.code;
          if (!code) return { content: [{ type: "text" as const, text: "Link created but no code was returned." }], isError: true };
          return { content: [{ type: "text" as const, text: `**Share link:** ${mdUrlLink(`${MARKET_LINK_BASE}/${code}`) ?? `${MARKET_LINK_BASE}/${code}`}\n(share code: \`${code}\`)\n\nGive this to your community. Each member who redeems it — by opening the link, or pasting the code to their Firestarter agent (firestarter_join_market) — joins your market. Prefer a memorable URL? Claim a handle with firestarter_set_market_handle and ${MARKET_LINK_BASE}/<handle> resolves to the same market.` }] };
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
      { title: "Set Market Handle", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ program_id, handle }) => {
        try {
          const res = await apiRequest("PATCH", `/v1/attribution/programs/${encodeURIComponent(program_id)}`, { slug: handle.toLowerCase() });
          const slug = res.program?.slug ?? handle.toLowerCase();
          return { content: [{ type: "text" as const, text: `**Handle set.** Your community URL is now ${mdUrlLink(`${MARKET_LINK_BASE}/${slug}`) ?? `${MARKET_LINK_BASE}/${slug}`}\n\nShare it anywhere — it resolves to the same market as your share code and stays stable if you rotate the code.` }] };
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
      "firestarter_update_market",
      "Update a community market you own: its buyer-facing display_name, its tagline (the one-line 'what this community is about' shown on the join page and in firestarter_market_preview), and/or whether it appears in the public 'Discover communities' list (discoverable). Pass at least one field. Pass an empty string for display_name or tagline to CLEAR it. To change the vanity handle/URL use firestarter_set_market_handle; to change the recommended products use firestarter_set_market_picks.",
      {
        program_id: z.string().describe("The market/program id (from firestarter_create_market or firestarter_my_markets)."),
        display_name: z.string().max(60).optional().describe("Buyer-facing community name. Empty string clears it (buyers then see the owner org name)."),
        tagline: z.string().max(80).optional().describe("One-line description shown under the name. Empty string clears it."),
        discoverable: z.boolean().optional().describe("Whether this market appears in the public 'Discover communities' list (firestarter_discover_markets)."),
      },
      { title: "Update Market", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ program_id, display_name, tagline, discoverable }) => {
        const body: Record<string, unknown> = {};
        if (display_name !== undefined) body.display_name = display_name === "" ? null : display_name;
        if (tagline !== undefined) body.tagline = tagline === "" ? null : tagline;
        if (discoverable !== undefined) body.discoverable = discoverable;
        if (Object.keys(body).length === 0) {
          return { content: [{ type: "text" as const, text: "Nothing to update — pass display_name, tagline, and/or discoverable." }], isError: true };
        }
        try {
          const res = await apiRequest("PATCH", `/v1/attribution/programs/${encodeURIComponent(program_id)}`, body);
          const p = res?.program ?? {};
          const lines = ["**Market updated.**"];
          if ("display_name" in body) lines.push(`Name: ${p.display_name ? p.display_name : "(cleared — buyers see your org name)"}`);
          if ("tagline" in body) lines.push(`Tagline: ${p.tagline ? p.tagline : "(cleared)"}`);
          if ("discoverable" in body) lines.push(`Discoverable: ${p.discoverable === false ? "no (hidden from Discover)" : "yes (listed in Discover)"}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "PROGRAM_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No market on your account has that program id. List yours with firestarter_my_markets." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't update the market: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_market_earnings",
      "Show the earnings of the markets you own: override earnings pending vs paid out, and transaction counts. Use when a community owner asks how much they have earned or wants their attribution dashboard.",
      {},
      { title: "Market Earnings", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/attribution/earnings");
          const usd = (cents?: number) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
          const programs = Number(res?.programs ?? 0);
          const txns = Number(res?.transactions ?? 0);
          // Lifetime earned = pending + released (both already net of reversals),
          // matching the owner dashboard's headline number.
          const lifetime = (Number(res?.pending_cents) || 0) + (Number(res?.released_cents) || 0);
          const lines = [
            `**Your market earnings** (across ${programs} market${programs === 1 ? "" : "s"})`,
            `Lifetime earned: ${usd(lifetime)} — from ${txns} order${txns === 1 ? "" : "s"} your communities drove`,
            `Available to pay out: ${usd(res?.available_cents)}`,
          ];
          if (Number(res?.in_clearing_cents) > 0) lines.push(`Still clearing (not yet payable): ${usd(res?.in_clearing_cents)}`);
          if (Number(res?.awaiting_connect_cents) > 0) lines.push(`Held until you connect payouts: ${usd(res?.awaiting_connect_cents)} — set up with firestarter_connect_payouts.`);
          if (Number(res?.reversed_cents) > 0) lines.push(`Reversed (refunds/adjustments): ${usd(res?.reversed_cents)}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Error fetching earnings: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_my_markets",
      "List the community markets you OWN (created with firestarter_create_market): each one's program id, buyer-facing name, community URL/handle, share code, status, your fee share, and current member count. Use when an owner asks 'what markets do I have?', needs a market's program_id for another tool (firestarter_market_link, firestarter_set_market_handle, firestarter_set_market_picks), or wants an at-a-glance view. Read-only. For earnings use firestarter_market_earnings; to preview a community's public shelf use firestarter_market_preview.",
      {},
      { title: "My Markets", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/attribution/programs");
          const programs: any[] = Array.isArray(res?.programs) ? res.programs : [];
          if (programs.length === 0) {
            return { content: [{ type: "text" as const, text: "You don't own any markets yet. Create one with firestarter_create_market." }] };
          }
          const blocks = programs.map((p) => {
            const name = typeof p.display_name === "string" && p.display_name.trim() ? p.display_name.trim() : "(unnamed market)";
            const code = Array.isArray(p.links) && p.links[0]?.code ? p.links[0].code : null;
            const url = p.slug ? `${MARKET_LINK_BASE}/${p.slug}` : code ? `${MARKET_LINK_BASE}/${code}` : "(no share link yet — mint one with firestarter_market_link)";
            return [
              `**${name}**${p.type && p.type !== "community" ? ` (${p.type})` : ""}`,
              `Program id: \`${p.id}\` · Status: ${p.status}`,
              `URL: ${mdUrlLink(url) ?? url}${code ? ` · Share code: \`${code}\`` : ""}`,
              // commerce#769: a bare "Members: 0" beside real sales and real
              // earnings is the contradiction that issue was filed about — a
              // member who switches markets keeps the orders they drove but
              // stops being counted. The API answers both questions
              // (member_count = bound right now, member_count_all_time = ever)
              // and the web tile names the window; this surface still emitted
              // the single unqualified number. Say which one it is, but only
              // when they differ — otherwise it reads exactly as before.
              `Your share: ${(Number(p.override_bps ?? 0) / 100).toFixed(2)}% of the platform fee · ${membersText(p)}`,
            ].join("\n");
          });
          return { content: [{ type: "text" as const, text: `**Your markets (${programs.length}):**\n\n${blocks.join("\n\n")}` }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't list your markets: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_set_market_tiers",
      "Configure member tiers for a community market you own. Tiers reward members with ACCESS, never money or discounts — a higher tier sees picks you've staged early (firestarter_set_market_picks with min_tier). A member's tier is derived from their qualifying orders in your community over the last 12 months; nothing is stored per member, so there is no balance to top up and nothing expires. Every market already has working defaults (Member 0 / Regular 2 / Insider 5) — this tool renames rungs, changes how many orders each needs, adds a 4th rung, or switches tiers off. Raising a threshold never demotes an existing member for 30 days.",
      {
        program_id: z.string().describe("The market/program id (from firestarter_my_markets)."),
        enabled: z.boolean().optional().describe("Set false to switch tiers off entirely for this market. Default true."),
        tiers: z.array(z.object({
          name: z.string().max(20).describe("What this rung is called, e.g. 'Regular'. Shown to members."),
          min_orders: z.number().int().min(0).max(100).optional().describe("Qualifying orders needed. Ignored for the first rung, which is always 0 (everyone who joins). Must increase down the list."),
        })).min(2).max(4).optional().describe("2-4 rungs, cheapest first. Omit to keep the platform defaults."),
      },
      { title: "Set Market Tiers", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ program_id, enabled, tiers }) => {
        try {
          const tier_config = tiers
            ? { enabled: enabled !== false, tiers: tiers.map((t) => ({ name: t.name, min_orders: t.min_orders ?? 0 })) }
            : { enabled: enabled !== false };
          const res = await apiRequest("PATCH", `/v1/attribution/programs/${encodeURIComponent(program_id)}`, { tier_config });
          const saved = res?.program?.tier_config;
          if (!saved?.enabled) {
            return { content: [{ type: "text" as const, text: "**Tiers switched off.** Members see your shelf with no rungs, and any picks staged behind a tier are now hidden from everyone — drop their min_tier to 0 to publish them." }] };
          }
          const ladder = (saved.tiers ?? []).map((t: any, i: number) =>
            i === 0 ? `• ${t.name} — everyone who joins` : `• ${t.name} — ${t.min_orders} qualifying order${t.min_orders === 1 ? "" : "s"}`,
          );
          return { content: [{ type: "text" as const, text: `**Tiers updated.**\n${ladder.join("\n")}\n\nA qualifying order is a delivered, non-refunded order over the platform minimum — that part isn't configurable, so status means the same thing across every community. Stage a pick for a rung with firestarter_set_market_picks (min_tier).` }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't update tiers: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_create_drop",
      "Create a community-sponsored DROP on a market you own: a per-claim discount on ONE listing for the first N members, optionally opening it to higher tiers first (a tier-gated early-access window). It applies at checkout when a member claims a slot (firestarter_drops action 'claim'), first-come first-served, one per member. Who funds it depends on whose listing it is: on YOUR OWN listing it goes live immediately with no approval needed — funded from your drop wallet if it covers the whole pot (max_claims × discount), otherwise from your own seller proceeds; on ANOTHER seller's listing it goes live now only if your drop wallet covers the pot (topped up via firestarter_fund_wallet, and the seller is made whole from it) or that seller has granted your community standing approval — otherwise it waits as a request for the seller to approve (firestarter_drop_requests). Distinct from tiered ACCESS (firestarter_set_market_tiers), which never discounts. test/live follows your API key's environment.",
      {
        program_id: z.string().describe("The market/program id you own (from firestarter_my_markets)."),
        listing_id: z.string().describe("The listing (lst_...) to discount — find one with firestarter_catalog_search. Must be a real, sellable listing."),
        discount_cents: z.number().int().positive().describe("Per-claim discount in cents, e.g. 500 = $5 off each claimed order."),
        max_claims: z.number().int().positive().describe("How many members can claim it (the 'first N') — first-come, first-served, one per member."),
        min_tier: z.number().int().min(0).optional().describe("Rung required to claim DURING the priority window (0 = everyone). Use with priority_hours to give higher tiers early access first."),
        priority_hours: z.number().min(0).optional().describe("Hours the drop stays tier-gated (to min_tier and up) before opening to everyone. Omit or 0 = open to all immediately."),
        expires_in_hours: z.number().positive().optional().describe("Hours until the drop expires. Default 168 (7 days)."),
      },
      // Commits the owner's wallet (or the seller's margin) to a discount pot.
      { title: "Create Drop", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async ({ program_id, listing_id, discount_cents, max_claims, min_tier, priority_hours, expires_in_hours }) => {
        try {
          const body: Record<string, unknown> = { listing_id, discount_cents, max_claims };
          if (min_tier != null) body.min_tier = min_tier;
          if (priority_hours != null) body.priority_hours = priority_hours;
          if (expires_in_hours != null) body.expires_in_hours = expires_in_hours;
          const res = await apiRequest("POST", `/v1/attribution/programs/${encodeURIComponent(program_id)}/drops`, body);
          const d = res?.drop ?? {};
          const dollars = ((Number(d.discount_cents) || discount_cents) / 100).toFixed(2);
          const slots = Number(d.max_claims) || max_claims;
          // Seller-approval lifecycle (Phase A): a drop on the requester's own
          // listing, or on a listing whose seller has granted this program standing
          // trust, goes live immediately; otherwise it's parked pending the
          // seller's decision. Phase B adds a second live path: a drop the OWNER'S
          // OWN wallet fully covers is self-funded and also skips approval — the
          // API is the source of truth for both (`res.status` / `d.funding_mode`),
          // this tool never guesses from the input alone.
          const pending = res?.status === "pending_seller_approval";
          const selfFunded = !pending && d.funding_mode === "owner_wallet";
          const lines = [
            pending
              ? `**Drop requested — pending the seller's approval.** $${dollars} off ${d.listing_id ?? listing_id} for the first ${slots} member${slots === 1 ? "" : "s"}.`
              : selfFunded
                ? `**Drop live — you're funding it from your wallet.** $${dollars} off ${d.listing_id ?? listing_id} for the first ${slots} member${slots === 1 ? "" : "s"} ($${dollars} reserved from your wallet as each member claims). No seller approval needed.`
                : `**Drop is live.** $${dollars} off ${d.listing_id ?? listing_id} for the first ${slots} member${slots === 1 ? "" : "s"}.`,
          ];
          if (Number(d.min_tier) > 0 && d.priority_until) {
            lines.push(`Early access for tier ${d.min_tier}+ until ${new Date(d.priority_until).toISOString().slice(0, 10)}, then it opens to everyone.`);
          }
          if (d.expires_at) lines.push(`Expires ${new Date(d.expires_at).toISOString().slice(0, 10)}.`);
          if (pending) {
            lines.push("They've been notified; members can't claim it until they approve (or grant your community standing approval). You can withdraw it with firestarter_cancel_drop.");
          } else if (selfFunded) {
            lines.push("Members reserve a slot with firestarter_drops (action 'claim'); the discount is drawn from your wallet at claim time — nothing comes out of the seller's proceeds. Check your balance with firestarter_wallet_balance.");
          } else {
            lines.push("Members reserve a slot with firestarter_drops (action 'claim'); the discount then applies at checkout.");
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "PROGRAM_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No market on your account has that program id. List yours with firestarter_my_markets." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "INVALID_LISTING") {
            return { content: [{ type: "text" as const, text: `That listing can't back a drop: ${toErrorMessage(err)}. Find a valid listing id with firestarter_catalog_search.` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "DROP_DUPLICATE") {
            return { content: [{ type: "text" as const, text: `Couldn't create the drop: ${toErrorMessage(err)} Check its status with firestarter_market_drops, or withdraw it with firestarter_cancel_drop before asking again.` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "LISTING_NOT_SELLABLE") {
            return { content: [{ type: "text" as const, text: `Couldn't create the drop: ${toErrorMessage(err)} Pick a different, active listing with firestarter_catalog_search.` }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't create the drop: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_cancel_drop",
      "Withdraw a drop request you created (with firestarter_create_drop) on a market you own, while it is still pending the seller's approval. Once cancelled it stops being visible to that seller and can never be approved — create a new request with firestarter_create_drop if you change your mind. This only works on still-pending requests; a drop that's already live, expired, exhausted, or already decided can't be cancelled this way.",
      {
        program_id: z.string().describe("The market/program id you own (from firestarter_my_markets) — the drop belongs to this program."),
        drop_id: z.string().describe("The drop id to cancel (from firestarter_create_drop's response or firestarter_market_drops)."),
      },
      { title: "Cancel Drop", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ program_id, drop_id }) => {
        try {
          await apiRequest("POST", `/v1/attribution/programs/${encodeURIComponent(program_id)}/drops/${encodeURIComponent(drop_id)}/cancel`);
          return { content: [{ type: "text" as const, text: `Cancelled — drop request \`${drop_id}\` was withdrawn before the seller decided. Create a new one anytime with firestarter_create_drop.` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "PROGRAM_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No market on your account has that program id. List yours with firestarter_my_markets." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "DROP_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No pending drop request found to cancel — it may already be live, decided, expired, or not exist. Check firestarter_market_drops." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't cancel the drop: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_market_drops",
      "List the community-sponsored drops on a market you OWN (created with firestarter_create_drop): each drop's id, discount, how many slots have been claimed vs the cap, its status (active, exhausted, expired, or still pending_seller_approval for a drop on another seller's listing), the listing it discounts, any tier gate, and when it expires. The drop id shown is what firestarter_cancel_drop needs to withdraw a still-pending request. Use when an owner asks 'how are my drops doing?', 'how many people claimed my drop?', or wants to see what drops are still live before creating another. Read-only. This is the OWNER view; buyers discover and claim drops on a specific listing with firestarter_drops.",
      {
        program_id: z.string().describe("The market/program id you own (from firestarter_my_markets)."),
      },
      { title: "Market Drops", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async ({ program_id }) => {
        try {
          const res = await apiRequest("GET", `/v1/attribution/programs/${encodeURIComponent(program_id)}/drops`);
          const drops: any[] = Array.isArray(res?.drops) ? res.drops : [];
          if (drops.length === 0) {
            return { content: [{ type: "text" as const, text: "This market has no drops yet. Create one with firestarter_create_drop to reward members with a per-claim discount." }] };
          }
          const blocks = drops.map((d) => {
            const dollars = ((Number(d.discount_cents) || 0) / 100).toFixed(2);
            const claimed = `${Number(d.claims_used) || 0}/${Number(d.max_claims) || 0} claimed`;
            // Lead with the drop id — it's what firestarter_cancel_drop needs to
            // withdraw a still-pending request (market_drops is the owner surface
            // that surfaces it).
            const lines = [`• \`${d.id}\` — $${dollars} off ${d.listing_id} — ${claimed} · ${d.status}`];
            // Only while the priority window is genuinely still open — a past
            // window would misreport an open drop as gated.
            if (Number(d.min_tier) > 0 && d.priority_until && new Date(d.priority_until) > new Date()) {
              lines.push(`  early access for tier ${d.min_tier}+ until ${new Date(d.priority_until).toISOString().slice(0, 10)}, then open to all`);
            }
            if (d.expires_at) lines.push(`  expires ${new Date(d.expires_at).toISOString().slice(0, 10)}`);
            else if (d.request_expires_at) lines.push(`  awaiting the seller's approval — decide by ${new Date(d.request_expires_at).toISOString().slice(0, 10)}`);
            return lines.join("\n");
          });
          const hasPending = drops.some((d) => d.status === "pending_seller_approval");
          const footer = hasPending ? "\n\nWithdraw a still-pending request with firestarter_cancel_drop and the drop id shown above." : "";
          return { content: [{ type: "text" as const, text: `**Drops on this market (${drops.length}):**\n${blocks.join("\n")}${footer}` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "PROGRAM_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No market on your account has that program id. List yours with firestarter_my_markets." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't list the market's drops: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    // ── Seller side of the drop approval lifecycle ──
    // A community can propose a drop on a listing it doesn't own (firestarter_create_drop);
    // unless the seller has already granted that community standing trust, the
    // drop is parked pending_seller_approval until the SELLER decides here.

    server.tool(
      "firestarter_drop_requests",
      "List the community-sponsored drop requests waiting on YOUR decision as a seller: a community owner has proposed a per-claim discount on one of your listings, and it stays invisible to buyers and unclaimable until you approve or reject it (or expires on its own). Shows the requesting community, the listing, the discount, how many members can claim it, and the deadline to decide. Use firestarter_approve_drop or firestarter_reject_drop with a request's drop id — or firestarter_trust_community_drops to stop reviewing this community's requests one by one.",
      {},
      { title: "Drop Requests", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/drops/requests");
          const requests: any[] = Array.isArray(res?.requests) ? res.requests : [];
          if (requests.length === 0) {
            return { content: [{ type: "text" as const, text: "No pending drop requests right now." }] };
          }
          const lines = requests.map((r) => {
            const dollars = ((Number(r.discount_cents) || 0) / 100).toFixed(2);
            const who = r.community_name || "A community";
            const what = r.product_name || r.listing_id;
            const deadline = r.request_expires_at ? ` · decide by ${new Date(r.request_expires_at).toISOString().slice(0, 10)}` : "";
            return `- \`${r.id}\` — ${who} wants $${dollars} off **${what}** for up to ${Number(r.max_claims) || 0} member${Number(r.max_claims) === 1 ? "" : "s"}${deadline}`;
          });
          return {
            content: [{
              type: "text" as const,
              text: `**Pending drop requests (${requests.length}):**\n${lines.join("\n")}\n\nApprove with firestarter_approve_drop, decline with firestarter_reject_drop — each discount comes out of YOUR proceeds on the claimed sales, not Firestarter's fee. To stop reviewing a community's requests one by one, pre-approve it with firestarter_trust_community_drops.`,
            }],
          };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't list drop requests: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_approve_drop",
      "Approve a pending community drop request on one of your listings (from firestarter_drop_requests), making it go live immediately so members can start claiming it. The per-claim discount comes out of YOUR proceeds on each claimed sale — not Firestarter's platform fee — so an approved discount directly reduces your margin on those sales. The requesting community is notified of the approval.",
      {
        drop_id: z.string().describe("The drop id to approve (from firestarter_drop_requests)."),
      },
      { title: "Approve Drop", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ drop_id }) => {
        try {
          await apiRequest("POST", `/v1/drops/${encodeURIComponent(drop_id)}/approve`);
          return { content: [{ type: "text" as const, text: `Approved — drop \`${drop_id}\` is now live; members can start claiming it, and the discount will come out of your proceeds on each claimed sale.` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "DROP_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "That drop request was not found." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "NOT_PENDING") {
            return { content: [{ type: "text" as const, text: "This drop request is no longer pending — it may have already been decided or expired." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "FORBIDDEN") {
            return { content: [{ type: "text" as const, text: "That drop request isn't on one of your listings, so you can't decide it." }], isError: true };
          }
          // DROP_BELOW_FLOOR / LISTING_UNAVAILABLE (and anything else) fall through
          // to the API's own message, which is already actionable.
          return { content: [{ type: "text" as const, text: `Couldn't approve the drop: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_reject_drop",
      "Decline a pending community drop request on one of your listings (from firestarter_drop_requests). It never goes live, nothing is charged against your proceeds, and the requesting community owner is notified — optionally with your reason. This decides only this one request; the same community can still ask again later unless you also revoke standing trust with firestarter_untrust_community_drops.",
      {
        drop_id: z.string().describe("The drop id to reject (from firestarter_drop_requests)."),
        reason: z.string().optional().describe("Optional short reason shown to the requesting community owner (e.g. 'discount too deep for this item')."),
      },
      { title: "Reject Drop", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async ({ drop_id, reason }) => {
        try {
          await apiRequest("POST", `/v1/drops/${encodeURIComponent(drop_id)}/reject`, { reason });
          return { content: [{ type: "text" as const, text: `Declined — drop \`${drop_id}\` will not go live.${reason ? ` Reason sent to the requester: "${reason}"` : ""}` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "NOT_PENDING") {
            return { content: [{ type: "text" as const, text: "This drop request can't be rejected — it may not exist, may not be on one of your listings, or may no longer be pending." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't reject the drop: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_trust_community_drops",
      "Grant a community program standing approval to run drops on your listings: from now on, its drop requests go live immediately with no per-request review, and any of its requests you're currently sitting on get auto-approved right away. Use this once you're comfortable a community's asks are reasonable and you'd rather not approve/reject each one — you can always revoke it later with firestarter_untrust_community_drops (that only stops NEW requests from auto-approving; anything already live stays live). Every approved drop's discount still comes out of YOUR proceeds per claim, trust or no trust.",
      {
        program_id: z.string().describe("The community/market program id to trust — appears on each request from firestarter_drop_requests, or shared directly by the community owner."),
      },
      { title: "Trust Community Drops", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async ({ program_id }) => {
        try {
          const res = await apiRequest("POST", `/v1/drops/programs/${encodeURIComponent(program_id)}/trust`);
          const approved = Number(res?.approved_pending) || 0;
          const text = approved > 0
            ? `Trusted — this community's drop requests on your listings now go live automatically. ${approved} pending request${approved === 1 ? "" : "s"} from them just auto-approved.`
            : "Trusted — this community's drop requests on your listings now go live automatically.";
          return { content: [{ type: "text" as const, text }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't trust that community: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_untrust_community_drops",
      "Revoke a standing approval you granted with firestarter_trust_community_drops: this community's NEW drop requests on your listings go back to needing your manual decision via firestarter_approve_drop / firestarter_reject_drop. Anything already live from this community before the revoke keeps running until it expires or is exhausted — this does not cancel existing drops.",
      {
        program_id: z.string().describe("The community/market program id to stop trusting."),
      },
      { title: "Untrust Community Drops", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async ({ program_id }) => {
        try {
          const res = await apiRequest("POST", `/v1/drops/programs/${encodeURIComponent(program_id)}/untrust`);
          const text = res?.revoked === true
            ? "Untrusted — this community's future drop requests on your listings now need your manual approval again."
            : "This community wasn't trusted, so nothing changed.";
          return { content: [{ type: "text" as const, text }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't untrust that community: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    registerToolCompat(
      server,
      "firestarter_set_market_picks",
      {
        description: "Curate the shelf ('Recommends') for a community market you own — the products buyers see first on your join page and in the agent (firestarter_market_preview / firestarter_join_market). Picks are OTHER sellers' listings you recommend; your OWN listings already appear under what you sell and are rejected here. Up to 15 picks. Use when an owner wants to add, remove, reorder, or replace what their community recommends. Takes listing ids (lst_..., as returned by firestarter_catalog_search). `action`: 'replace' (default — the picks you pass become the exact shelf, in the order given), 'add' (append to the current shelf), or 'remove' (drop the given listing ids). Each pick may carry a short `note` ('why I picked it') that buyers see.",
        inputSchema: {
        program_id: z.string().describe("The market/program id (from firestarter_create_market or firestarter_my_markets)."),
        picks: z.array(z.object({
          listing_id: z.string().describe("A listing id (lst_...) to feature. Must be another seller's listing — not your own."),
          note: z.string().max(140).optional().describe("Optional short 'why I picked it' shown to buyers."),
          min_tier: z.number().int().min(0).max(3).optional().describe("Tier RUNG INDEX needed to see this pick. 0 (default) = everyone, including signed-out visitors. 1+ stages it as an early look for that rung and above — this is how 'members get first look at new picks' works. Set tiers up first with firestarter_set_market_tiers."),
        })).min(1).describe("The picks to set/add/remove. For 'remove', only each listing_id is used."),
        action: z.enum(["replace", "add", "remove"]).optional().describe("replace (default): the picks become the exact shelf, in order. add: append to the current shelf. remove: drop the given listing ids."),
        },
        outputSchema: shelfOutputShape,
        annotations: { title: "Set Market Picks", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        // The owner's confirmation is a shelf, so show the shelf they just built.
        _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
      },
      async ({ program_id, picks, action }: {
        program_id: string;
        picks: Array<{ listing_id: string; note?: string; min_tier?: number }>;
        action?: "replace" | "add" | "remove";
      }) => {
        const mode = action ?? "replace";
        const incoming = picks.map((p) => ({
          listing_id: cleanListingId(p.listing_id),
          note: typeof p.note === "string" ? p.note : null,
          min_tier: typeof p.min_tier === "number" ? p.min_tier : 0,
        }));
        try {
          // The PUT is a wholesale replace-set (matches the web). To offer natural
          // add/remove, fetch the current owner shelf, merge, then replace — the
          // GET is owner-scoped, so a non-owner 404s here just like the PUT would.
          type Pick = { listing_id: string; note: string | null; min_tier: number };
          let desired: Pick[];
          if (mode === "replace") {
            desired = incoming;
          } else {
            const cur = await apiRequest("GET", `/v1/attribution/programs/${encodeURIComponent(program_id)}/picks`);
            const current: Pick[] = (Array.isArray(cur?.picks) ? cur.picks : [])
              .map((p: any) => ({
                listing_id: String(p.listing_id),
                note: typeof p.note === "string" ? p.note : null,
                min_tier: Number.isFinite(Number(p.min_tier)) ? Number(p.min_tier) : 0,
              }));
            if (mode === "add") {
              const byId = new Map(current.map((p) => [p.listing_id, p]));
              for (const p of incoming) {
                const existing = byId.get(p.listing_id);
                // An `add` that names an existing pick updates only what was
                // actually supplied — re-adding to fix a note must not silently
                // un-stage a pick the owner had gated to a tier.
                if (existing) {
                  if (p.note != null) existing.note = p.note;
                  if (p.min_tier > 0) existing.min_tier = p.min_tier;
                } else { const np = { ...p }; current.push(np); byId.set(p.listing_id, np); }
              }
              desired = current;
            } else {
              const drop = new Set(incoming.map((p) => p.listing_id));
              desired = current.filter((p) => !drop.has(p.listing_id));
            }
          }
          const res = await apiRequest("PUT", `/v1/attribution/programs/${encodeURIComponent(program_id)}/picks`, {
            picks: desired.map((p) => ({ listing_id: p.listing_id, note: p.note, min_tier: p.min_tier })),
          });
          const shelf: any[] = Array.isArray(res?.picks) ? res.picks : [];
          if (shelf.length === 0) {
            return {
              content: [{ type: "text" as const, text: "**Shelf cleared.** Your market now recommends no products — buyers see the plain catalog framing. Add some with action:'add'." }],
              structuredContent: toShelfStructured({ picks: [] }),
            };
          }
          const lines = shelf.map((p) => {
            const nm = typeof p.product_name === "string" && p.product_name.trim() ? p.product_name.trim() : "Untitled";
            const price = Number.isFinite(Number(p.price)) ? `$${Number(p.price).toFixed(2)}` : "price at checkout";
            const note = typeof p.note === "string" && p.note.trim() ? ` — "${p.note.trim()}"` : "";
            // Name the gate explicitly: an owner who staged a pick and then can't
            // see it on the public page should be told why, not left guessing.
            const gate = Number(p.min_tier) > 0 ? ` [tier ${p.min_tier}+ only]` : "";
            return `• ${nm} — ${price}${note}${gate}`;
          });
          return {
            content: [{ type: "text" as const, text: `**Shelf updated — ${shelf.length} pick${shelf.length === 1 ? "" : "s"}** (buyers see these on your join page and in the agent):\n${lines.join("\n")}` }],
            // The owner sees the shelf they just built, photos and all.
            structuredContent: toShelfStructured({ picks: shelf }),
          };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "OWN_LISTING_PICK") {
            return { content: [{ type: "text" as const, text: `Those include your OWN listings — they already appear under what you sell, so they can't go on the recommends shelf. ${toErrorMessage(err)}` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "UNPICKABLE_LISTING") {
            return { content: [{ type: "text" as const, text: `Some listings can't be featured — each must be an active, in-stock listing in the same environment (test vs live) as your API key: ${toErrorMessage(err)}` }], isError: true };
          }
          if (err instanceof ApiError && err.code === "TOO_MANY_PICKS") {
            return { content: [{ type: "text" as const, text: "A shelf holds at most 15 listings — trim the list and try again." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "PROGRAM_NOT_FOUND") {
            return { content: [{ type: "text" as const, text: "No market on your account has that program id. List yours with firestarter_my_markets." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't update the shelf: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_connect_payouts",
      "Connect a Stripe payout account so a community-market owner can WITHDRAW their accrued earnings. Earnings accrue with no Stripe needed — creating a market and earning a share works from any country — but PAYING OUT requires this. Returns a Stripe onboarding link for the owner to open in a browser; once they finish, payouts enable. Use when an owner asks to get paid, cash out, set up payouts, or connect Stripe. If already fully set up, it just says so. Optionally pass the owner's country (ISO-3166-1 alpha-2) if onboarding asks.",
      {
        country: z.string().length(2).optional().describe("Owner's 2-letter country code (ISO-3166-1 alpha-2), e.g. 'US', 'GB'. Only needed if onboarding asks."),
      },
      // Same reasoning as firestarter_payouts: sets the destination that market
      // earnings are cashed out to.
      { title: "Connect Payout Account", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async ({ country }) => {
        try {
          const status = await apiRequest("GET", "/v1/attribution/connect/status");
          if (status?.connected === true && status?.payouts_enabled === true) {
            return { content: [{ type: "text" as const, text: "**Payouts are already set up.** Your accrued market earnings pay out to your connected account. See balances with firestarter_market_earnings." }] };
          }
          const res = await apiRequest("POST", "/v1/attribution/connect", country ? { country: country.toUpperCase() } : {});
          const url = res?.onboarding_url;
          if (!url) {
            return { content: [{ type: "text" as const, text: "Started payout setup, but no onboarding link was returned. Try again shortly." }], isError: true };
          }
          const resuming = res?.existing === true;
          return { content: [{ type: "text" as const, text: `**${resuming ? "Finish setting up payouts" : "Set up payouts"}:** open this link to ${resuming ? "complete" : "connect"} your Stripe account —\n${url}\n\nEarnings keep accruing meanwhile; once Stripe onboarding is complete, payouts enable automatically. Call this tool again to check status.` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "INVALID_COUNTRY") {
            return { content: [{ type: "text" as const, text: "That country code isn't valid — use a 2-letter ISO code like 'US' or 'GB'." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't start payout setup: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    // ── Owner-funded drop wallet (Phase B) ──
    // A prepaid balance an owner deposits and draws down to self-fund drops on
    // firestarter_create_drop: when the wallet covers the whole pot (max_claims x
    // discount) the drop goes live immediately with NO seller approval, because
    // the owner — not the seller — is paying for the discount. Distinct from
    // firestarter_connect_payouts (a Stripe Connect account for CASHING OUT
    // market-fee earnings); this wallet is money IN (deposit) that funds drops,
    // with cash-out of the unused balance via firestarter_withdraw_wallet.

    server.tool(
      "firestarter_fund_wallet",
      "Deposit money into your drop wallet via Stripe Checkout — the prepaid balance that self-funds drops you create (firestarter_create_drop). Once a drop's whole pot (max_claims x discount) is covered by your wallet balance, it goes LIVE IMMEDIATELY with no seller approval needed, because you're paying for the discount yourself rather than asking the seller to eat it. $1.00 minimum deposit. Returns a Stripe Checkout link to open in a browser; the wallet credits once payment completes (the credit shows up in firestarter_wallet_balance). Use when an owner asks to fund/top up/add money to their drop wallet.",
      {
        amount_cents: z.number().int().min(100).describe("Amount to deposit, in cents. Minimum 100 ($1.00)."),
      },
      { title: "Add Funds to Wallet", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ amount_cents }) => {
        try {
          const res = await apiRequest("POST", "/v1/drops/wallet/deposit", { amount_cents });
          const url = res?.url;
          if (!url) {
            return { content: [{ type: "text" as const, text: "Started a deposit, but no Checkout link was returned. Try again shortly." }], isError: true };
          }
          const dollars = (amount_cents / 100).toFixed(2);
          return {
            content: [{
              type: "text" as const,
              text: `**Fund your drop wallet:** open this link to deposit $${dollars} via Stripe Checkout —\n${url}\n\nOnce it clears, drops you create that draw fully on this balance go live immediately — self-funded, no seller approval needed. Check the credited balance with firestarter_wallet_balance.`,
            }],
          };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "INVALID_AMOUNT") {
            return { content: [{ type: "text" as const, text: "Deposits need to be at least $1.00 — pass amount_cents of 100 or more." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't start the deposit: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_wallet_balance",
      "Show your drop wallet's balance: the spendable balance (available to fund new drops or withdraw), funds reserved against live self-funded drops that have been claimed but not yet released to the seller, funds already spent (paid out to sellers for claims that converted into a completed purchase), and lifetime totals deposited and withdrawn. Use when an owner asks what's in their drop wallet, before firestarter_withdraw_wallet, or to check whether a firestarter_fund_wallet deposit has cleared yet. Read-only.",
      {},
      { title: "Check Wallet Balance", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/drops/wallet");
          const balance = ((Number(res?.balance_cents) || 0) / 100).toFixed(2);
          const reserved = ((Number(res?.reserved_cents) || 0) / 100).toFixed(2);
          const spent = ((Number(res?.spent_cents) || 0) / 100).toFixed(2);
          const deposited = ((Number(res?.deposited_cents) || 0) / 100).toFixed(2);
          const withdrawn = ((Number(res?.withdrawn_cents) || 0) / 100).toFixed(2);
          return {
            content: [{
              type: "text" as const,
              text: `**Drop wallet: $${balance} spendable**\nReserved for live drops (claimed, not yet released to the seller): $${reserved}\nSpent (paid out to sellers for completed drop purchases): $${spent}\nLifetime deposited: $${deposited} · Lifetime withdrawn: $${withdrawn}\n\nTop up with firestarter_fund_wallet; cash out the spendable balance with firestarter_withdraw_wallet.`,
            }],
          };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't fetch your wallet balance: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_withdraw_wallet",
      "Cash out unused drop-wallet balance to your connected Stripe payout account (from firestarter_connect_payouts). Only your SPENDABLE balance can be withdrawn — funds reserved against live, unreleased claims on your self-funded drops aren't withdrawable until those claims resolve; firestarter_wallet_balance shows the split. $1.00 minimum. Not idempotent: each call is an INDEPENDENT withdrawal attempt, never a deduped replay of a prior call, so two calls withdraw twice — including a retry after a timeout or error whose outcome is unknown. A completed withdrawal reduces the balance reported by firestarter_wallet_balance, which is how an uncertain outcome is distinguished from a failed one before any further withdrawal.",
      {
        amount_cents: z.number().int().min(100).describe("Amount to withdraw, in cents. Minimum 100 ($1.00)."),
      },
      { title: "Withdraw Wallet Balance", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async ({ amount_cents }) => {
        // A fresh key per logical withdrawal, generated once here (not inside any
        // retry loop) so a lost-response HTTP retry of THIS call reuses the same
        // key and dedupes server-side (services/owner-drop-wallet.ts) instead of
        // paying the owner out twice.
        // node:crypto import, not the `crypto` global — the global does not
        // exist on Node 18, which engines allows (audit 2026-08 #13).
        const idempotencyKey = randomUUID();
        try {
          const res = await apiRequest(
            "POST",
            "/v1/drops/wallet/withdraw",
            { amount_cents },
            undefined,
            { "Idempotency-Key": idempotencyKey },
          );
          const dollars = (amount_cents / 100).toFixed(2);
          const balance = ((Number(res?.balance_cents) || 0) / 100).toFixed(2);
          return { content: [{ type: "text" as const, text: `**Withdrew $${dollars}** to your connected payout account. New drop-wallet balance: $${balance} spendable.` }] };
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "INVALID_AMOUNT") {
            return { content: [{ type: "text" as const, text: "Withdrawals need to be at least $1.00 — pass amount_cents of 100 or more." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "INSUFFICIENT_FUNDS") {
            return { content: [{ type: "text" as const, text: "You can only withdraw your spendable balance — reserved funds for live drops aren't withdrawable. Check firestarter_wallet_balance." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "NOT_CONNECTED") {
            return { content: [{ type: "text" as const, text: "Connect a payout account first — firestarter_connect_payouts." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "PREVIOUS_ATTEMPT_FAILED") {
            return { content: [{ type: "text" as const, text: "That withdrawal was already attempted and failed; check your balance and try a fresh withdrawal." }], isError: true };
          }
          if (err instanceof ApiError && err.code === "STRIPE_ERROR") {
            return { content: [{ type: "text" as const, text: "Temporary payout issue — check your balance; if it didn't arrive, retry." }], isError: true };
          }
          return { content: [{ type: "text" as const, text: `Couldn't withdraw: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    registerToolCompat(
      server,
      "firestarter_market_preview",
      {
        description: "Preview a community market BEFORE joining — read-only, no join. Given a share code or vanity handle, returns what a signed-out visitor sees on firestarter.network/m/<handle>: the community name, tagline, its curated shelf (the owner's picks of OTHER sellers' products), and what the community itself sells (its own listings) — every item with a listing_id that firestarter_execute accepts for purchase. Use when a buyer pastes a market code/link or asks 'what is this community / what do they recommend / what's in this market' — the preview shows both surfaces before any commitment, and joining (firestarter_join_market) remains a separate optional step; items are buyable without joining. JOINING itself gives the buyer no automatic discount or cashback — their price is unchanged and the community earns a share of Firestarter's platform fee at no extra cost to the buyer, never from the seller's payout; the buyer's benefit is curation and supporting the community. A community MAY separately fund drops (real discounts the buyer claims before checkout) and reward members with tiered early access; both appear in the preview when present — joining alone still grants no discount.",
        inputSchema: {
          code: z.string().describe("The community's share code or vanity handle (e.g. the <code> in firestarter.network/m/<code>)."),
        },
        outputSchema: shelfOutputShape,
        annotations: { title: "Market Preview", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        // MCP Apps: the shelf is a product list, so render it as the same grid
        // the catalog uses — with the photos the prose render never showed.
        _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
      },
      async ({ code }: { code: string }) => {
        const cleaned = code.trim();
        const community = await fetchPublicCommunity(apiRequest, cleaned);
        if (!community) {
          return { content: [{ type: "text" as const, text: `Couldn't find a community market for \`${cleaned}\`. Double-check the code or link.` }], isError: true };
        }
        const name = typeof community.name === "string" && community.name.trim() ? community.name.trim() : "This community";
        const parts: string[] = [`**${name}**`];
        if (typeof community.tagline === "string" && community.tagline.trim()) parts.push(community.tagline.trim());
        if (community.active === false) {
          parts.push("\n_This community link isn't accepting new members right now._");
        }
        // Both product surfaces, labelled — what the community RECOMMENDS (the
        // curated shelf) and what it SELLS (its own listings). Rendering only
        // the shelf made a seller-owned community with an empty shelf preview
        // as an empty market even though its own products were live.
        const shelf = formatCommunityShelf(community);
        const sells = formatCommunitySells(community);
        if (shelf) parts.push("\n" + shelf);
        if (sells) parts.push("\n" + sells);
        if (!shelf) {
          parts.push("\n" + (sells
            ? `_${name} hasn't curated a Recommends shelf of other sellers' products yet._`
            : `${name} hasn't curated a shelf yet — you can still shop the full Firestarter catalog while supporting them.`));
        }
        const offers = formatCommunityOffers(community);
        if (offers) parts.push("\n" + offers);
        if (community.active !== false) {
          parts.push(
            `\nTo join: firestarter_join_market with code \`${cleaned}\`. Your future buys then credit ${name} at no extra cost to you (your price is unchanged; the value is the curation and supporting them). You can switch communities anytime.`,
          );
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          structuredContent: toShelfStructured(community),
        };
      }
    );

    server.tool(
      "firestarter_discover_markets",
      "Browse public community markets a buyer can join (the 'Discover communities' list): each one's name, tagline, community URL/handle, join code, and social proof (members, orders driven). Use when a buyer asks what communities exist, wants to find one to support, or says 'discover community markets'. To see a specific community's curated shelf use firestarter_market_preview; to join one use firestarter_join_market with its code. Read-only, public — no sign-in needed.",
      {
        limit: z.number().int().min(1).max(24).optional().describe("Max communities to return (default 12, max 24)."),
      },
      { title: "Discover Markets", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      async ({ limit }) => {
        try {
          const qs = limit ? `?limit=${Math.max(1, Math.min(24, Math.floor(limit)))}` : "";
          const res = await apiRequest("GET", `/marketplace/communities${qs}`);
          const communities: any[] = Array.isArray(res?.communities) ? res.communities : [];
          if (communities.length === 0) {
            return { content: [{ type: "text" as const, text: "No public community markets to show right now. If you have a specific share code, join it with firestarter_join_market." }] };
          }
          const blocks = communities.map((c) => {
            const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : "A community";
            const url = c.slug ? `${MARKET_LINK_BASE}/${c.slug}` : c.code ? `${MARKET_LINK_BASE}/${c.code}` : null;
            const proof = [
              c.member_count_bucket && c.member_count_bucket !== "0" ? `${c.member_count_bucket} members` : null,
              c.order_count_bucket && c.order_count_bucket !== "0" ? `${c.order_count_bucket} orders driven` : null,
            ].filter(Boolean).join(" · ");
            const lines = [`**${name}**${c.tagline ? ` — ${c.tagline}` : ""}`];
            if (url) lines.push(mdUrlLink(url) ?? url);
            if (c.code) lines.push(`Join code: \`${c.code}\``);
            if (proof) lines.push(proof);
            return lines.join("\n");
          });
          return { content: [{ type: "text" as const, text: `**Community markets (${communities.length}):**\n\n${blocks.join("\n\n")}\n\nPreview one with firestarter_market_preview, or join with firestarter_join_market and its code.` }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't load community markets: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    registerToolCompat(
      server,
      "firestarter_join_market",
      {
        description: "Join a community market using its share code, so the caller's purchases (and, when enabled, their sales) are attributed to that community and it earns its share. Joining REPLACES any community the buyer already supports — their attribution moves to the new community for all future orders. Use when a user pastes a Firestarter join/market code or asks to join a community's market. The community's picks are visible before joining via firestarter_market_preview.",
        inputSchema: {
          code: z.string().describe("The market share code the community gave you."),
        },
        outputSchema: shelfOutputShape,
        // Redirects fee attribution for every future order, and silently REPLACES
        // any community the buyer already supports. The description states the
        // replacement fact; destructiveHint is what gates it on confirmation.
        annotations: { title: "Join Market", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
      },
      async ({ code }: { code: string }) => {
        try {
          const res = await apiRequest("POST", "/v1/attribution/redeem", { code });
          let text =
            res.idempotent
              ? "You're already in this market — nothing changed."
              : res.replaced
                ? "Switched — your buys now credit this market."
                : "**Joined the market.** Your future buys (and sells, when that's enabled) credit this community.";
          // Turn a successful join into an actionable welcome: greet the buyer,
          // then lead with what the community recommends via the shared shelf
          // renderer (so join / preview / my_market read identically, each pick
          // carrying its listing_id for firestarter_execute). Best-effort — a
          // public-page miss must never undo or misreport a completed join.
          const community = await fetchPublicCommunity(apiRequest, code.trim());
          if (community?.name) {
            text += `\n\n**Welcome to ${community.name}.**`;
            if (community.tagline) text += `\n${community.tagline}`;
            const shelf = formatCommunityShelf(community);
            const sells = formatCommunitySells(community);
            if (shelf) text += `\n\n${shelf}`;
            if (sells) text += `\n\n${sells}`;
            if (!shelf && !sells) {
              // Neither surface has products yet: point at what the community
              // deals in, or a generic next step, so the buyer still has
              // somewhere to go.
              const categories = Array.isArray(community.top_categories) ? community.top_categories.slice(0, 3) : [];
              text += categories.length > 0
                ? `\n\nPopular here: ${categories.join(", ")}. Next: search this market for something you need, then review the quote before approving.`
                : "\n\nNext: search this market for something you need, then review the quote before approving a purchase.";
            }
            const offers = formatCommunityOffers(community);
            if (offers) text += `\n\n${offers}`;
          }
          return {
            content: [{ type: "text" as const, text }],
            // `community` is null when the best-effort public-page fetch failed;
            // the mapper degrades that to an empty grid rather than letting a
            // completed join fail schema validation.
            structuredContent: toShelfStructured(community),
          };
        } catch (err: any) {
          const msg = toErrorMessage(err);
          return { content: [{ type: "text" as const, text: `Couldn't join: ${msg}` }], isError: true };
        }
      }
    );

    registerToolCompat(
      server,
      "firestarter_my_market",
      {
        description: "Show which community market the buyer is currently connected to (if any): the community name, join code, program status, AND its products — what the community recommends (its curated shelf) and what it sells (its own listings), each buyable via firestarter_execute. Use when a buyer asks 'what market am I in?', 'am I connected to a community?', 'what can I buy here?', or before joining/leaving so you can confirm the current state — it doubles as a re-discovery of the community's picks. Read-only.",
        inputSchema: {},
        outputSchema: shelfOutputShape,
        annotations: { title: "My Market", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
      },
      async () => {
        try {
          const res = await apiRequest("GET", "/v1/attribution/me");
          const community = res?.community ?? null;
          if (!community || community.connected !== true) {
            return {
              content: [{ type: "text" as const, text: "You're not connected to any community market. Paste a share code and I can join one for you (firestarter_join_market)." }],
              structuredContent: toShelfStructured(null),
            };
          }
          // Standing in this community. Best-effort and rendered only when the
          // owner has tiers on — a community that hasn't turned them on should
          // read exactly as it did before, with no empty "Tier: —" line.
          let tier: any = null;
          try {
            tier = (await apiRequest("GET", "/v1/attribution/tier"))?.tier ?? null;
          } catch { /* standing is a bonus; the status below stands alone */ }

          const lines = [
            `**Connected to:** ${community.name}`,
            community.code ? `Join code: \`${community.code}\`` : null,
            `Status: ${community.program_status}`,
            tier
              ? `**Tier: ${tier.name}** · ${tier.qualifying_orders} qualifying order${tier.qualifying_orders === 1 ? "" : "s"} in the last 12 months`
              : null,
            tier?.next
              ? `${tier.next.orders_needed} more to reach ${tier.next.name}`
              : tier
                ? "Top tier — nothing above this one."
                : null,
            community.attributed_at ? `Joined: ${new Date(community.attributed_at).toISOString().slice(0, 10)}` : null,
            res?.referral_url
              ? `\n**Your referral link:** ${res.referral_url}\nShare it — when someone you bring joins and makes a qualifying purchase, it counts toward your tier.`
              : null,
            "\nYour buys (and sells, when enabled) credit this community. To leave, use firestarter_leave_market.",
          ].filter(Boolean);
          // Re-discovery: append the community's current shelf so "what market am
          // I in?" also answers "what can I buy here?". Best-effort — the status
          // above stands on its own if the public view can't be fetched.
          const publicView = community.code ? await fetchPublicCommunity(apiRequest, community.code) : null;
          const shelf = publicView ? formatCommunityShelf(publicView) : null;
          const sells = publicView ? formatCommunitySells(publicView) : null;
          const offers = publicView ? formatCommunityOffers(publicView, tier?.index ?? null) : null;
          const text = lines.join("\n")
            + (shelf ? `\n\n${shelf}` : "")
            + (sells ? `\n\n${sells}` : "")
            + (offers ? `\n\n${offers}` : "");
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: toShelfStructured(publicView),
          };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Couldn't check your market: ${toErrorMessage(err)}` }], isError: true };
        }
      }
    );

    server.tool(
      "firestarter_leave_market",
      "Disconnect (delink) the buyer from their current community market so future orders no longer credit it. Use when a buyer asks to leave/disconnect a community, or wants to switch to another one. Already-earned credit on past orders still clears; only future activity stops being attributed. This is an account-level change.",
      {},
      // Account-level change; the description says to confirm before calling.
      { title: "Leave Market", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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

  // Last, once every tool is registered: re-stamp the advertised schemas with
  // MCP's 2020-12 dialect. The SDK hardcodes draft-07 and exposes no way to ask
  // for anything else, and a host that validates against the spec dialect
  // rejects the tool outright (#736).
  enforceSchemaDialect(server);
}
