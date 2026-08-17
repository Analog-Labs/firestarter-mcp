/**
 * OAuth 2.0 protected-resource metadata (RFC 9728) for the remote MCP server.
 *
 * This module is metadata only. It advertises WHERE to authenticate; it never
 * validates a token. Token validation lives in the API's auth middleware,
 * because this package is published to npm and auth policy must not ship to
 * third-party consumers.
 */

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
