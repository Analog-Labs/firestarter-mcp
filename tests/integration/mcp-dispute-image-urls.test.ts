/**
 * commerce#749 — "I was trying to attach image in the dispute using Claude but
 * it was not going through" (Shantanu Upadhyay, Slack).
 *
 * The only photo parameter on firestarter_disputes was `image_base64`, an
 * inline data URI. A buyer's photo arrives in chat as a HOSTED URL, so to fill
 * that parameter the agent had to fetch the image and print a few hundred KB of
 * base64 back out as a tool argument — the "Build data URI" -> "Print data URI
 * for use in tool call" path in the reported screenshot. That does not survive
 * being emitted, so the attach failed and the evidence never reached the
 * dispute.
 *
 * `image_urls` takes the URL the agent already holds; the API ingests it into
 * its own blob store and returns a URL the message endpoint accepts.
 *
 * Same harness as mcp-verify.test.ts: drive the REAL registered handlers
 * against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

type Call = { method: string; url: string; body: any };

function installFetch(respond: (method: string, url: string, body: any) => { status: number; json: any }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const { status, json } = respond(method, String(url), body);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

const DID = "disp_749";
const ATTACH = `http://api.test/buyer/disputes/${DID}/attachments`;
const MESSAGES = `http://api.test/buyer/disputes/${DID}/messages`;
const HOSTED = "https://cole.pocodot.ai/api/poco/uploads/public/560e2dbf.png";
const BLOB = "https://api.firestarter.network/v1/img/" + "a".repeat(32);

/** Happy path: attachments ingest fine, messages accepts. */
function okResponder(minted = BLOB) {
  return (method: string, url: string) => {
    if (url === ATTACH) return { status: 200, json: { url: minted } };
    if (url === MESSAGES) return { status: 200, json: { ok: true } };
    return { status: 200, json: {} };
  };
}

describe("firestarter_disputes message — a hosted photo URL is passed straight through (commerce#749)", () => {
  it("sends the URL to the API instead of demanding a data URI", async () => {
    const calls = installFetch(okResponder());
    const tools = captureTools();

    const res = await tools.firestarter_disputes({ action: "message", dispute_id: DID, image_urls: [HOSTED] });

    const attach = calls.find((c) => c.url === ATTACH);
    expect(attach?.body).toEqual({ image_url: HOSTED });
    // The message carries the URL the API minted, not the foreign one.
    expect(calls.find((c) => c.url === MESSAGES)?.body.attachment_urls).toEqual([BLOB]);
    expect(textOf(res)).toContain("Photo attached");
  });

  it("a photo with no words is a valid post — the buyer often just sends the picture", async () => {
    installFetch(okResponder());
    const tools = captureTools();

    const res = await tools.firestarter_disputes({ action: "message", dispute_id: DID, image_urls: [HOSTED] });

    expect(res.isError).toBeFalsy();
  });

  it("attaches several photos in one post", async () => {
    const calls = installFetch(okResponder());
    const tools = captureTools();

    const res = await tools.firestarter_disputes({
      action: "message", dispute_id: DID, message: "damage from three angles",
      image_urls: [HOSTED, HOSTED, HOSTED],
    });

    expect(calls.filter((c) => c.url === ATTACH)).toHaveLength(3);
    expect(calls.find((c) => c.url === MESSAGES)?.body.attachment_urls).toHaveLength(3);
    expect(textOf(res)).toContain("3 photos attached");
  });

  it("caps at five so a runaway list cannot hammer the upload endpoint", async () => {
    const calls = installFetch(okResponder());
    const tools = captureTools();

    await tools.firestarter_disputes({
      action: "message", dispute_id: DID, message: "lots", image_urls: Array(9).fill(HOSTED),
    });

    expect(calls.filter((c) => c.url === ATTACH)).toHaveLength(5);
  });

  it("reports a failed attach instead of claiming the evidence landed", async () => {
    installFetch((method, url) => {
      if (url === ATTACH) return { status: 400, json: { error: "Could not fetch that image URL", code: "INVALID_IMAGE" } };
      return { status: 200, json: { ok: true } };
    });
    const tools = captureTools();

    const res = await tools.firestarter_disputes({ action: "message", dispute_id: DID, image_urls: [HOSTED] });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/couldn't attach/i);
  });

  it("says so when only some photos made it, rather than a clean success", async () => {
    let n = 0;
    installFetch((method, url) => {
      if (url === ATTACH) {
        n++;
        return n === 1 ? { status: 200, json: { url: BLOB } } : { status: 400, json: { error: "bad", code: "INVALID_IMAGE" } };
      }
      return { status: 200, json: { ok: true } };
    });
    const tools = captureTools();

    const res = await tools.firestarter_disputes({ action: "message", dispute_id: DID, image_urls: [HOSTED, HOSTED] });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/couldn't be attached/i);
  });

  it("still accepts a genuine inline data URI", async () => {
    const calls = installFetch(okResponder());
    const tools = captureTools();

    await tools.firestarter_disputes({
      action: "message", dispute_id: DID, image_base64: "data:image/png;base64,iVBORw0KGgo=",
    });

    expect(calls.find((c) => c.url === ATTACH)?.body).toEqual({ image_base64: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("a text-only message still posts with no attachments", async () => {
    const calls = installFetch(okResponder());
    const tools = captureTools();

    await tools.firestarter_disputes({ action: "message", dispute_id: DID, message: "Any update?" });

    expect(calls.filter((c) => c.url === ATTACH)).toHaveLength(0);
    expect(calls.find((c) => c.url === MESSAGES)?.body.attachment_urls).toEqual([]);
  });

  it("asks for something to post when given neither words nor a photo", async () => {
    installFetch(okResponder());
    const tools = captureTools();

    const res = await tools.firestarter_disputes({ action: "message", dispute_id: DID });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/image_urls/);
  });
});
