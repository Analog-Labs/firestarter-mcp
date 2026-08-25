# Firestarter MCP Server

The [Model Context Protocol](https://modelcontextprotocol.io) server for
[Firestarter](https://firestarter.network) — AI-native commerce execution.
Lets an AI assistant search real products, buy them with your approval, track
deliveries, and run a seller business end to end.

## Connect

The hosted server lives at **`https://api.firestarter.network/mcp`**
(streamable HTTP; WebSocket on the same path). Pick your client:

**Claude.ai (web, desktop app, mobile).** Settings → Connectors → *Add custom
connector* → paste the server URL. Claude discovers the OAuth endpoints
automatically and walks you through signing in with your Firestarter account —
no API key needed.

**Claude Code.**

```bash
claude mcp add --transport http firestarter https://api.firestarter.network/mcp
```

Authenticate via the OAuth prompt, or set a Bearer API key header if you prefer
a key.

**Claude Desktop (offline-friendly extension).** Download the packaged
extension from
[`https://api.firestarter.network/mcp/download`](https://api.firestarter.network/mcp/download)
(or grab `firestarter.mcpb` from the latest
[GitHub release](https://github.com/Analog-Labs/firestarter-mcp/releases)),
open it with Claude Desktop, and paste your API key when prompted — it is
stored in your OS keychain.

**Any other MCP client.** Remote: point it at the server URL with
`Authorization: Bearer fs_live_…` (or `fs_test_…` for sandbox). Local stdio:

```bash
FIRESTARTER_API_KEY=fs_test_... npx -y @analog-labs/firestarter-mcp
```

Get an API key at
[firestarter.network/dashboard](https://firestarter.network/dashboard); full
setup docs at [firestarter.network/mcp](https://firestarter.network/mcp).

## Authentication

Two supported schemes:

- **OAuth 2.0** — the server publishes RFC 9728 / RFC 8414 discovery metadata
  and answers unauthenticated requests with a `WWW-Authenticate` challenge.
  Dynamic client registration (RFC 7591) and PKCE S256 are supported, so
  OAuth-capable hosts (claude.ai, ChatGPT, Claude Code) connect with no
  pre-shared secret.
- **API keys** — `fs_live_…` / `fs_test_…` Bearer tokens from the dashboard,
  for clients and scripts that prefer a static credential.

## What's inside

86 tools, 7 resources, and 10 prompts covering the full commerce lifecycle:

- **Buying** — search and price real products, approve-gated checkout,
  receipts, delivery tracking, returns, disputes, and an inline shopping grid
  (MCP Apps) for browsing results.
- **Buyer safety** — saved addresses, payment methods, spend caps, and
  auto-approve limits.
- **Price monitoring** — watches with scheduled checks and notifications.
- **Selling** — listings, repricing, imports, Shopify/TikTok/store connectors,
  order fulfillment, analytics, and payouts.
- **Community markets & drops** — curated storefronts with revenue sharing.

Every tool declares `readOnlyHint` / `destructiveHint` / `openWorldHint`
annotations, enforced by tests, so MCP hosts can apply the right confirmation
policy per call.

## Developing

```bash
npm ci
npm run build        # builds the inline shopping UI, then compiles
npm test
npm run build:mcpb   # produces mcpb/dist/firestarter.mcpb
```

Set `FIRESTARTER_API_KEY` (`fs_live_...` for live orders, `fs_test_...` for
sandbox) to run the stdio server; `FIRESTARTER_API_URL` overrides the API base
for sandbox use.

## Safety model

Purchases never complete without an explicit approval step: `firestarter_execute`
finds and prices options, and only `firestarter_approve` charges. Tools that
move money or delete records are annotated `destructiveHint: true` so MCP hosts
prompt before running them; read-only tools are annotated so they don't.

## Privacy Policy

Full policy: **https://firestarter.network/privacy** · Questions: **privacy@firestarter.network**

This section covers the Firestarter Desktop Extension (`mcpb/`), which runs the
Firestarter MCP server locally and calls the Firestarter API on your behalf.

**What is collected.** The extension holds one credential you supply at install time: your
Firestarter API key. Claude Desktop stores it in your operating system's keychain, not in
plaintext config. Beyond that, the extension sends only what a request needs — the product
search or listing you ask about, and, when you approve a purchase, the order and delivery
address tied to it. It reads no files and collects no telemetry of its own.

**How it is used and stored.** Requests go over TLS to `https://api.firestarter.network`
(overridable via the `api_url` config for sandbox use) and are handled under the policy
linked above. Order, listing, and account records are stored server-side to run the
service. Payment card numbers are never stored by Firestarter; card details are handled by
the payment processor, and stored secrets are kept as cryptographic hashes.

**Third-party sharing.** Data is shared only where completing the transaction requires it —
principally the merchant fulfilling your order, plus payment and shipping providers. It is
not sold, and there is no third-party advertising or tracking.

**Retention.** Data is retained while your account is active; execution logs are retained
for 90 days. You may export your data or request deletion of your account from the
dashboard, or by writing to the address above.

**Your control.** Uninstalling the extension removes the stored API key from your keychain
and ends its access. Revoking the key in the Firestarter dashboard has the same effect
immediately, from any device.

## License

MIT — see [LICENSE](LICENSE).
