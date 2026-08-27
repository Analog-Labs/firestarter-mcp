/**
 * commerce#899 — a DELIVERED test order that can still be disputed.
 *
 * Test mode zeroes the escrow inspection window so a test sell completes end to
 * end on the next tick (commerce#295). The cost: escrow becomes releasable the
 * instant delivery is confirmed, and `openDispute` refuses on a released hold —
 * so "it arrived and it's wrong", the most common real dispute, could not be
 * staged in test mode from any surface. commerce#771's `hold_at_shipped` does
 * not cover it: that parks the order BEFORE delivery, and the confirm-delivery
 * paths re-collapse the window the moment you deliver.
 *
 * `hold_at_delivered` is its delivered-side twin, and rides the same verbatim
 * `preferences` channel.
 *
 * Harness mirrors mcp-qa-0819-gaps.test.ts: the REAL registered handlers
 * against a mocked global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, "fs_test_key", "http://api.test");
  return tools;
}

let fetchCalls: Array<{ method: string; url: string; body: any }>;

const COMPLETED_EXEC = { id: "exec_hd1", status: "completed", request_text: "soap", options: [], steps: [] };

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, url: String(url), body });
    if (method === "POST" && String(url).endsWith("/v1/executions")) {
      return new Response(JSON.stringify({ id: "exec_hd1", status: "finding" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "GET" && String(url).includes("/v1/executions/")) {
      return new Response(JSON.stringify(COMPLETED_EXEC), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
}

const created = () => fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/v1/executions"));

beforeEach(() => { fetchCalls = []; installFetch(); });
afterEach(() => vi.unstubAllGlobals());

describe("firestarter_execute — hold_at_delivered (commerce#899)", () => {
  it("forwards hold_at_delivered into preferences", async () => {
    await captureTools().firestarter_execute({ request: "soap", hold_at_delivered: true });
    expect(created()?.body.preferences.hold_at_delivered).toBe(true);
    // Rides ALONGSIDE the existing preferences, never replacing them.
    expect(created()?.body.preferences.priority).toBe("cost");
    expect(created()?.body.preferences.require_approval).toBe(true);
  });

  it("is independent of hold_at_shipped — a test can ask for both, or either", async () => {
    await captureTools().firestarter_execute({ request: "soap", hold_at_shipped: true, hold_at_delivered: true });
    expect(created()?.body.preferences).toMatchObject({ hold_at_shipped: true, hold_at_delivered: true });
  });

  it("sends no key at all when the flag is absent", async () => {
    await captureTools().firestarter_execute({ request: "soap" });
    expect(created()?.body.preferences).toEqual({ priority: "cost", require_approval: true });
  });

  it("false is treated as absent rather than sent as false", async () => {
    await captureTools().firestarter_execute({ request: "soap", hold_at_delivered: false });
    expect(created()?.body.preferences).not.toHaveProperty("hold_at_delivered");
  });
});

describe("the manifests declare it", () => {
  // A parameter the schema accepts but the published manifest never mentions is
  // invisible to every remote client — the exact failure sync-manifest
  // -descriptions.ts exists to prevent.
  it.each(["../../mcp.json", "../../src/mcp/mcp.json"])("%s lists hold_at_delivered on firestarter_execute", async (path) => {
    const manifest = (await import(path, { with: { type: "json" } })).default as any;
    const tool = manifest.tools.find((t: any) => t.name === "firestarter_execute");
    expect(tool, "firestarter_execute missing from the manifest").toBeTruthy();
    const params = tool.inputSchema?.properties ?? tool.parameters ?? {};
    expect(Object.keys(params)).toContain("hold_at_delivered");
  });
});
