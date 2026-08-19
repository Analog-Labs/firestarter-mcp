#!/usr/bin/env node
/**
 * MCP stdio entrypoint — for CLI / npx usage.
 * For HTTP transport, see route.ts (mounted at /mcp in the main Hono app).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, makeApiRequest } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { SERVER_IDENTITY } from "./identity.js";

const API_KEY = process.env.FIRESTARTER_API_KEY;
const API_BASE = process.env.FIRESTARTER_API_URL || "https://api.firestarter.network";

if (!API_KEY) {
  console.error("FIRESTARTER_API_KEY environment variable is required");
  process.exit(1);
}

const server = new McpServer({
  name: "firestarter",
  // Same identity the remote transports send — these two have drifted before.
  ...SERVER_IDENTITY,
  // Kept in lockstep with mcpb/manifest.json — this string is what every
  // connecting client sees in the initialize handshake, so a drift makes an
  // installed extension misreport which build it is.
  version: "2.5.1",
});

registerTools(server, API_KEY, API_BASE);

const apiRequest = makeApiRequest(API_KEY, API_BASE);
registerResources(server, apiRequest);
registerPrompts(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
