/**
 * MCP Resources — browsable catalog and order history.
 *
 * Resources let MCP clients list and read structured data without tool calls.
 * Claude Desktop shows them in the sidebar; other clients can browse them.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerResources(
  server: McpServer,
  apiRequest: (method: string, path: string, body?: unknown) => Promise<any>
) {
  // ── Static resource: seller profile ───────────────────────────────────────
  server.resource(
    "seller-profile",
    "firestarter://seller/profile",
    { description: "Your seller profile, Stripe status, and earnings summary" },
    async () => {
      try {
        const seller = await apiRequest("GET", "/v1/sellers");
        const earnings = await apiRequest("GET", "/v1/sellers/earnings");
        return {
          contents: [{
            uri: "firestarter://seller/profile",
            mimeType: "application/json",
            text: JSON.stringify({ ...seller, earnings }, null, 2),
          }],
        };
      } catch {
        return { contents: [{ uri: "firestarter://seller/profile", mimeType: "text/plain", text: "No seller profile found. Register at firestarter.network/sell" }] };
      }
    }
  );

  // ── Dynamic resource: listing detail ──────────────────────────────────────
  server.resource(
    "listing",
    new ResourceTemplate("firestarter://listings/{listingId}", { list: undefined }),
    { description: "A specific product listing with pricing, inventory, and demand data" },
    async (uri, { listingId }) => {
      const listing = await apiRequest("GET", `/v1/listings/${listingId}`);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(listing, null, 2),
        }],
      };
    }
  );

  // ── Static resource: active listings ──────────────────────────────────────
  server.resource(
    "listings-catalog",
    "firestarter://listings",
    { description: "All your active product listings (seller catalog)" },
    async () => {
      const data = await apiRequest("GET", "/v1/listings");
      return {
        contents: [{
          uri: "firestarter://listings",
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // ── Static resource: recent orders (seller) ───────────────────────────────
  server.resource(
    "seller-orders",
    "firestarter://seller/orders",
    { description: "Your recent incoming orders with amounts and status" },
    async () => {
      const data = await apiRequest("GET", "/v1/sellers/orders");
      return {
        contents: [{
          uri: "firestarter://seller/orders",
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // ── Static resource: recent executions (buyer) ────────────────────────────
  server.resource(
    "buyer-orders",
    "firestarter://buyer/orders",
    { description: "Your recent purchase executions (buyer order history)" },
    async () => {
      const data = await apiRequest("GET", "/v1/executions?limit=20");
      return {
        contents: [{
          uri: "firestarter://buyer/orders",
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );

  // ── Dynamic resource: execution detail ────────────────────────────────────
  server.resource(
    "execution",
    new ResourceTemplate("firestarter://executions/{executionId}", { list: undefined }),
    { description: "Full detail of a specific purchase execution (status, options, steps, tracking)" },
    async (uri, { executionId }) => {
      const exec = await apiRequest("GET", `/v1/executions/${executionId}`);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(exec, null, 2),
        }],
      };
    }
  );

  // ── Static resource: seller analytics ─────────────────────────────────────
  server.resource(
    "seller-analytics",
    "firestarter://seller/analytics",
    { description: "Revenue, order count, and 30-day daily breakdown" },
    async () => {
      const data = await apiRequest("GET", "/v1/sellers/analytics");
      return {
        contents: [{
          uri: "firestarter://seller/analytics",
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    }
  );
}
