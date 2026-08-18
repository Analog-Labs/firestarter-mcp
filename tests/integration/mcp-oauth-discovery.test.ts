/**
 * OAuth discovery (RFC 9728 / RFC 6750).
 *
 * ChatGPT connectors cannot present a static API key — they do OAuth or
 * nothing. A client that gets a bare 401 has no way to learn an authorization
 * server exists, so the challenge header IS the entry point to the whole flow.
 *
 * Pinned here:
 *   D1  an unauthenticated request carries a WWW-Authenticate challenge;
 *   D2  the challenge omits error= when no credentials were presented;
 *   D3  a malformed Authorization header is challenged the same way;
 *   D4  the RFC 9728 document is served;
 *   D5  the challenge URL and the document agree on the resource;
 *   D6  the document is public.
 */
import { describe, it, expect } from "vitest";

const { default: app } = await import("../../src/mcp/route.js");

describe("MCP OAuth discovery", () => {
  it("D1: an unauthenticated request carries a WWW-Authenticate challenge", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge, "401 must tell the client where to authenticate").toBeTruthy();
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      'resource_metadata="https://api.firestarter.network/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("D2: the challenge omits error= when no credentials were presented", async () => {
    const res = await app.request("/", { method: "POST", headers: {}, body: "{}" });
    expect(res.headers.get("www-authenticate")).not.toContain("error=");
  });

  it("D3: a malformed Authorization header is still challenged", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { Authorization: "Basic abc123" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
  });
});

describe("protected-resource metadata document", () => {
  it("D4: serves the RFC 9728 document", async () => {
    const { default: metadataApp } = await import("../../src/mcp/oauth-metadata.js");
    const res = await metadataApp.request("/", { method: "GET" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.resource).toBe("https://api.firestarter.network/mcp");
    expect(doc.authorization_servers).toEqual(["https://api.firestarter.network"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("D5: the challenge URL and the document agree on the resource", async () => {
    const { resourceIdentifier, protectedResourceMetadata } = await import(
      "../../src/mcp/oauth-metadata.js"
    );
    expect(protectedResourceMetadata().resource).toBe(resourceIdentifier());
  });

  it("D6: the document is public — no Authorization required", async () => {
    const { default: metadataApp } = await import("../../src/mcp/oauth-metadata.js");
    const res = await metadataApp.request("/", { method: "GET" });
    expect(res.status).not.toBe(401);
  });
});
