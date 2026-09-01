/**
 * An MCP session id is a transport handle, not a credential.
 *
 * The Streamable-HTTP route used to bind every session to the SHA-256 of the
 * Bearer it was created with and answer any other Bearer on that session id
 * with 404. That was written against raw API keys, which never change — but an
 * OAuth access token (`fs_oauth_`, one-hour lifetime) is REPLACED on every
 * refresh. claude.ai refreshed at 14:09:20 UTC on 2026-08-31 and its very next
 * tool call, on the session it had been using for two minutes, got 404
 * "Session not found": the user saw "Unable to reach Firestarter" and the
 * shopping widget failed to render, twice. The same burst sits in the log after
 * every earlier refresh. This recurs once an hour for every OAuth-connected
 * client, in the middle of whatever they are doing.
 *
 * The property the binding was protecting is real: a leaked session id must not
 * let its holder act as the session's owner. The binding protected it the wrong
 * way. The right way is the MCP spec's: Authorization is carried on EVERY
 * request, and the session id MUST NOT be used for auth. So every upstream call
 * now carries the Bearer presented on the request that triggered it. A leaked
 * id then grants nothing — whoever presents it acts only as the credential they
 * present — and a refreshed token rides the session it was refreshed for.
 *
 * `initialize` is still reachable before the key has been validated upstream,
 * so the map stays bounded (S4/S5).
 *
 * Pinned here:
 *   S1  a refreshed Bearer keeps riding the session, and the calls it triggers
 *       reach the API under the NEW Bearer;
 *   S2  a session id confers no authority: a different Bearer's calls run as
 *       that Bearer, and the creator's key never leaves the server for them;
 *   S3  the creating key still works, and repeated use keeps it alive;
 *   S4  idle sessions are swept;
 *   S5  the resident count is capped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Read at module load, so they must be set before the dynamic import below.
process.env.MCP_SESSION_TTL_MS = "50";
process.env.MCP_MAX_SESSIONS = "3";
const route = await import("../../src/mcp/route.js");
const { default: app, mcpSessionCount, resetMcpSessions } = route as any;

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

const headers = (key: string, sessionId?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${key}`,
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

/** Open a session and return its id. */
async function openSession(key: string): Promise<string> {
  const res = await app.request("/", {
    method: "POST", headers: headers(key), body: JSON.stringify(INIT),
  });
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id");
  expect(id, "initialize should mint a session id").toBeTruthy();
  return id!;
}

/** A follow-up request on an existing session. */
const followUp = (key: string, sessionId: string) =>
  app.request("/", {
    method: "POST", headers: headers(key, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });

const CALL = {
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "firestarter_wallet_balance", arguments: {} },
};

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

/** A tool call on an existing session; drains the SSE body so the handler has run. */
async function callTool(key: string, sessionId: string): Promise<Response> {
  const res = await app.request("/", {
    method: "POST", headers: headers(key, sessionId), body: JSON.stringify(CALL),
  });
  await res.text().catch(() => "");
  return res;
}

beforeEach(() => { resetMcpSessions(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MCP HTTP session binding", () => {
  it("S1: a refreshed OAuth token keeps riding the session, and upstream calls carry the NEW token", async () => {
    const sessionId = await openSession("fs_oauth_before_refresh");
    const upstream = captureUpstream();

    // claude.ai after POST /oauth/token: same mcp-session-id, new access token.
    const res = await callTool("fs_oauth_after_refresh", sessionId);

    expect(res.status).toBe(200);
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((h) => h === "Bearer fs_oauth_after_refresh")).toBe(true);
  });

  it("S2: a session id confers no authority — a different Bearer's calls run as THAT Bearer, never as the creator's", async () => {
    const sessionId = await openSession("fs_live_alice");
    const upstream = captureUpstream();

    await callTool("fs_live_mallory", sessionId);

    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((h) => h === "Bearer fs_live_mallory")).toBe(true);
    expect(upstream.some((h) => h.includes("fs_live_alice"))).toBe(false);
  });

  it("S3: the creating key still works", async () => {
    const sessionId = await openSession("fs_live_alice");
    const res = await followUp("fs_live_alice", sessionId);
    expect(res.status).not.toBe(404);
  });

  it("S4: idle sessions are swept once past the TTL", async () => {
    await openSession("fs_live_alice");
    expect(mcpSessionCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 80)); // > MCP_SESSION_TTL_MS
    // The sweep is lazy, so some request has to run it.
    await followUp("fs_live_bob", "unknown-session-id");
    expect(mcpSessionCount()).toBe(0);
  });

  it("S5: the resident session count is capped", async () => {
    // Every one of these is an UNVALIDATED key — the flood an attacker can send.
    for (let i = 0; i < 8; i++) await openSession(`fs_live_flood_${i}`);
    expect(mcpSessionCount()).toBeLessThanOrEqual(3); // MCP_MAX_SESSIONS
  });

  it("still refuses a request with no Authorization header at all", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
  });
});
