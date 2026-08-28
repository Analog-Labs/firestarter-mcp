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
