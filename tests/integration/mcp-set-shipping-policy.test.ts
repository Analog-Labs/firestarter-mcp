/**
 * #332 MCP surface: firestarter_set_shipping_policy (the "widen on demand"
 * tool a seller's agent calls after a checkout came back SHIPPING_NOT_OFFERED)
 * plus the shipping_policy passthrough on firestarter_list.
 *
 * Drives the REAL registered tool handlers (captured via a fake McpServer)
 * against a mocked global fetch, same harness as mcp-list-seller-profile.test.ts.
 * We assert the local validation, the PATCH/POST request shape (so the policy
 * actually reaches the API), and the seller-facing summary text.
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

/** Stub global fetch with one fixed response; returns the mock for call asserts. */
function installFetch(status: number, json: any) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

/** Parse the JSON request body of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof installFetch>, n = 0): any {
  return JSON.parse((fetchMock.mock.calls[n][1] as any).body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("firestarter_set_shipping_policy (#332)", () => {
  it("mode 'list' with no countries: validates locally, never calls the API", async () => {
    const fetchMock = installFetch(200, {});
    const tools = captureTools();

    const res = await tools.firestarter_set_shipping_policy({ listing_id: "lst_g2", mode: "list" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("needs at least one country");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("worldwide with an exclude: PATCHes the listing and summarizes the reach", async () => {
    const fetchMock = installFetch(200, {
      product_name: "Indie Tee",
      shipping_policy: { mode: "worldwide", exclude: ["BR"] },
    });
    const tools = captureTools();

    const res = await tools.firestarter_set_shipping_policy({ listing_id: "lst_g2", mode: "worldwide", exclude: ["BR"] });

    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text.toLowerCase()).toContain("worldwide");
    expect(text).toContain("BR");

    // The policy actually rode a PATCH to the listing.
    const [url, opts] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("http://api.test/v1/listings/lst_g2");
    expect(opts.method).toBe("PATCH");
    expect(bodyOf(fetchMock)).toEqual({ shipping_policy: { mode: "worldwide", exclude: ["BR"] } });
  });

  it("mode 'list' with countries: PATCHes the allow-list and names the destinations", async () => {
    const fetchMock = installFetch(200, {
      product_name: "Indie Tee",
      shipping_policy: { mode: "list", countries: ["CA", "GB"] },
    });
    const tools = captureTools();

    const res = await tools.firestarter_set_shipping_policy({ listing_id: "lst_g2", mode: "list", countries: ["CA", "GB"] });

    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("CA");
    expect(text).toContain("GB");
    expect(bodyOf(fetchMock)).toEqual({ shipping_policy: { mode: "list", countries: ["CA", "GB"] } });
  });

  it("surfaces an API error instead of claiming success", async () => {
    installFetch(404, { error: "Listing not found", code: "NOT_FOUND", status: 404 });
    const tools = captureTools();

    const res = await tools.firestarter_set_shipping_policy({ listing_id: "lst_missing", mode: "domestic" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Listing not found");
  });
});

describe("firestarter_list shipping_policy passthrough (#332)", () => {
  it("threads shipping_policy into the create body", async () => {
    const fetchMock = installFetch(201, { id: "lst_new", product_name: "Tee", status: "active", base_price: 42 });
    const tools = captureTools();

    const res = await tools.firestarter_list({
      product_name: "Tee",
      base_price: 42,
      shipping_policy: { mode: "list", countries: ["CA"] },
    });

    expect(res.isError).toBeFalsy();
    const [url, opts] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("http://api.test/v1/listings");
    expect(opts.method).toBe("POST");
    expect(bodyOf(fetchMock).shipping_policy).toEqual({ mode: "list", countries: ["CA"] });
  });

  it("omits shipping_policy when none is supplied", async () => {
    const fetchMock = installFetch(201, { id: "lst_new", product_name: "Tee", status: "active", base_price: 42 });
    const tools = captureTools();

    await tools.firestarter_list({ product_name: "Tee", base_price: 42 });

    expect("shipping_policy" in bodyOf(fetchMock)).toBe(false);
  });
});
