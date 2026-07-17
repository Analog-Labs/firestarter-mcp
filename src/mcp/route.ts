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
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const app = new Hono();

// Candidate locations for the prebuilt Desktop Extension (.mcpb), in priority
// order: bundled next to the compiled server (Docker runtime), then the repo's
// build output (local dev via `npm run build:mcpb`).
const __dirname = dirname(fileURLToPath(import.meta.url));
const MCPB_PATHS = [
  join(__dirname, "firestarter.mcpb"), // dist/mcp/firestarter.mcpb (Docker)
  join(__dirname, "..", "..", "mcpb", "dist", "firestarter.mcpb"), // local dev
];

// Map of session ID → transport (for stateful sessions)
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

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
    name: "firestarter",
    version: "1.1.0",
  });

  registerTools(server, apiKey, apiBase);

  const apiReq = makeApiRequest(apiKey, apiBase);
  registerResources(server, apiReq);
  registerPrompts(server);

  return server;
}

function createTransport(apiKey: string, apiBase: string): WebStandardStreamableHTTPServerTransport {
  const server = buildMcpServer(apiKey, apiBase);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      transports.set(sessionId, transport);
    },
  });

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) transports.delete(sessionId);
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
    return c.json({ error: "Authorization header with Bearer token required" }, 401);
  }

  const apiBase = process.env.FIRESTARTER_API_URL || "https://api.firestarter.network";

  // Check for existing session
  const sessionId = c.req.header("mcp-session-id");

  if (sessionId && transports.has(sessionId)) {
    // Route to existing transport
    const transport = transports.get(sessionId)!;
    return transport.handleRequest(c.req.raw);
  }

  if (sessionId && !transports.has(sessionId)) {
    // Invalid session
    return c.json({ error: "Session not found" }, 404);
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
