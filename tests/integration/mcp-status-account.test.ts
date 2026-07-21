import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

/**
 * firestarter_status "Account:" line — the no-arg status call reports WHO the
 * configured API key operates as (org owner + org, from GET /v1/me) alongside
 * the environment. Identity is best-effort: an API without /v1/me (rolling
 * deploy) must never break a status check.
 */

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools[name] = handler;
    },
  };
  registerTools(fakeServer as any, "fs_test_status_account", "http://api.test");
  return tools;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ME = {
  org: { id: "org_abc", name: "Analog Labs", email: "ops@analog.test", plan: "pro" },
  user: { id: "usr_1", email: "tanveer@analog.test", name: "Ali Tanveer" },
  environment: "test",
};

const EXEC_LIST = {
  total: 2,
  executions: [
    { id: "exec_1", status: "completed", request_text: "running shoes" },
    { id: "exec_2", status: "awaiting_approval", request_text: "coffee beans" },
  ],
};

function stubFetch(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      for (const [needle, respond] of Object.entries(routes)) {
        if (u.includes(needle)) return respond();
      }
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_status account identity", () => {
  it("lists executions with an Account line naming the key's user and org", async () => {
    stubFetch({
      "/v1/me": () => json(ME),
      "/v1/executions": () => json(EXEC_LIST),
    });

    const result = await captureTools().firestarter_status({});
    const text = result.content[0].text as string;

    expect(text).toContain("Environment: TEST");
    expect(text).toContain('Account: Ali Tanveer <tanveer@analog.test> — org "Analog Labs" (org_abc, pro plan)');
    expect(text).toContain("exec_1");
    expect(text.indexOf("Account:")).toBeLessThan(text.indexOf("**Recent Executions**"));
  });

  it("includes the Account line on the empty-list response too", async () => {
    stubFetch({
      "/v1/me": () => json(ME),
      "/v1/executions": () => json({ total: 0, executions: [] }),
    });

    const text = (await captureTools().firestarter_status({})).content[0].text as string;

    expect(text).toContain("Account: Ali Tanveer <tanveer@analog.test>");
    expect(text).toContain("No executions found.");
  });

  it("falls back to the org when the org has no owner user", async () => {
    stubFetch({
      "/v1/me": () => json({ ...ME, user: null }),
      "/v1/executions": () => json(EXEC_LIST),
    });

    const text = (await captureTools().firestarter_status({})).content[0].text as string;

    expect(text).toContain('Account: org "Analog Labs" (org_abc, pro plan)');
    expect(text).not.toContain("<tanveer@analog.test>");
  });

  it("still lists executions when /v1/me is unavailable (older API)", async () => {
    stubFetch({
      "/v1/me": () => json({ error: "NOT_FOUND" }, 404),
      "/v1/executions": () => json(EXEC_LIST),
    });

    const text = (await captureTools().firestarter_status({})).content[0].text as string;

    expect(text).toContain("Environment: TEST");
    expect(text).not.toContain("Account:");
    expect(text).toContain("exec_1");
  });
});
