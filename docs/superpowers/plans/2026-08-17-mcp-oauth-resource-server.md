# MCP OAuth Resource Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `firestarter-mcp` advertise itself as an OAuth 2.0 protected resource, so an MCP client that receives a 401 can discover the authorization server and start a flow.

**Architecture:** Two additions, both metadata-only. The 401 at `route.ts:160-195` gains an RFC 6750 `WWW-Authenticate` challenge pointing at a resource-metadata URL. A new `src/mcp/oauth-metadata.ts` serves the RFC 9728 document itself, exported as its own subpath so `firestarter-commerce` can mount it at the origin root — the metadata URL is not under `/mcp`, and this package's Hono app is mounted at `/mcp`, so it cannot serve that path itself. No token validation, no auth logic, no new dependencies land in this package: it is published to npm and auth policy belongs in the API.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Hono, Vitest, `@modelcontextprotocol/sdk`

**Spec:** `firestarter-commerce/docs/superpowers/specs/2026-08-17-mcp-oauth-design.md`

## Global Constraints

- Node `>=18.0.0`; package is ESM (`"type": "module"`); relative imports carry `.js` specifiers even though files on disk are `.ts`.
- **No new runtime dependencies.** This slice is string-and-JSON work.
- **No token validation in this package.** It advertises where to authenticate; it never decides whether a token is valid. That is `firestarter-commerce/apps/api/src/middleware/auth.ts`.
- Resource identifier: `https://api.firestarter.network/mcp`. Authorization server: `https://api.firestarter.network`.
- Metadata URL (RFC 9728 path-insertion form): `https://api.firestarter.network/.well-known/oauth-protected-resource/mcp`.
- Every new subpath must be added to `package.json` `exports`, following the existing `./route`, `./ws-transport`, `./platform` pattern.
- Version is synced across `package.json`, `mcp.json`, `src/mcp/mcp.json`, `mcpb/manifest.json`, and `src/mcp/server.ts` by `npm run sync-version` — never hand-edit one of them.
- CI (`.github/workflows/ci.yml`) triggers on `main` only in THIS repo, so a `staging`-based PR reports "no checks reported" — nothing runs. Verify locally with `npm test && npx tsc --noEmit` and put the output in the PR body. (`firestarter-commerce`'s workflow does include `staging`; do not read one repo's triggers as the other's.)

---

### Task 1: `WWW-Authenticate` challenge on the 401

Today an unauthenticated request gets `{"error": "Authorization header with Bearer token required"}` and nothing else. A client has no way to learn that OAuth is available or where the authorization server lives. RFC 6750 §3 says the challenge belongs in a `WWW-Authenticate` header; MCP clients read `resource_metadata` from it.

The `error="invalid_token"` parameter is deliberately omitted: no credentials were presented, and RFC 6750 §3.1 reserves that code for a token that was supplied and rejected.

**Files:**
- Create: `src/mcp/oauth-metadata.ts`
- Modify: `src/mcp/route.ts:150-165`
- Test: `tests/integration/mcp-oauth-discovery.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `oauthResourceBase(): string` — origin serving both the resource and the AS.
  - `resourceMetadataUrl(): string` — the full RFC 9728 metadata URL.
  - `wwwAuthenticateChallenge(): string` — the header value.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * OAuth discovery (RFC 9728 / RFC 6750).
 *
 * ChatGPT connectors cannot present a static API key — they do OAuth or
 * nothing. A client that gets a bare 401 has no way to learn an authorization
 * server exists, so the challenge header IS the entry point to the whole flow.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/mcp-oauth-discovery.test.ts`
Expected: FAIL — `expected null to be truthy` on D1, because no `WWW-Authenticate` header is set today.

- [ ] **Step 3: Create the metadata module**

Create `src/mcp/oauth-metadata.ts`:

```typescript
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
  const base = process.env.FIRESTARTER_PUBLIC_URL || process.env.FIRESTARTER_API_URL || "https://api.firestarter.network";
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
```

- [ ] **Step 4: Wire the challenge into the 401**

In `src/mcp/route.ts`, add the import beside the existing ones:

```typescript
import { wwwAuthenticateChallenge } from "./oauth-metadata.js";
```

Replace the 401 branch inside `app.all("/")`:

```typescript
  const apiKey = extractApiKey(c);
  if (!apiKey) {
    // RFC 6750 §3 — without this header a client cannot discover that OAuth is
    // available, which is the only way ChatGPT can ever connect.
    return c.json(
      { error: "Authorization header with Bearer token required" },
      401,
      { "WWW-Authenticate": wwwAuthenticateChallenge() },
    );
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integration/mcp-oauth-discovery.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Verify nothing else regressed**

Run: `npm test && npx tsc --noEmit`
Expected: full suite passes. `tests/integration/mcp-session-binding.test.ts` exercises the same handler and must stay green.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/oauth-metadata.ts src/mcp/route.ts tests/integration/mcp-oauth-discovery.test.ts
git commit -m "feat(mcp): advertise OAuth challenge on unauthenticated requests"
```

---

### Task 2: Serve the protected-resource metadata document

The challenge from Task 1 points at a URL that does not yet exist. This task serves it.

The document cannot be served by this package's mounted app: `firestarter-commerce` mounts it with `app.route("/mcp", mcpRoute)`, and the metadata path is `/.well-known/oauth-protected-resource/mcp` at the origin root. So export a second Hono app that the API mounts at the well-known path.

**Files:**
- Modify: `src/mcp/oauth-metadata.ts`
- Modify: `package.json` (exports map)
- Test: `tests/integration/mcp-oauth-discovery.test.ts`

**Interfaces:**
- Consumes: `oauthResourceBase()`, `resourceIdentifier()` from Task 1.
- Produces:
  - `protectedResourceMetadata(): object` — the RFC 9728 document.
  - `default` export from `@analog-labs/firestarter-mcp/oauth-metadata` — a Hono app serving `GET /` with that document, for mounting at `/.well-known/oauth-protected-resource/mcp`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/mcp-oauth-discovery.test.ts`:

```typescript
describe("protected-resource metadata document", () => {
  it("D4: serves the RFC 9728 document", async () => {
    const { default: metadataApp } = await import("../../src/mcp/oauth-metadata.js");
    const res = await metadataApp.request("/", { method: "GET" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const doc = await res.json();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/mcp-oauth-discovery.test.ts`
Expected: FAIL on D4 — the module has no default export yet.

- [ ] **Step 3: Add the document and its route**

Add `import { Hono } from "hono";` at the top of `src/mcp/oauth-metadata.ts`, then append:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/mcp-oauth-discovery.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Add the subpath export**

In `package.json`, add to `exports`, after the `"./route"` entry:

```json
    "./oauth-metadata": {
      "types": "./dist/mcp/oauth-metadata.d.ts",
      "default": "./dist/mcp/oauth-metadata.js"
    },
```

- [ ] **Step 6: Verify the build emits the subpath**

Run: `npm run build && ls dist/mcp/oauth-metadata.js dist/mcp/oauth-metadata.d.ts`
Expected: both files exist.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/oauth-metadata.ts package.json tests/integration/mcp-oauth-discovery.test.ts
git commit -m "feat(mcp): serve RFC 9728 protected-resource metadata"
```

---

### Task 3: Release so the API can consume it

`firestarter-commerce/apps/api/package.json` pins `"@analog-labs/firestarter-mcp": "2.3.0"` from npm — not a workspace link. Nothing above reaches production until a new version is published and that pin is bumped. This task is the handoff, and it is where phase 1 of the spec stops being blocked.

**Files:**
- Modify: `package.json` (version, via `npm version`)
- Verify: `mcp.json`, `src/mcp/mcp.json`, `mcpb/manifest.json`, `src/mcp/server.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: published `@analog-labs/firestarter-mcp@2.4.0` exposing `./oauth-metadata`.

- [ ] **Step 1: Bump the version — on a release branch, not the feature branch**

This repo releases from dedicated branches (`chore/release-2.1.3`), so the bump
does not belong in the feature PR. After the feature PR merges:

```bash
git checkout main && git pull && git checkout -b chore/release-2.4.0
npm version minor   # 2.3.0 → 2.4.0 — new export, backward compatible
```

`npm version` triggers `scripts/sync-version.mjs` via the `version` script and
stages the synced manifests.

- [ ] **Step 2: Verify every manifest agrees**

Run: `npx vitest run tests/unit/mcp-manifest-parity.test.ts tests/unit/mcpb-manifest.test.ts`
Expected: PASS. These exist because a version drifted between `server.ts` and the remote handshake before — see the comment at `src/mcp/route.ts:107-111`.

- [ ] **Step 3: Open the PR**

```bash
git push origin HEAD:refs/heads/feat/mcp-oauth-resource-metadata
gh pr create --base staging --title "feat(mcp): OAuth protected-resource discovery" --body "Implements the resource-server half of the MCP OAuth design. Metadata only — no token validation ships in this package."
```

Base is `staging` per the standing rule. Nothing will run on it — this repo's
`ci.yml` triggers on `main` only — so the local `npm test` / `tsc` output in the
PR body IS the verification. A clean-looking PR page here means nothing ran.

- [ ] **Step 4: Publish (requires human approval)**

Publishing is an outward-facing, irreversible action and needs an explicit go-ahead. Confirm the trusted-publishing environment guard is in place first — npm trusted publishing has no branch in its match tuple, so without an environment guard the OIDC path escapes branch protection.

- [ ] **Step 5: Bump the consumer**

In `firestarter-commerce/apps/api/package.json`, change `"@analog-labs/firestarter-mcp": "2.3.0"` to `"2.4.0"`, then mount the metadata app in `apps/api/src/index.ts` beside the existing `app.route("/mcp", mcpRoute)` at line 268:

```typescript
import oauthMetadataRoute from "@analog-labs/firestarter-mcp/oauth-metadata";

app.route("/.well-known/oauth-protected-resource/mcp", oauthMetadataRoute);
```

---

## What this plan does NOT do

Stated so the next plan's scope is unambiguous. After these three tasks a client can discover that OAuth exists and where to go — and then hit nothing, because the authorization server does not exist yet. Still required, all in `firestarter-commerce`:

- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register` (RFC 7591 dynamic client registration)
- `GET /oauth/authorize` + consent screen + org picker
- `POST /oauth/token` (PKCE S256, authorization_code + refresh_token)
- `api_keys` migration and the expiry check in `middleware/auth.ts`
- Scope enforcement and the money-movement deny-list

ChatGPT cannot connect until the authorization server ships. This slice is sequenced first only because the npm publish in Task 3 has release latency that the API work does not.
