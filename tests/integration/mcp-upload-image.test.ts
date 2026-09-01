/**
 * firestarter_upload_image (MCP) must call an apiKeyAuth-protected endpoint.
 *
 * It used to POST to /seller/products/upload-image, which is JWT-only
 * (sellerJwtAuth) — every MCP call (API-key auth) 401'd there, and
 * toErrorMessage() reported that 401 as "the API key is invalid or revoked,"
 * even though the key was fine. Fixed by giving it its own apiKeyAuth route,
 * POST /v1/sellers/upload-image (sellers.ts).
 *
 * Same harness as mcp-import.test.ts: drive the REAL registered tool handler
 * (captured via a fake McpServer) against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

type RecordedCall = { method: string; url: string; body: any };

function installFetch(
  respond: (method: string, url: string, body: any) => { status: number; json: any }
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(url), body });
      const { status, json } = respond(method, String(url), body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_upload_image", () => {
  it("calls the apiKeyAuth upload route, not the JWT-only dashboard one", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { url: "https://cdn.test/blob/xyz.jpg" } }));

    const res = await tools.firestarter_upload_image({
      image_base64: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBD",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://api.test/v1/sellers/upload-image");
    expect(calls[0].url).not.toContain("/seller/products/upload-image");
    expect(res.isError).toBeFalsy();
  });

  // commerce#819: a photo the agent can link to must be passable AS a URL —
  // re-encoding it as a data URI is exactly what fails in a tool call (the
  // same mechanism as the dispute-photo fix, commerce#749).
  it("forwards image_url to the upload route and returns the re-hosted URL (#819)", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { url: "https://cdn.test/blob/rehosted.jpg" } }));

    const res = await tools.firestarter_upload_image({
      image_url: "https://files.example/photo.jpg",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://api.test/v1/sellers/upload-image");
    expect(calls[0].body.image_url).toBe("https://files.example/photo.jpg");
    expect(calls[0].body.image_base64).toBeUndefined();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("https://cdn.test/blob/rehosted.jpg");
  });

  // A call with NO image is the drop-zone request: the widget renders an
  // interactive uploader from structuredContent.upload_request, and the bytes
  // travel widget → host bridge → this tool, never through the model. The old
  // behavior (a bare error) is exactly what pushed agents back toward
  // fabricating base64.
  it("displays the drop zone (not an error) when called with no image", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: {} }));

    const res = await tools.firestarter_upload_image({});

    expect(calls).toHaveLength(0); // no listing_id → nothing to look up
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.upload_request).toBeTruthy();
    expect(res.content[0].text).toMatch(/drop zone/i);
  });

  it("primes the drop zone with the listing's existing gallery and activation intent", async () => {
    const tools = captureTools();
    const calls = installFetch((method, url) => {
      if (method === "GET" && url.includes("/v1/listings/lst_abc")) {
        return {
          status: 200,
          json: {
            id: "lst_abc",
            product_name: "Walnut Desk Lamp",
            status: "draft",
            images: ["https://api.test/v1/img/aa11"],
            activation_blocked: [{ code: "NEEDS_IMAGE", message: "Add a product photo" }],
          },
        };
      }
      return { status: 404, json: {} };
    });

    const res = await tools.firestarter_upload_image({ listing_id: "lst_abc" });

    expect(calls).toHaveLength(1);
    expect(res.isError).toBeFalsy();
    const req = res.structuredContent?.upload_request;
    expect(req?.listing_id).toBe("lst_abc");
    expect(req?.product_name).toBe("Walnut Desk Lamp");
    // image_urls replaces the gallery wholesale — the widget must know what
    // already exists or an added photo would delete the rest (commerce#775).
    expect(req?.existing_image_urls).toEqual(["https://api.test/v1/img/aa11"]);
    // NEEDS_IMAGE is the only gate → the widget should activate after attach.
    expect(req?.activate).toBe(true);
  });

  it("still shows the drop zone when the listing lookup fails", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 500, json: { error: "boom" } }));

    const res = await tools.firestarter_upload_image({ listing_id: "lst_gone" });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.upload_request?.listing_id).toBe("lst_gone");
  });

  it("returns the hosted URL in structuredContent for the widget to read", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: { url: "https://cdn.test/v1/img/bb22" } }));

    const res = await tools.firestarter_upload_image({
      image_base64: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBD",
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.url).toBe("https://cdn.test/v1/img/bb22");
  });

  // image_path is the stdio/MCPB build's local-disk path: gated on the
  // localFiles option so the HOSTED transports never advertise an argument
  // they cannot honor (the file is on the user's machine, not the server's).
  it("does not accept image_path unless registered with localFiles", async () => {
    const tools = captureTools(); // no opts → hosted shape
    const calls = installFetch(() => ({ status: 200, json: {} }));

    const res = await tools.firestarter_upload_image({ image_path: "C:/photos/lamp.jpg" });

    // The unknown key is not honored as a file read: no upload happens; the
    // no-image branch answers with the drop zone instead.
    expect(calls).toHaveLength(0);
    expect(res.structuredContent?.upload_request).toBeTruthy();
  });
});

/**
 * commerce#1007 — "Still not able to add image to my dispute in Claude, it
 * wants publicly hosted image link."
 *
 * The buyer had a photo attached in the chat. A chat attachment has no URL, so
 * the only two inputs the dispute tools offered were one they could not produce
 * and model-emitted base64, which arrives truncated (#994). The drop zone is
 * the side channel that already solved this for listings; these tests pin it
 * onto the dispute path.
 *
 * The attach lives in firestarter_upload_image rather than in the dispute tools
 * because the drop zone has to call SOMETHING, and firestarter_disputes /
 * firestarter_seller_disputes move money (refund, accept, withdraw) — they must
 * not be reachable from a widget-originated call. This tool cannot move money,
 * so it is the one that is safe to expose.
 */
describe("firestarter_upload_image — dispute evidence (#1007)", () => {
  const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBD";
  const HOSTED = "https://cdn.test/blob/evidence.jpg";

  it("displays a drop zone for the dispute when called with no image", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: {} }));

    const res = await tools.firestarter_upload_image({ dispute_id: "disp_abc", dispute_note: "the corner is crushed" });

    // Nothing is uploaded yet — this reply IS the zone.
    expect(calls).toHaveLength(0);
    expect(res.structuredContent.upload_request).toMatchObject({
      dispute_id: "disp_abc",
      dispute_side: "buyer",
      dispute_note: "the corner is crushed",
    });
    // The model must not then go asking for a hosted link, which is the exact
    // dead end reported.
    expect(res.content[0].text).toContain("drop zone");
    expect(res.content[0].text).toContain("END YOUR TURN");
  });

  it("routes the zone to the seller's own dispute surface when asked", async () => {
    const tools = captureTools();
    installFetch(() => ({ status: 200, json: {} }));
    const res = await tools.firestarter_upload_image({ dispute_id: "disp_abc", dispute_side: "seller" });
    expect(res.structuredContent.upload_request.dispute_side).toBe("seller");
  });

  it("uploads the photo AND posts it to the buyer's dispute thread in one call", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) => {
      if (url.endsWith("/v1/sellers/upload-image")) return { status: 200, json: { url: HOSTED } };
      if (url.endsWith("/attachments")) return { status: 200, json: { url: HOSTED } };
      return { status: 200, json: { ok: true } };
    });

    const res = await tools.firestarter_upload_image({
      image_base64: PHOTO, filename: "damage.jpg",
      dispute_id: "disp_abc", dispute_note: "the corner is crushed",
    });

    expect(res.isError).toBeFalsy();
    const urls = calls.map((c) => c.url);
    expect(urls).toEqual([
      "http://api.test/v1/sellers/upload-image",
      "http://api.test/buyer/disputes/disp_abc/attachments",
      "http://api.test/buyer/disputes/disp_abc/messages",
    ]);
    // The hosted URL is what travels on, never the bytes a second time.
    expect(calls[1].body).toEqual({ image_url: HOSTED });
    expect(calls[2].body).toEqual({ message: "the corner is crushed", attachment_urls: [HOSTED] });
    // The widget reads the URL from structuredContent rather than the prose.
    expect(res.structuredContent).toEqual({ url: HOSTED });
  });

  it("posts a seller's evidence to the seller surface, not the buyer's", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) => {
      if (url.endsWith("/v1/sellers/upload-image")) return { status: 200, json: { url: HOSTED } };
      if (url.endsWith("/attachments")) return { status: 200, json: { url: HOSTED } };
      return { status: 200, json: { ok: true } };
    });

    await tools.firestarter_upload_image({
      image_base64: PHOTO, dispute_id: "disp_abc", dispute_side: "seller",
    });

    expect(calls.map((c) => c.url)).toEqual([
      "http://api.test/v1/sellers/upload-image",
      "http://api.test/v1/sellers/disputes/disp_abc/attachments",
      "http://api.test/v1/sellers/disputes/disp_abc/messages",
    ]);
  });

  it("takes a public URL for the evidence too, without a second upload hop", async () => {
    const tools = captureTools();
    const calls = installFetch((_m, url) => {
      if (url.endsWith("/v1/sellers/upload-image")) return { status: 200, json: { url: HOSTED } };
      if (url.endsWith("/attachments")) return { status: 200, json: { url: HOSTED } };
      return { status: 200, json: { ok: true } };
    });

    await tools.firestarter_upload_image({
      image_url: "https://files.example/damage.jpg", dispute_id: "disp_abc",
    });

    expect(calls[0].body).toEqual({ image_url: "https://files.example/damage.jpg", filename: undefined });
    expect(calls.map((c) => c.url)).toContain("http://api.test/buyer/disputes/disp_abc/messages");
  });

  it("hands the hosted URL back when the photo stored but the post failed", async () => {
    const tools = captureTools();
    installFetch((_m, url) => {
      if (url.endsWith("/v1/sellers/upload-image")) return { status: 200, json: { url: HOSTED } };
      if (url.endsWith("/attachments")) return { status: 200, json: { url: HOSTED } };
      return { status: 500, json: { error: "dispute engine unavailable" } };
    });

    const res = await tools.firestarter_upload_image({ image_base64: PHOTO, dispute_id: "disp_abc" });

    // The bytes ARE stored. Reporting this as an upload error would send the
    // agent to re-upload them, and the URL would be lost with the message.
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(HOSTED);
    expect(res.content[0].text).toContain("do NOT upload the photo again");
    expect(res.structuredContent).toEqual({ url: HOSTED });
  });

  it("leaves the plain listing upload untouched — no dispute hops", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: { url: HOSTED } }));

    const res = await tools.firestarter_upload_image({ image_base64: PHOTO });

    expect(calls).toHaveLength(1);
    expect(res.content[0].text).toContain("Hosted URL");
  });
});
