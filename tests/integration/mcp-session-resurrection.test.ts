/**
 * A lost session is resurrected, not refused (commerce#1090/#1074/#1111/#1118).
 *
 * The session map is in-memory: an API deploy empties it, the idle sweep empties
 * it for anyone who paused a conversation, the LRU cap can empty it under load.
 * The spec says a client that gets 404 on its session id MUST re-initialize —
 * claude.ai does not. It keeps presenting the dead id on the next tool call and
 * on every retry, the user sees "Unable to reach Firestarter", and the shopping
 * widget / drop zone never renders. Two of the four reports were filed within
 * 30–50 minutes of a prod API deploy; the others after a long pause.
 *
 * Pinned here:
 *   R1  a tool call on an id the server does not hold is served, under that id,
 *       and the upstream call carries the Bearer on THAT request;
 *   R2  the resurrected session persists — the next call on the id is routine;
 *   R3  a session swept for idleness comes back the same way;
 *   R4  an initialize request carrying a stale id starts a fresh session (the
 *       spec's own recovery path still works) — and does not adopt the stale id;
 *   R5  an id we could never have issued is still 404;
 *   R6  DELETE of a dead session stays 404 — there is nothing to close;
 *   R7  two requests racing on the same dead id share ONE resurrection;
 *   R8  no Authorization at all is still 401 — resurrection needs a Bearer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Read at module load, so they must be set before the dynamic import below.
// The TTL is generous: R2 asserts that two back-to-back requests do NOT
// straddle a sweep, and under a loaded full-suite run "back-to-back" can be
// a few hundred milliseconds apart.
process.env.MCP_SESSION_TTL_MS = "1500";
process.env.MCP_MAX_SESSIONS = "5";
const route = await import("../../src/mcp/route.js");
const { default: app, mcpSessionCount, resetMcpSessions, mcpResurrectionCount } = route as any;

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

const CALL = {
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "firestarter_wallet_balance", arguments: {} },
};

const headers = (key: string | null, sessionId?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

async function openSession(key: string): Promise<string> {
  const res = await app.request("/", { method: "POST", headers: headers(key), body: JSON.stringify(INIT) });
  expect(res.status).toBe(200);
  await res.text().catch(() => "");
  return res.headers.get("mcp-session-id")!;
}

/** Stub the upstream API and record the Bearer each call arrives with. */
function captureUpstream(): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
    return new Response(JSON.stringify({ balance_cents: 0, currency: "USD" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }));
  return seen;
}

/** A tool call; drains the SSE body so the handler has run. `id` is the
 *  JSON-RPC id — two calls in flight on one session need distinct ids, exactly
 *  as a real client would send them. */
async function callTool(key: string | null, sessionId: string, id: number = CALL.id): Promise<Response> {
  const res = await app.request("/", { method: "POST", headers: headers(key, sessionId), body: JSON.stringify({ ...CALL, id }) });
  await res.text().catch(() => "");
  return res;
}

const ping = (key: string, sessionId: string) =>
  app.request("/", {
    method: "POST", headers: headers(key, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });

/** What claude.ai holds after a deploy: a UUID the server has never seen. */
const DEAD_ID = "5f0c2b3e-9d1a-4c7e-8b2f-0a1d2e3f4a5b";

beforeEach(() => { resetMcpSessions(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MCP HTTP session resurrection", () => {
  it("R1: a tool call on an id the server does not hold is served under that id, with THIS request's Bearer", async () => {
    const before = mcpResurrectionCount();
    const upstream = captureUpstream();

    const res = await callTool("fs_oauth_after_deploy", DEAD_ID);

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe(DEAD_ID);
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((h) => h === "Bearer fs_oauth_after_deploy")).toBe(true);
    expect(mcpSessionCount()).toBe(1);
    expect(mcpResurrectionCount()).toBe(before + 1);
  });

  it("R2: the resurrected session persists — the next call on the id is routine, not a second resurrection", async () => {
    captureUpstream();
    await callTool("fs_live_k", DEAD_ID);
    const before = mcpResurrectionCount();

    const res = await ping("fs_live_k", DEAD_ID);
    await res.text().catch(() => "");

    expect(res.status).toBe(200);
    expect(mcpResurrectionCount()).toBe(before);
    expect(mcpSessionCount()).toBe(1);
  });

  it("R3: a session swept for idleness comes back the same way", async () => {
    const id = await openSession("fs_live_k");
    await new Promise((r) => setTimeout(r, 1700)); // > MCP_SESSION_TTL_MS
    captureUpstream();

    // The sweep runs on the next request; that request is the resurrection.
    const res = await callTool("fs_live_k", id);

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe(id);
  });

  it("R4: an initialize request carrying a stale id starts a fresh session and does not adopt the stale id", async () => {
    const before = mcpResurrectionCount();
    const res = await app.request("/", {
      method: "POST", headers: headers("fs_live_k", DEAD_ID), body: JSON.stringify(INIT),
    });
    await res.text().catch(() => "");

    expect(res.status).toBe(200);
    const minted = res.headers.get("mcp-session-id");
    expect(minted).toBeTruthy();
    expect(minted).not.toBe(DEAD_ID);
    expect(mcpResurrectionCount()).toBe(before);
  });

  it("R5: an id we could never have issued is still 404", async () => {
    const res = await callTool("fs_live_k", "x".repeat(300));
    expect(res.status).toBe(404);
    const short = await callTool("fs_live_k", "abc");
    expect(short.status).toBe(404);
    expect(mcpSessionCount()).toBe(0);
  });

  it("R6: DELETE of a dead session stays 404 — there is nothing to close", async () => {
    const res = await app.request("/", { method: "DELETE", headers: headers("fs_live_k", DEAD_ID) });
    expect(res.status).toBe(404);
    expect(mcpSessionCount()).toBe(0);
  });

  it("R7: two requests racing on the same dead id share one resurrection", async () => {
    const before = mcpResurrectionCount();
    captureUpstream();

    const [a, b] = await Promise.all([callTool("fs_live_k", DEAD_ID, 31), callTool("fs_live_k", DEAD_ID, 32)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mcpSessionCount()).toBe(1);
    expect(mcpResurrectionCount()).toBe(before + 1);
  });

  it("R8: no Authorization at all is still 401 — resurrection needs a Bearer", async () => {
    const res = await callTool(null, DEAD_ID);
    expect(res.status).toBe(401);
    expect(mcpSessionCount()).toBe(0);
  });
});
