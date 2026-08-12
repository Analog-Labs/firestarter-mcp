/**
 * An MCP session is a live credential. Binding and bounding it.
 *
 * The Streamable-HTTP route read the caller's API key once, at session creation,
 * and then never checked it again: a request carrying a known `mcp-session-id`
 * was routed straight to that session's transport, which is bound to the
 * ORIGINAL key. Anyone holding a leaked session id therefore operated as its
 * owner — buying, changing payout destinations, withdrawing wallet balances.
 *
 * The map was also unbounded. `initialize` is reachable before the key has been
 * validated (validation happens upstream on the first TOOL call), so a caller
 * with a syntactically-valid-but-bogus Bearer could pin sessions in a loop. That
 * is not theoretical — against production, `Bearer fs_test_probe` returned 200
 * and a resident mcp-session-id. Each entry carries a full McpServer with 83
 * tools, 7 resources, and 10 prompts.
 *
 * Pinned here:
 *   S1  a different key cannot ride an existing session;
 *   S2  the rejection is indistinguishable from an unknown session id, so it is
 *       not an oracle for "does this session exist?";
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

beforeEach(() => { resetMcpSessions(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("MCP HTTP session binding", () => {
  it("S1: a different API key cannot reuse an existing session", async () => {
    const sessionId = await openSession("fs_live_alice");
    const res = await followUp("fs_live_mallory", sessionId);
    expect(res.status).toBe(404);
  });

  it("S2: a wrong key and an unknown session id are indistinguishable", async () => {
    const sessionId = await openSession("fs_live_alice");

    const wrongKey = await followUp("fs_live_mallory", sessionId);
    const unknownSession = await followUp("fs_live_mallory", "11111111-2222-3333-4444-555555555555");

    // Differing responses would confirm a session id exists — exactly what an
    // attacker probing leaked ids wants to learn.
    expect(wrongKey.status).toBe(unknownSession.status);
    expect(await wrongKey.text()).toBe(await unknownSession.text());
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
