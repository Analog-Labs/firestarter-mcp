/**
 * firestarter_record_purchase + firestarter_purchases (off-network capture).
 *
 * The capture loop's MCP face: after an agent drives an off-network checkout it
 * records what was bought; later "what did I buy" / reorder flows read it back.
 * Pins (a) the POST body reaching /v1/external-purchases intact, (b) list
 * filters becoming query params, (c) the single-purchase render including the
 * reorder URL, and (d) the API's TEST_MODE_ONLY refusal surfacing as the
 * friendly test-key explanation rather than a bare error — the feature is
 * deliberately test-environment-only.
 *
 * Same harness as mcp-addresses.test.ts: real registered handlers via a fake
 * McpServer, mocked global fetch.
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
    respond: (method: string, url: string, body: any) => { status: number; json: any },
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
        }),
    );
    return calls;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const textOf = (res: any): string => res.content.map((b: any) => b.text).join("\n");

const PURCHASE = {
    id: "pur_9kX2mQvT", org_id: "org_1", environment: "test", source: "lazada",
    external_order_ref: "LZD-8837421", title: "Watsons Cotton Buds 200pcs",
    image_url: null, amount: "12.90", currency: "MYR",
    seller_name: "Watsons Malaysia", seller_domain: "watsons.com.my",
    product_url: "https://www.lazada.com.my/products/x", purchased_at: "2026-08-12T10:00:00Z",
    raw_payload: null, created_at: "2026-08-12T10:00:01Z",
};

describe("firestarter_record_purchase", () => {
    it("POSTs the capture body to /v1/external-purchases and renders the confirmation", async () => {
        const tools = captureTools();
        const calls = installFetch(() => ({ status: 201, json: { purchase: PURCHASE, known_source: true } }));

        const res = await tools.firestarter_record_purchase({
            source: "lazada", title: "Watsons Cotton Buds 200pcs",
            amount: 12.9, currency: "MYR", seller_domain: "watsons.com.my",
            external_order_ref: "LZD-8837421",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("POST");
        expect(calls[0].url).toBe("http://api.test/v1/external-purchases");
        expect(calls[0].body.source).toBe("lazada");
        expect(calls[0].body.external_order_ref).toBe("LZD-8837421");
        const text = textOf(res);
        expect(text).toContain("Purchase recorded");
        expect(text).toContain("pur_9kX2mQvT");
        expect(text).toContain("test mode");
    });

    it("renders the TEST_MODE_ONLY refusal as the test-key explanation", async () => {
        const tools = captureTools();
        installFetch(() => ({
            status: 403,
            json: { error: "External purchase capture is available on test-environment keys only for now.", code: "TEST_MODE_ONLY", status: 403 },
        }));

        const res = await tools.firestarter_record_purchase({ source: "lazada", title: "x" });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("test-mode only");
        expect(textOf(res)).toContain("fs_test_");
    });
});

describe("firestarter_purchases", () => {
    it("lists with filters as query params", async () => {
        const tools = captureTools();
        const calls = installFetch(() => ({ status: 200, json: { purchases: [PURCHASE], count: 1 } }));

        const res = await tools.firestarter_purchases({ query: "cotton", source: "lazada", limit: 5 });

        expect(calls[0].method).toBe("GET");
        expect(calls[0].url).toBe("http://api.test/v1/external-purchases?q=cotton&source=lazada&limit=5");
        const text = textOf(res);
        expect(text).toContain("Your purchases");
        expect(text).toContain("Watsons Cotton Buds 200pcs");
        expect(text).toContain("pur_9kX2mQvT");
    });

    it("fetches one purchase and includes the reorder URL", async () => {
        const tools = captureTools();
        const calls = installFetch(() => ({ status: 200, json: { purchase: PURCHASE } }));

        const res = await tools.firestarter_purchases({ purchase_id: "pur_9kX2mQvT" });

        expect(calls[0].url).toBe("http://api.test/v1/external-purchases/pur_9kX2mQvT");
        const text = textOf(res);
        expect(text).toContain("Reorder here: https://www.lazada.com.my/products/x");
        expect(text).toContain("LZD-8837421");
    });

    it("renders a friendly empty state pointing at record_purchase", async () => {
        const tools = captureTools();
        installFetch(() => ({ status: 200, json: { purchases: [], count: 0 } }));

        const res = await tools.firestarter_purchases({});
        expect(textOf(res)).toContain("firestarter_record_purchase");
    });
});
