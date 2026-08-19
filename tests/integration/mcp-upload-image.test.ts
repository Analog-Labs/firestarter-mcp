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

  it("errors without calling the API when neither image_url nor image_base64 is given (#819)", async () => {
    const tools = captureTools();
    const calls = installFetch(() => ({ status: 200, json: {} }));

    const res = await tools.firestarter_upload_image({});

    expect(calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/image_url|image_base64/);
  });
});
