#!/usr/bin/env node
/**
 * End-to-end seller sweep: drive the BUILT bundle (mcpb/build/server/index.mjs)
 * over real stdio JSON-RPC, against an in-process mock of the commerce API
 * whose response shapes mirror apps/api (listing-gates, handleImageUpload,
 * errorResponse). The widget's exact call sequence is replayed by hand — the
 * same upload → attach → activate order uploader.client.ts performs — so this
 * covers the full chain the seller experiences minus the iframe itself (the
 * iframe's own wiring is pinned by tests/unit/uploader-widget-dom.test.ts).
 *
 * What the mock enforces, copied from the real API's behavior:
 *  - POST /v1/listings: draft + activation_blocked [NEEDS_IMAGE] when no
 *    photo; VERIFICATION_REQUIRED block at >= $500 (listing-gates.ts).
 *  - PATCH into status "active" re-checks the gates WHOLESALE — a blocked
 *    activation is a 400 and nothing else in the PATCH lands (listings.ts).
 *  - POST /v1/sellers/upload-image: rejects a JPEG data-URI without its EOI
 *    marker, like isCompleteImage (#958/#994).
 *
 * Run: node scripts/e2e-seller-sweep.mjs   (needs npm run build:mcpb first)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "mcpb", "build", "server", "index.mjs");
if (!existsSync(entry)) {
  console.error(`No built server at ${entry} — run \`npm run build:mcpb\` (or its esbuild step) first.`);
  process.exit(1);
}

// A real 1x1 JPEG (SOI … EOI), small enough to read in a test log.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
const TINY_JPEG_DATA_URI = `data:image/jpeg;base64,${TINY_JPEG_B64}`;
// The same JPEG with its tail cut off — no EOI marker (the #958 shape).
const TRUNCATED_JPEG_DATA_URI = `data:image/jpeg;base64,${TINY_JPEG_B64.slice(0, TINY_JPEG_B64.length - 8)}`;

// ── Mock commerce API ────────────────────────────────────────────────────────
const listings = new Map();
let listingSeq = 0;
const apiCalls = [];

function activationBlocks(l) {
  const blocks = [];
  if (!(l.images?.length) && !l.allow_imageless) blocks.push({ code: "NEEDS_IMAGE", message: "Add at least one product photo." });
  if (l.requires_verification && !l.verified) blocks.push({ code: "VERIFICATION_REQUIRED", message: "Possession verification required: photo of the item with code FS-1234." });
  return blocks;
}

function listingJson(l) {
  const blocks = activationBlocks(l);
  return {
    id: l.id,
    product_name: l.product_name,
    base_price: l.base_price,
    status: l.status,
    images: l.images,
    inventory_qty: l.inventory_qty,
    activation_blocked: l.status === "draft" ? blocks : [],
    activation_warnings: [],
    share_url: l.status === "active" ? `https://firestarter.network/l/${l.id}` : null,
  };
}

function hostedUrl(base, bytes) {
  return `${base}/v1/img/${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
}

const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    apiCalls.push({ method: req.method, url: req.url, body });
    const send = (status, json) => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json)); };
    const base = `http://127.0.0.1:${api.address().port}`;

    if (req.method === "POST" && req.url === "/v1/listings") {
      const l = {
        id: `lst_e2e${++listingSeq}`,
        product_name: body.product_name,
        base_price: body.base_price,
        images: (body.images ?? []).map((u) => (u.startsWith(`${base}/v1/img/`) ? u : hostedUrl(base, u))),
        inventory_qty: body.inventory_qty,
        allow_imageless: body.allow_imageless === true,
        requires_verification: body.base_price >= 500,
        verified: false,
      };
      l.status = activationBlocks(l).length ? "draft" : "active";
      listings.set(l.id, l);
      return send(200, listingJson(l));
    }
    const idMatch = /^\/v1\/listings\/(lst_[A-Za-z0-9]+)$/.exec(req.url ?? "");
    if (idMatch) {
      const l = listings.get(idMatch[1]);
      if (!l) return send(404, { error: "Listing not found", code: "NOT_FOUND" });
      if (req.method === "GET") return send(200, listingJson(l));
      if (req.method === "PATCH") {
        // The real API refuses the WHOLE patch when a transition into active
        // is still gated — nothing else in the body lands (listings.ts:857).
        if (body.status === "active") {
          const preview = { ...l, images: body.images ? body.images.map((u) => (u.startsWith(`${base}/v1/img/`) ? u : hostedUrl(base, u))) : l.images };
          const blocks = activationBlocks(preview);
          if (blocks.length) return send(400, { error: blocks[0].message, code: blocks[0].code });
        }
        if (body.product_name !== undefined) l.product_name = body.product_name;
        if (body.images !== undefined) l.images = body.images.map((u) => (u.startsWith(`${base}/v1/img/`) ? u : hostedUrl(base, u)));
        if (body.inventory_qty !== undefined) l.inventory_qty = body.inventory_qty;
        if (body.allow_imageless !== undefined) l.allow_imageless = body.allow_imageless;
        if (body.status !== undefined) l.status = body.status;
        return send(200, listingJson(l));
      }
    }
    if (req.method === "POST" && req.url === "/v1/sellers/upload-image") {
      if (body.image_url) return send(200, { url: hostedUrl(base, body.image_url) });
      if (!body.image_base64) return send(400, { error: "No image provided", code: "NO_IMAGE" });
      const b64 = String(body.image_base64).includes(",") ? String(body.image_base64).split(",", 2)[1] : String(body.image_base64);
      const bytes = Buffer.from(b64, "base64");
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const jpegComplete = bytes.length >= 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      if (isJpeg && !jpegComplete) {
        return send(400, { error: "The image data arrived incomplete — the file was cut short in transit and would render broken.", code: "INVALID_IMAGE" });
      }
      if (!isJpeg && !isPng) return send(400, { error: "Not a supported image", code: "INVALID_IMAGE" });
      return send(200, { url: hostedUrl(base, bytes) });
    }
    send(404, { error: `mock: unhandled ${req.method} ${req.url}`, code: "NOT_FOUND" });
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API_BASE = `http://127.0.0.1:${api.address().port}`;

// ── Spawn the bundled server ────────────────────────────────────────────────
const child = spawn("node", [entry], {
  env: { ...process.env, FIRESTARTER_API_KEY: "fs_test_e2e_sweep", FIRESTARTER_API_URL: API_BASE },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let rpcId = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, resolvePromise);
    setTimeout(() => { if (pending.delete(id)) rejectPromise(new Error(`rpc timeout: ${method}`)); }, 30_000);
    child.stdin.write(JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args ?? {} });
  if (r.error) throw new Error(`${name}: transport error ${JSON.stringify(r.error)}`);
  const out = r.result;
  out.text = (out.content ?? []).map((c) => c.text ?? "").join(" ");
  return out;
};

// ── Assertions ──────────────────────────────────────────────────────────────
let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log(`✓ ${what}`);
  else { failures++; console.error(`✗ ${what}`); }
};

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-sweep", version: "1.0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// A. Tool surface
{
  const tools = (await rpc("tools/list")).result.tools;
  const upload = tools.find((t) => t.name === "firestarter_upload_image");
  const list = tools.find((t) => t.name === "firestarter_list");
  const update = tools.find((t) => t.name === "firestarter_update_listing");
  ok(!!upload?.inputSchema?.properties?.image_path, "A1 local build advertises image_path");
  ok(upload?._meta?.["openai/widgetAccessible"] === true && update?._meta?.["openai/widgetAccessible"] === true,
    "A2 upload_image + update_listing are widget-accessible");
  for (const [label, t] of [["upload_image", upload], ["list", list], ["update_listing", update]]) {
    ok(String(t?._meta?.ui?.resourceUri).endsWith("/v9"), `A3 ${label} points at the v9 widget`);
  }
  ok(/EXCEPTION.*ALREADY displays/s.test(upload?.description ?? ""), "A4 upload_image description warns against the duplicate zone");
}

// B+C. The happy path, exactly as the seller sees it
let lampId;
{
  const created = await call("firestarter_list", { product_name: "E2E Walnut Desk Lamp", base_price: 89.5 });
  const sc = created.structuredContent ?? {};
  lampId = sc.listing?.id;
  ok(!created.isError && sc.listing?.status === "draft", "B1 photoless create saves as draft");
  ok(sc.upload_request?.listing_id === lampId && sc.upload_request?.activate === true,
    "B2 draft reply carries the drop zone request with activate=true");
  ok(/END YOUR TURN/.test(created.text) && /Do NOT call firestarter_upload_image/.test(created.text),
    "B3 draft reply STOPS the model instead of offering a second tool call");
  ok(!/if no drop zone is visible[^.]*call/i.test(created.text), "B4 no conditional call-me instruction remains");

  // The widget's exact sequence: upload → attach → activate.
  const up = await call("firestarter_upload_image", { image_base64: TINY_JPEG_DATA_URI, filename: "lamp.jpg" });
  const url = up.structuredContent?.url;
  ok(!up.isError && /^http/.test(url ?? ""), "C1 widget upload returns the hosted URL in structuredContent");
  const attach = await call("firestarter_update_listing", { listing_id: lampId, image_urls: [url] });
  ok(!attach.isError, "C2 attach (image_urls only) succeeds");
  const act = await call("firestarter_update_listing", { listing_id: lampId, status: "active" });
  ok(!act.isError, "C3 activation succeeds once the photo is attached");
  ok(listings.get(lampId)?.status === "active" && listings.get(lampId)?.images.length === 1,
    "C4 mock store agrees: live with 1 photo");
  ok(!(act.structuredContent ?? {}).upload_request, "C5 the active listing's reply carries no drop zone");
}

// D. Create with a photo → live immediately, card not drop zone
{
  const r = await call("firestarter_list", { product_name: "E2E Pour-Over Kettle", base_price: 39, image_urls: ["https://cdn.example/kettle.jpg"] });
  const sc = r.structuredContent ?? {};
  ok(sc.listing?.status === "active" && !sc.upload_request, "D1 create-with-photo goes live, no drop zone");
  ok(typeof sc.listing?.share_url === "string" && sc.listing.share_url.includes("/l/"), "D2 live listing card carries the share link");
}

// E. Standalone drop zone
{
  const before = apiCalls.length;
  const r = await call("firestarter_upload_image", {});
  ok(!r.isError && r.structuredContent?.upload_request && apiCalls.length === before,
    "E1 bare call shows the drop zone without touching the API");
  ok(/END YOUR TURN/.test(r.text), "E2 standalone drop-zone reply also stops the model");
}

// F+G. Drop zone primed from the listing
{
  const draft = await call("firestarter_list", { product_name: "E2E Ceramic Mug", base_price: 18 });
  const mugId = draft.structuredContent.listing.id;
  const r = await call("firestarter_upload_image", { listing_id: mugId });
  const req = r.structuredContent?.upload_request ?? {};
  ok(req.listing_id === mugId && req.activate === true && Array.isArray(req.existing_image_urls) && req.existing_image_urls.length === 0,
    "F1 photoless draft primes an empty gallery with activate=true");
  ok(req.product_name === "E2E Ceramic Mug", "F2 product name primed from the listing");

  const live = await call("firestarter_upload_image", { listing_id: lampId });
  const req2 = live.structuredContent?.upload_request ?? {};
  ok(req2.activate === false && req2.existing_image_urls?.length === 1,
    "G1 active listing primes its existing gallery with activate=false (attach only)");
}

// H. image_path — the Claude Desktop local path
{
  const dir = mkdtempSync(join(tmpdir(), "e2e-sweep-"));
  try {
    const png = join(dir, "photo.png");
    writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128)]));
    const r = await call("firestarter_upload_image", { image_path: png });
    ok(!r.isError && /^http/.test(r.structuredContent?.url ?? ""), "H1 image_path reads the file and returns the hosted URL");

    const missing = await call("firestarter_upload_image", { image_path: join(dir, "nope.jpg") });
    ok(missing.isError && /could not read/i.test(missing.text), "H2 missing file → clean error");

    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(7 * 1024 * 1024)]));
    const tooBig = await call("firestarter_upload_image", { image_path: big });
    ok(tooBig.isError && /6 MB/.test(tooBig.text), "H3 oversized file → clean error naming the limit");

    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "not an image");
    const bad = await call("firestarter_upload_image", { image_path: txt });
    ok(bad.isError && /not a supported image/i.test(bad.text), "H4 non-image file → clean error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// I. image_url spine unchanged
{
  const r = await call("firestarter_upload_image", { image_url: "https://cdn.example/existing.jpg" });
  ok(!r.isError && /^http/.test(r.structuredContent?.url ?? ""), "I1 image_url still re-hosts and returns the URL");
}

// J. Truncated base64 → the error hands the agent the drop zone, not a retry
{
  const r = await call("firestarter_upload_image", { image_base64: TRUNCATED_JPEG_DATA_URI });
  ok(r.isError && /incomplete|cut short/i.test(r.text), "J1 truncated base64 is refused");
  ok(/NO image/.test(r.text) && /drop zone/i.test(r.text), "J2 the failure text redirects to the drop zone");
}

// K. Activation refused (verification gate): the widget order keeps the photos
{
  const r = await call("firestarter_list", { product_name: "E2E Vintage Watch", base_price: 900 });
  const sc = r.structuredContent ?? {};
  const watchId = sc.listing.id;
  ok(sc.upload_request?.activate === false, "K1 a draft with a second gate does NOT ask the widget to activate");

  // Widget replay: attach only (activate=false), then a deliberate activation
  // attempt to confirm the refusal path reads well and loses nothing.
  const up = await call("firestarter_upload_image", { image_base64: TINY_JPEG_DATA_URI });
  const attach = await call("firestarter_update_listing", { listing_id: watchId, image_urls: [up.structuredContent.url] });
  ok(!attach.isError, "K2 attach succeeds despite the verification gate");
  const act = await call("firestarter_update_listing", { listing_id: watchId, status: "active" });
  ok(act.isError && /verification/i.test(act.text), "K3 activation refusal names the verification gate");
  ok(listings.get(watchId)?.images.length === 1, "K4 the refused activation did not cost the photo");
}

// L. Removing every photo from a live listing brings the drop zone back
{
  const r = await call("firestarter_update_listing", { listing_id: lampId, image_urls: [] });
  const sc = r.structuredContent ?? {};
  ok(!!sc.upload_request && sc.upload_request.activate === false, "L1 emptied gallery re-offers the drop zone (attach-only)");
  ok(/DROP ZONE/.test(r.text) && /do NOT call firestarter_upload_image/i.test(r.text),
    "L2 …and the text stops the model from double-asking");
}

// M. Oversized base64 rejected client-side, before the API
{
  const before = apiCalls.length;
  const r = await call("firestarter_upload_image", { image_base64: `data:image/jpeg;base64,${"A".repeat(9 * 1024 * 1024)}` });
  ok(r.isError && /too large/i.test(r.text) && apiCalls.length === before, "M1 >6MB base64 refused without an API round-trip");
}

child.kill();
api.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nSeller sweep passed — every flow clean");
process.exit(failures ? 1 : 0);
