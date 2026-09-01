// @vitest-environment jsdom
/**
 * The drop zone wired to the REAL tool handler.
 *
 * Every other test of this path fakes one half: the widget tests answer
 * `callToolFull` from a script, and the tool tests call the handler with
 * hand-written arguments. Both pass while the two disagree about a NAME — the
 * widget sending `note` where the tool reads `dispute_note` is a real mistake
 * that got through exactly that gap during development, caught only because a
 * test happened to assert the argument rather than the outcome.
 *
 * So this wires them together: the widget's bridge calls the tool handler
 * registered by registerTools, and only `fetch` is mocked. What it proves is
 * the thing neither half can prove alone — that a file dropped in the browser
 * reaches the right API endpoint, with the right body, for every mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderUploader } from "../../src/mcp/ui/uploader.client.js";
import type { Host } from "../../src/mcp/ui/host.client.js";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

type RecordedCall = { method: string; url: string; body: any };

function installFetch(respond: (method: string, url: string, body: any) => { status: number; json: any }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const { status, json } = respond(method, String(url), body);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

/** A host whose bridge runs the REAL registered tool, as the live one does. */
function bridgeToRealTools(tools: Record<string, ToolHandler>) {
  const told: string[] = [];
  const host: Host = {
    openLink: () => {},
    callTool: async () => null,
    callToolFull: async (name, args) => {
      const handler = tools[name];
      if (!handler) return null; // the host refuses an unknown/ungated tool
      const res = await handler(args);
      return {
        ok: !res?.isError,
        text: (res?.content ?? []).map((c: any) => c.text).join("\n"),
        structured: res?.structuredContent ?? null,
      };
    },
    tellModel: async (text) => { told.push(text); },
  };
  return { host, told };
}

const imageFile = (name = "photo.jpg") =>
  new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], name, { type: "image/jpeg" });

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById("root")!;
});
afterEach(() => { vi.unstubAllGlobals(); });

async function dropOne(): Promise<void> {
  const input = root.querySelector<HTMLInputElement>("#dzf")!;
  Object.defineProperty(input, "files", { value: [imageFile()], configurable: true });
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() => {
    const s = root.querySelector("#dzs")!.textContent ?? "";
    if (!s || /Uploading|Attaching|Activating|Setting/.test(s)) throw new Error("still busy");
  }, { timeout: 5000 });
}

const HOSTED = "https://api.firestarter.network/v1/img/" + "a".repeat(32);

describe("a dropped file reaches the right endpoint, for every mode", () => {
  it("dispute evidence → attachments then messages, on the buyer surface", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) =>
      url.endsWith("/v1/sellers/upload-image") || url.endsWith("/attachments")
        ? { status: 200, json: { url: HOSTED } }
        : { status: 200, json: { ok: true } });
    const { host, told } = bridgeToRealTools(tools);

    renderUploader(root, { dispute_id: "disp_1", dispute_side: "buyer", dispute_note: "the corner is crushed" }, undefined, () => host);
    await dropOne();

    expect(calls.map((c) => c.url)).toEqual([
      "http://api.test/v1/sellers/upload-image",
      "http://api.test/buyer/disputes/disp_1/attachments",
      "http://api.test/buyer/disputes/disp_1/messages",
    ]);
    // The note the widget carried is the note the thread receives — this is
    // the exact seam a rename breaks, and it is invisible to either half alone.
    expect(calls[2].body).toEqual({ message: "the corner is crushed", attachment_urls: [HOSTED] });
    expect(told.join(" ")).toContain("posted to dispute disp_1");
  });

  it("dispute evidence → the SELLER surface when the zone says seller", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) =>
      url.endsWith("/v1/sellers/upload-image") || url.endsWith("/attachments")
        ? { status: 200, json: { url: HOSTED } }
        : { status: 200, json: { ok: true } });
    const { host } = bridgeToRealTools(tools);

    renderUploader(root, { dispute_id: "disp_1", dispute_side: "seller" }, undefined, () => host);
    await dropOne();

    expect(calls.map((c) => c.url)).toContain("http://api.test/v1/sellers/disputes/disp_1/messages");
    expect(calls.map((c) => c.url)).not.toContain("http://api.test/buyer/disputes/disp_1/messages");
  });

  it("possession evidence → the verification endpoint, and the verdict reaches the model", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) =>
      url.endsWith("/v1/sellers/upload-image")
        ? { status: 200, json: { url: HOSTED } }
        : { status: 200, json: { verification_status: "verified", checked: { item_match: true, code_match: true } } });
    const { host, told } = bridgeToRealTools(tools);

    renderUploader(root, { verify_listing_id: "lst_1", verify_label: "Verification photo" }, undefined, () => host);
    await dropOne();

    expect(calls.map((c) => c.url)).toEqual([
      "http://api.test/v1/sellers/upload-image",
      "http://api.test/v1/listings/lst_1/verification",
    ]);
    expect(calls[1].body).toEqual({ photo_url: HOSTED });
    // The seller cannot act until they know the verdict, so it must survive
    // the trip back rather than being flattened into "1 photo uploaded".
    expect(told.join(" ")).toContain("Verified");
  });

  it("a market avatar → the avatar endpoint, with the URL we just minted", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) =>
      url.endsWith("/v1/sellers/upload-image")
        ? { status: 200, json: { url: HOSTED } }
        : { status: 200, json: { avatar_url: HOSTED, url: HOSTED } });
    const { host } = bridgeToRealTools(tools);

    renderUploader(root, { market_program_id: "apg_1", market_name: "Bike Club" }, undefined, () => host);
    await dropOne();

    expect(calls.map((c) => c.url)).toEqual([
      "http://api.test/v1/sellers/upload-image",
      "http://api.test/v1/attribution/programs/apg_1/avatar",
    ]);
    // The bytes are already stored; only the hosted URL travels on.
    expect(calls[1].body).toEqual({ image_url: HOSTED });
  });

  it("a listing photo → attach, and activation as a SEPARATE call", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) =>
      url.endsWith("/v1/sellers/upload-image")
        ? { status: 200, json: { url: HOSTED } }
        : { status: 200, json: { id: "lst_1", images: [HOSTED], status: "active" } });
    const { host } = bridgeToRealTools(tools);

    renderUploader(root, { listing_id: "lst_1", activate: true, existing_image_urls: [] }, undefined, () => host);
    await dropOne();

    const patches = calls.filter((c) => c.url === "http://api.test/v1/listings/lst_1");
    // Attach first, activate second. One combined PATCH would lose the photos
    // wholesale when an activation gate refuses (commerce#775).
    expect(patches).toHaveLength(2);
    // The tool renames image_urls -> images for the API. That rename is exactly
    // the kind of seam this file exists to pin: both halves are individually
    // right, and only the wired pair shows which name reaches the wire.
    expect(patches[0].body).toMatchObject({ images: [HOSTED] });
    expect(patches[1].body).toMatchObject({ status: "active" });
  });

  it("every tool the widget reaches is one registerTools actually exposes", async () => {
    // A host gates widget-originated calls by name. A widget calling a tool
    // that does not exist fails silently at the bridge, which looks to the
    // seller like a drop that did nothing.
    const tools = captureTools();
    for (const name of [
      "firestarter_upload_image",
      "firestarter_update_listing",
      "firestarter_set_market_avatar",
    ]) {
      expect(tools[name], `${name} is called by the widget but not registered`).toBeTypeOf("function");
    }
  });
});
