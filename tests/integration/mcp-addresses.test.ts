/**
 * firestarter_addresses (saved-address discovery) + address_id passthrough.
 *
 * The address-book UX depends on the agent (a) being able to LIST saved
 * addresses masked so it references one by id instead of re-collecting PII, and
 * (b) threading a chosen address_id through execute/approve. This pins the
 * masked list render and that address_id reaches the API body on both tools.
 *
 * Same harness as mcp-assist.test.ts: real registered handlers via a fake
 * McpServer, mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
    const tools: Record<string, ToolHandler> = {};
    const fakeServer = {
        tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
            tools[name] = handler;
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

const SAVED = {
    addresses: [
        { id: "addr_home", label: "Home", name: "Ada", street1: "12 Ring Road", city: "Nairobi", country: "KE", zip: "00100", phone: "+254700000000", is_default: true },
        { id: "addr_work", label: "Work", name: "Ada", street1: "500 Uhuru Hwy", city: "Nairobi", country: "KE", zip: "00200", phone: "+254711111111", is_default: false },
    ],
};

describe("firestarter_addresses", () => {
    it("lists saved addresses masked, marks the default, and never leaks zip/phone", async () => {
        const tools = captureTools();
        const calls = installFetch((method, url) => {
            if (method === "GET" && url.includes("/v1/addresses")) return { status: 200, json: SAVED };
            return { status: 404, json: {} };
        });

        const res = await tools.firestarter_addresses({});
        const text = textOf(res);

        expect(text).toContain("addr_home");
        expect(text).toContain("(default)");
        expect(text).toContain("Home");
        expect(text).toContain("Nairobi");
        // PII must not appear.
        expect(text).not.toContain("00100");
        expect(text).not.toContain("+254700000000");
        expect(calls.some((c) => c.method === "GET" && c.url.includes("/v1/addresses"))).toBe(true);
    });

    it("renders a helpful empty state (no error) when there are no saved addresses", async () => {
        const tools = captureTools();
        installFetch(() => ({ status: 200, json: { addresses: [] } }));
        const res = await tools.firestarter_addresses({});
        expect(res.isError).toBeUndefined();
        expect(textOf(res)).toMatch(/no saved addresses/i);
    });
});

describe("firestarter_save_address", () => {
    it("POSTs the address and surfaces the saved id/label from the { address } envelope", async () => {
        const tools = captureTools();
        const calls = installFetch((method, url) => {
            if (method === "POST" && url.includes("/v1/addresses")) {
                // Real API shape: the created row is wrapped under `address`.
                return {
                    status: 201,
                    json: { address: { id: "addr_new1", label: "Office", city: "Lahore", state: null, country: "PK", is_default: false } },
                };
            }
            return { status: 404, json: {} };
        });

        const res = await tools.firestarter_save_address({ street1: "384 Street 5", city: "Lahore", country: "PK", label: "Office" });
        const text = textOf(res);

        // The bug this guards: reading fields off the envelope (saved.id) instead
        // of saved.address.id printed "id: undefined" and an empty place.
        expect(res.isError).toBeUndefined();
        expect(text).toContain("addr_new1");
        expect(text).toContain("Office");
        expect(text).toContain("Lahore");
        expect(text).not.toContain("undefined");

        const post = calls.find((c) => c.method === "POST" && c.url.includes("/v1/addresses"));
        expect(post?.body).toMatchObject({ street1: "384 Street 5", city: "Lahore", country: "PK", label: "Office" });
    });

    it("marks the default when the API says so", async () => {
        const tools = captureTools();
        installFetch(() => ({ status: 201, json: { address: { id: "addr_d", label: "Default", city: "Nairobi", country: "KE", is_default: true } } }));
        const text = textOf(await tools.firestarter_save_address({ street1: "12 Ring Road", city: "Nairobi", country: "KE" }));
        expect(text).toContain("addr_d");
        expect(text).toContain("(default)");
    });
});

describe("address_id passthrough", () => {
    it("firestarter_approve forwards address_id to the approve API body", async () => {
        const tools = captureTools();
        const calls = installFetch((method, url) => {
            if (method === "POST" && url.includes("/approve")) return { status: 200, json: {} };
            if (method === "GET" && url.includes("/poll")) {
                return { status: 200, json: { status: "paid", has_options: false } };
            }
            if (method === "GET" && /\/v1\/executions\/[^/]+$/.test(url)) {
                return { status: 200, json: { id: "exec_1", status: "paid", current_step: "pay", options: [] } };
            }
            return { status: 200, json: {} };
        });

        await tools.firestarter_approve({ execution_id: "exec_1", address_id: "addr_work" });

        const approveCall = calls.find((c) => c.method === "POST" && c.url.includes("/approve"));
        expect(approveCall?.body?.address_id).toBe("addr_work");
    });
});
