/**
 * OAuth 2.0 protected-resource metadata (RFC 9728) for the remote MCP server.
 *
 * This module is metadata only. It advertises WHERE to authenticate; it never
 * validates a token. Token validation lives in the API's auth middleware,
 * because this package is published to npm and auth policy must not ship to
 * third-party consumers.
 */
import { Hono } from "hono";

/**
 * Public origin that serves both the MCP resource and the authorization
 * server. `FIRESTARTER_PUBLIC_URL` exists for staging, where the public origin
 * differs from the upstream API base the tools proxy to.
 */
export function oauthResourceBase(): string {
  const base =
    process.env.FIRESTARTER_PUBLIC_URL ||
    process.env.FIRESTARTER_API_URL ||
    "https://api.firestarter.network";
  return base.replace(/\/+$/, "");
}

/** The resource identifier clients bind tokens to (RFC 8707 `resource`). */
export function resourceIdentifier(): string {
  return `${oauthResourceBase()}/mcp`;
}

/**
 * RFC 9728 §3.1 path-insertion form: the resource's path is appended to the
 * well-known segment, NOT to the end. For `https://host/mcp` the document
 * lives at `https://host/.well-known/oauth-protected-resource/mcp`.
 */
export function resourceMetadataUrl(): string {
  return `${oauthResourceBase()}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * RFC 6750 §3 challenge. `error=` is deliberately absent: it is only correct
 * when a token was presented and rejected, and this challenge is returned when
 * none was presented at all.
 */
export function wwwAuthenticateChallenge(): string {
  return `Bearer resource_metadata="${resourceMetadataUrl()}"`;
}

/**
 * RFC 9728 protected-resource metadata.
 *
 * `scopes_supported` advertises the single fixed profile the design settled
 * on: read plus buy-with-approval. Money-movement tools are denied to OAuth
 * credentials at the API regardless of scope, so there is no scope to request
 * for them and none is listed here.
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resourceIdentifier(),
    authorization_servers: [oauthResourceBase()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["firestarter:commerce"],
    resource_documentation: "https://firestarter.network/docs/mcp",
  };
}

/**
 * Mount at `/.well-known/oauth-protected-resource/mcp` in the API. Public by
 * design — discovery precedes authentication, so requiring a credential here
 * would make the document undiscoverable to the clients that need it.
 */
const metadataApp = new Hono();

metadataApp.get("/", (c) => c.json(protectedResourceMetadata()));

export default metadataApp;
