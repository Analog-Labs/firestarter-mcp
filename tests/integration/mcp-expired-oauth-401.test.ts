/**
 * commerce#824: an expired fs_oauth_ grant used to be a trap. The upstream 401
 * (INVALID_KEY/EXPIRED_KEY) was swallowed into a *successful* tool result, so
 * the client never saw a transport-level 401, never ran its refresh flow, and
 * the agent told the seller their API key was revoked — forever, on every
 * retry ("Same auth error again", #819/#820).
 *
 * Pinned here: once a tool call on an fs_oauth_ session hits an upstream
 * credential 401, the NEXT request presenting THAT token answers HTTP 401 with
 * the RFC 6750 WWW-Authenticate challenge — the signal claude.ai needs to
 * refresh. The session itself survives: the refreshed token rides it and the
 * calls it triggers reach the API under the refreshed token, so the client's
 * retry-after-refresh succeeds without a reinitialize. Raw API keys
 * (fs_live_/fs_test_) keep today's behavior: their 401s mean revoked/invalid,
 * where a refresh cannot help.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const route = await import("../../src/mcp/route.js");
const { default: app } = route as any;

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

const CALL = {
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "firestarter_wallet_balance", arguments: {} },
};

const headers = (key: string, sessionId?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${key}`,
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
});

async function openSession(key: string): Promise<string> {
  const res = await app.request("/", {
    method: "POST", headers: headers(key), body: JSON.stringify(INIT),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await res.text().catch(() => "");
  return sid as string;
}

/** Every upstream API call 401s with the given code. */
function stub401(code: string) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ error: "expired", code }), {
      status: 401, headers: { "Content-Type": "application/json" },
    })
  ));
}

async function callTool(key: string, sid: string): Promise<Response> {
  const res = await app.request("/", {
    method: "POST", headers: headers(key, sid), body: JSON.stringify(CALL),
  });
  await res.text().catch(() => "");
  return res;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("expired fs_oauth_ grant → transport-level 401 challenge (commerce#824)", () => {
  it("the request AFTER an upstream credential 401 answers HTTP 401 with WWW-Authenticate", async () => {
    const key = "fs_oauth_expired_grant_1";
    const sid = await openSession(key);

    stub401("EXPIRED_KEY");
    const first = await callTool(key, sid);
    expect(first.status).toBe(200); // the in-flight call is already a tool result

    const next = await app.request("/", {
      method: "POST", headers: headers(key, sid), body: JSON.stringify(CALL),
    });
    expect(next.status).toBe(401);
    expect(next.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("the session survives the challenge — the refreshed token rides it, and upstream sees the refreshed token", async () => {
    const dead = "fs_oauth_expired_grant_2";
    const sid = await openSession(dead);

    stub401("INVALID_KEY");
    await callTool(dead, sid);

    const challenged = await app.request("/", {
      method: "POST", headers: headers(dead, sid), body: JSON.stringify(CALL),
    });
    expect(challenged.status).toBe(401);

    // What claude.ai does next: same mcp-session-id, new access token.
    const upstream: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      upstream.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""));
      return new Response(JSON.stringify({ balance_cents: 0, currency: "USD" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    const refreshed = await callTool("fs_oauth_refreshed_grant_2", sid);
    expect(refreshed.status).toBe(200);
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((h) => h === "Bearer fs_oauth_refreshed_grant_2")).toBe(true);
  });

  it("a raw fs_live_ key's upstream 401 does NOT kill the session — refresh can't help there", async () => {
    const key = "fs_live_revoked_key_1";
    const sid = await openSession(key);

    stub401("INVALID_KEY");
    await callTool(key, sid);

    const next = await callTool(key, sid);
    expect(next.status).toBe(200);
  });
});
