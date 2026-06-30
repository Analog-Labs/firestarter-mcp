/**
 * MCP auth-error surfacing (issue #514).
 *
 * When the API returns 401 (invalid/revoked key), the MCP tool must NOT relay a
 * generic "shopping service" failure: the upstream agent (the WhatsApp/Cole
 * bridge) otherwise tells the buyer the search failed — and may fabricate that a
 * search ran. The message must instead name it a credential problem, say no
 * search happened, and tell the integration to re-provision the key.
 *
 * Same harness as mcp-list-seller-profile.test.ts: drive the REAL registered
 * tool handlers (captured via a fake McpServer) against a mocked global fetch.
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
    registerTools(fakeServer as any, "fs_live_dead_key", "http://api.test");
    return tools;
}

function installFetch(status: number, json: any) {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(JSON.stringify(json), {
                    status,
                    headers: { "Content-Type": "application/json" },
                })
        )
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

function textOf(res: any): string {
    return res.content.map((b: any) => b.text).join("\n");
}

const INVALID_KEY_BODY = { error: "Invalid API key", code: "INVALID_KEY", status: 401 };
const PAYMENT_REQUIRED_BODY = {
    error: "Insufficient token balance",
    code: "PAYMENT_REQUIRED",
    status: 402,
    required_tokens: 1200,
    token_balance: 300,
    plan: "free",
    trial_active: false,
};

describe("MCP auth-error surfacing (issue #514)", () => {
    it("firestarter_execute reframes a 401 INVALID_KEY as a credential problem, not a search outage", async () => {
        installFetch(401, INVALID_KEY_BODY);
        const tools = captureTools();

        const res = await tools.firestarter_execute({ request: "buy lipstick" });
        const text = textOf(res);

        expect(res.isError).toBe(true);
        expect(text.toLowerCase()).toContain("authentication failed");
        expect(text.toLowerCase()).toContain("re-provision");
        // Must explicitly state no search ran so the agent doesn't claim it searched.
        expect(text.toLowerCase()).toContain("no search was performed");
        // Must NOT read like the product-search/shopping service is down.
        expect(text.toLowerCase()).not.toContain("shopping service");
        // Must not echo the bare upstream "Invalid API key" string alone.
        expect(text).not.toBe("Error: Invalid API key");
    });

    it("firestarter_status also reframes a 401 as an auth/credential failure", async () => {
        installFetch(401, INVALID_KEY_BODY);
        const tools = captureTools();

        const res = await tools.firestarter_status({});
        const text = textOf(res);

        expect(res.isError).toBe(true);
        expect(text.toLowerCase()).toContain("authentication failed");
        expect(text.toLowerCase()).toContain("re-provision");
    });

    it("a non-auth error (400 VALIDATION_ERROR) is left untouched", async () => {
        installFetch(400, { error: "request is required", code: "VALIDATION_ERROR", status: 400 });
        const tools = captureTools();

        const res = await tools.firestarter_execute({ request: "x" });
        const text = textOf(res);

        expect(res.isError).toBe(true);
        expect(text).toContain("request is required");
        expect(text.toLowerCase()).not.toContain("authentication failed");
    });

    it("firestarter_execute adds billing snapshot guidance on 402 PAYMENT_REQUIRED", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: any, init?: any) => {
                const method = init?.method || "GET";
                if (method === "POST" && String(url).endsWith("/v1/executions")) {
                    return new Response(JSON.stringify(PAYMENT_REQUIRED_BODY), {
                        status: 402,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                if (method === "GET" && String(url).endsWith("/v1/billing/balance")) {
                    return new Response(
                        JSON.stringify({ org_id: "org_abc", plan: "free", token_balance: 300, trial_active: false }),
                        { status: 200, headers: { "Content-Type": "application/json" } }
                    );
                }
                throw new Error(`unexpected fetch: ${method} ${url}`);
            })
        );
        const tools = captureTools();

        const res = await tools.firestarter_execute({ request: "buy lipstick" });
        const text = textOf(res);

        expect(res.isError).toBe(true);
        expect(text).toContain("Error: Insufficient token balance");
        expect(text).toContain("Firestarter org billing snapshot:");
        expect(text).toContain("- org_id: org_abc");
        expect(text).toContain("- token_balance: 300");
        expect(text).toContain("different Firestarter org/API key");
    });
});
