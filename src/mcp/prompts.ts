/**
 * MCP Prompts — pre-built conversation starters for common workflows.
 *
 * Prompts appear in clients' prompt picker (Claude Desktop sidebar, Cursor
 * command palette) and give users one-click access to common Firestarter flows.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
  // ── Buyer prompts ─────────────────────────────────────────────────────────

  server.prompt(
    "find-product",
    "Search for a product to buy",
    { query: z.string().describe("What are you looking for? (e.g. 'red leather jacket under $200')") },
    ({ query }) => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `I want to buy: ${query}. Search Firestarter for the best options, show me images and prices, and ask for my approval before purchasing.` },
      }],
    })
  );

  server.prompt(
    "check-order-status",
    "Check the status of a recent purchase",
    { execution_id: z.string().optional().describe("Order ID (exec_...) — leave empty to see all recent orders") },
    ({ execution_id }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: execution_id
            ? `Check the status of my order ${execution_id}. Include tracking info if shipped.`
            : `Show me my recent orders and their current status.`,
        },
      }],
    })
  );

  server.prompt(
    "track-delivery",
    "Track a shipped order's delivery progress",
    { execution_id: z.string().describe("The order ID to track (exec_...)") },
    ({ execution_id }) => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `Track the delivery of my order ${execution_id}. What carrier is it with, what's the tracking number, and when will it arrive?` },
      }],
    })
  );

  server.prompt(
    "set-price-alert",
    "Get notified when a product drops in price",
    {
      product: z.string().describe("Product to monitor (e.g. 'AirPods Pro')"),
      target_price: z.string().optional().describe("Target price to alert on (e.g. '$199')"),
    },
    ({ product, target_price }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: target_price
            ? `Set up a price alert for ${product}. Notify me when the price drops to ${target_price} or below.`
            : `Monitor the price of ${product} and notify me when it drops significantly.`,
        },
      }],
    })
  );

  // ── Seller prompts ────────────────────────────────────────────────────────

  server.prompt(
    "list-my-product",
    "List a new product for sale on Firestarter",
    {
      product_name: z.string().describe("What are you selling?"),
      price: z.string().describe("Price in USD (e.g. '$49.99')"),
    },
    ({ product_name, price }) => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `List my product "${product_name}" for sale at ${price}. Ask me for a photo if I haven't shared one, set reasonable shipping, and make it live.` },
      }],
    })
  );

  server.prompt(
    "import-from-url",
    "Import an existing product listing from another site",
    { url: z.string().describe("URL of the product listing to import") },
    ({ url }) => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `Import this listing to Firestarter: ${url}. Extract the product details, create a draft, and walk me through reviewing it before going live.` },
      }],
    })
  );

  server.prompt(
    "seller-dashboard",
    "View my seller analytics, orders, and listings",
    {},
    () => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `Show me my seller dashboard: total revenue, recent orders, and how my listings are performing. Highlight anything that needs my attention (pending orders, disputes, low inventory).` },
      }],
    })
  );

  server.prompt(
    "connect-shopify",
    "Connect my Shopify store to Firestarter",
    { shop_handle: z.string().optional().describe("Your store's .myshopify.com handle (e.g. 'my-store')") },
    ({ shop_handle }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: shop_handle
            ? `Connect my Shopify store "${shop_handle}" to Firestarter so my products are listed and orders flow back automatically.`
            : `I want to connect my Shopify store to Firestarter. Help me get set up — I need my catalog synced and orders flowing back to my store.`,
        },
      }],
    })
  );

  server.prompt(
    "setup-payouts",
    "Connect Stripe to receive earnings",
    {},
    () => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `Help me set up Stripe payouts so I can receive earnings from my Firestarter sales.` },
      }],
    })
  );
}
