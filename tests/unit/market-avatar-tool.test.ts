/**
 * commerce#1024 — a community market owner can set the market avatar from chat.
 *
 * Reported verbatim: "Not able to upload Avatar in my community market profile
 * from Claude." The assistant answered that Firestarter did not support it and
 * sent the owner to the website. The endpoint had existed the whole time, on
 * the very API-key surface this server authenticates with
 * (POST /v1/attribution/programs/:id/avatar) — no tool exposed it.
 *
 * The input ladder is deliberately firestarter_upload_image's, because the
 * obvious shortcut (one image_base64 parameter) is the #958/#994 truncation
 * mechanism: a chat attachment re-encoded by the model arrives fabricated or
 * cut short. URL first; drop zone for an attachment; base64 last.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; },
    registerTool: (name: string, _cfg: any, handler: ToolHandler) => { tools[name] = handler; },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

function text(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

let calls: Array<{ url: string; method: string; body: any }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({ avatar_url: "https://api.firestarter.network/v1/img/abc123" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_set_market_avatar", () => {
  it("displays the drop zone, and calls nothing, when given no image", async () => {
    const res = await captureTools().firestarter_set_market_avatar({
      program_id: "prog_1",
      market_name: "ssdff",
    });

    // The whole point of the zone: the bytes must not come from the model.
    expect(calls).toHaveLength(0);
    expect(res.structuredContent).toEqual({
      upload_request: { market_program_id: "prog_1", market_name: "ssdff" },
    });
    expect(text(res)).toContain("drop zone");
    // The agent must stop rather than "helpfully" encoding the attachment.
    expect(text(res)).toContain("END YOUR TURN");
    expect(text(res)).toMatch(/[Nn]ever re-encode/);
  });

  it("prefers a URL and lets the SERVER fetch it", async () => {
    const res = await captureTools().firestarter_set_market_avatar({
      program_id: "prog_1",
      image_url: "https://example.com/logo.png",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/v1/attribution/programs/prog_1/avatar");
    expect(calls[0].body).toEqual({ image_url: "https://example.com/logo.png" });
    expect(text(res)).toContain("Avatar set");
    expect(text(res)).toContain("/v1/img/abc123");
  });

  it("still accepts base64 for bytes that exist at no URL", async () => {
    await captureTools().firestarter_set_market_avatar({
      program_id: "prog_1",
      image_base64: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(calls[0].body).toEqual({ image_base64: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("sends a URL alone when both are given — never the model's bytes", async () => {
    await captureTools().firestarter_set_market_avatar({
      program_id: "prog_1",
      image_url: "https://example.com/logo.png",
      image_base64: "data:image/png;base64,ZmFrZQ==",
    });
    expect(calls[0].body).toEqual({ image_url: "https://example.com/logo.png" });
  });

  it("percent-encodes the program id into the path", async () => {
    await captureTools().firestarter_set_market_avatar({
      program_id: "prog/../1",
      image_url: "https://example.com/logo.png",
    });
    expect(calls[0].url).toContain("prog%2F..%2F1");
  });
});
