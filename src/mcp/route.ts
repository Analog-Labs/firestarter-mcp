/**
 * MCP HTTP route — serves the MCP Streamable HTTP transport at /mcp.
 *
 * Claude Code, Cursor, and other MCP clients can connect with:
 *   { "url": "https://api.firestarter.network/mcp", "headers": { "Authorization": "Bearer <API_KEY>" } }
 */
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools, makeApiRequest } from "./tools.js";
import { wwwAuthenticateChallenge } from "./oauth-metadata.js";
import { SERVER_IDENTITY } from "./identity.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const app = new Hono();

// Candidate locations for the prebuilt Desktop Extension (.mcpb), in priority
// order: bundled next to the compiled server (Docker runtime), then the repo's
// build output (local dev via `npm run build:mcpb`).
const __dirname = dirname(fileURLToPath(import.meta.url));
const MCPB_PATHS = [
  join(__dirname, "firestarter.mcpb"), // dist/mcp/firestarter.mcpb (Docker)
  join(__dirname, "..", "..", "mcpb", "dist", "firestarter.mcpb"), // local dev
];

// How long an idle session is kept before it is swept. A live client re-touches
// its session on every request, so this only reaps abandoned ones.
const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 30 * 60_000);
// Hard ceiling on resident sessions. `initialize` is reachable before the API
// key has been validated (validation happens upstream on the first tool call),
// so without a cap an unauthenticated caller can pin sessions in a loop.
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 1_000);

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  /** SHA-256 of the API key this session was created with. */
  keyHash: Buffer;
  lastSeen: number;
}

// Map of session ID → session. The transport is bound to the API key it was
// built with, so a request that presents a DIFFERENT key must not be allowed to
// ride it: the key was previously read once at creation and then never checked
// again, meaning anyone holding a leaked mcp-session-id operated as that
// session's owner — buying, changing payout destinations, withdrawing balances.
const sessions = new Map<string, SessionEntry>();

const hashKey = (apiKey: string): Buffer => createHash("sha256").update(apiKey).digest();

/** Constant-time compare of two SHA-256 digests. */
function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function dropSession(id: string, entry: SessionEntry): void {
  sessions.delete(id);
  void entry.transport.close?.();
}

/**
 * Drop sessions idle past the TTL, then evict oldest-first until the map fits
 * MAX_SESSIONS. Run lazily — on each request and again right after a session is
 * created — rather than on a timer, so it needs no unref'd interval and stays
 * trivially testable.
 *
 * Eviction is least-recently-used: a live client re-touches `lastSeen` on every
 * request, so under a flood of abandoned sessions the active ones are the last
 * to go. A determined flooder can still push out a legitimate session, but that
 * costs one reconnect, where unbounded growth costs the process.
 */
function sweepSessions(now: number): void {
  for (const [id, entry] of sessions) {
    if (now - entry.lastSeen > SESSION_TTL_MS) dropSession(id, entry);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const oldestFirst = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [id, entry] of oldestFirst.slice(0, sessions.size - MAX_SESSIONS)) {
    dropSession(id, entry);
  }
}

/** Test seam: current resident session count. */
export function mcpSessionCount(): number {
  return sessions.size;
}

/** Test seam: drop all sessions. */
export function resetMcpSessions(): void {
  sessions.clear();
}

/** Default upstream API base the MCP tools proxy to. */
export function mcpApiBase(): string {
  return process.env.FIRESTARTER_API_URL || "https://api.firestarter.network";
}

/**
 * Build an McpServer with the full Firestarter tool/resource/prompt surface,
 * bound to a caller's API key. Shared by every transport (Streamable HTTP,
 * stdio, WebSocket) so they expose an identical toolset.
 */
export function buildMcpServer(apiKey: string, apiBase: string): McpServer {
  const server = new McpServer({
    // Kept in lockstep with server.ts and mcpb/manifest.json by
    // scripts/sync-version.mjs. This is the version every REMOTE client sees in
    // the initialize handshake — api.firestarter.network/mcp reported 1.1.0
    // while the extension reported 2.1.0, because only server.ts was synced.
    version: "2.4.0",
    name: "firestarter",
    // Icons, website and description: a client can only render what the
    // handshake declares, which is why the ChatGPT connector showed no icon.
    ...SERVER_IDENTITY,
  });

  registerTools(server, apiKey, apiBase);

  const apiReq = makeApiRequest(apiKey, apiBase);
  registerResources(server, apiReq);
  registerPrompts(server);

  return server;
}

function createTransport(apiKey: string, apiBase: string): WebStandardStreamableHTTPServerTransport {
  const server = buildMcpServer(apiKey, apiBase);
  const keyHash = hashKey(apiKey);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      const now = Date.now();
      sessions.set(sessionId, { transport, keyHash, lastSeen: now });
      // Re-sweep AFTER inserting, so the cap holds including this session. The
      // request-path sweep runs before creation and would otherwise leave the
      // map sitting one over.
      sweepSessions(now);
    },
  });

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) sessions.delete(sessionId);
  };

  server.connect(transport);

  return transport;
}

// Extract API key from Authorization header
function extractApiKey(c: any): string | null {
  const auth = c.req.header("Authorization");
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1];
}

// Handle all MCP requests (POST for messages, GET for SSE stream, DELETE for session close)
app.all("/", async (c) => {
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    // RFC 6750 §3 — without this header a client cannot discover that OAuth is
    // available, which is the only way ChatGPT can ever connect.
    return c.json({ error: "Authorization header with Bearer token required" }, 401, {
      "WWW-Authenticate": wwwAuthenticateChallenge(),
    });
  }

  const apiBase = process.env.FIRESTARTER_API_URL || "https://api.firestarter.network";

  const now = Date.now();
  sweepSessions(now);

  // Check for existing session
  const sessionId = c.req.header("mcp-session-id");

  if (sessionId) {
    const entry = sessions.get(sessionId);
    // A session is only reusable by the key that created it. Mismatch returns
    // the SAME 404 as an unknown session id on purpose: distinguishing the two
    // would confirm that a given session id exists, which is exactly what an
    // attacker probing leaked ids wants to learn.
    if (!entry || !sameKey(entry.keyHash, hashKey(apiKey))) {
      return c.json({ error: "Session not found" }, 404);
    }
    entry.lastSeen = now;
    return entry.transport.handleRequest(c.req.raw);
  }

  // New session — create transport (only for POST with initialize)
  if (c.req.method === "POST") {
    const transport = createTransport(apiKey, apiBase);
    return transport.handleRequest(c.req.raw);
  }

  // GET/DELETE without session ID
  return c.json({ error: "Session ID required for GET/DELETE" }, 400);
});

// One-click Desktop Extension download. Public (no auth) — the user enters
// their API key in the install prompt; the key is stored in their OS keychain.
// Served at GET /mcp/download.
app.get("/download", async (c) => {
  for (const path of MCPB_PATHS) {
    try {
      const file = await readFile(path);
      return new Response(file, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="firestarter.mcpb"',
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (err) {
      // Missing file at this candidate path is expected — try the next one.
      // Anything else (permissions, corruption) is a real problem; rethrow so
      // the global error handler / Sentry can capture it.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  return c.json({ error: "Desktop Extension not available" }, 404);
});

export default app;
