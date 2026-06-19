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

const app = new Hono();

// Map of session ID → transport (for stateful sessions)
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

function createTransport(apiKey: string, apiBase: string): WebStandardStreamableHTTPServerTransport {
  const server = new McpServer({
    name: "firestarter",
    version: "1.0.0",
  });

  registerTools(server, apiKey, apiBase);

  const apiReq = makeApiRequest(apiKey, apiBase);
  registerResources(server, apiReq);
  registerPrompts(server);

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

export default app;
