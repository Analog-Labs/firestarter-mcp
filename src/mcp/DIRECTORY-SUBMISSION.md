# Submitting Firestarter to the Connectors Directory

A human runs every step here. This guide does not submit anything for you.

Requirements come from Anthropic's
[submission page](https://claude.com/docs/connectors/building/submission) and
[pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria).

| | |
|---|---|
| Server name | `firestarter` |
| Display name | Firestarter Commerce |
| Version | `2.6.0` |
| Surface | 86 tools, 7 resources, 10 prompts |
| Repository | https://github.com/Analog-Labs/firestarter-mcp (public) |
| License | MIT |

---

## Two submissions, two paths

They are separate. Neither substitutes for the other.

**Remote MCP server** — `https://api.firestarter.network/mcp`, Streamable HTTP,
served by the Firestarter API. Submitted through the
[portal](https://claude.ai/admin-settings/directory/submissions/new) in Claude.ai
admin settings.

> **Access requirement:** the portal lives in organization admin settings, so it
> needs a **Team or Enterprise** org, and by default only Owners/Primary owners
> can submit. On individual plans the portal is not available at all. Confirm
> this before planning around a submission date.

**Desktop extension (`.mcpb`)** — the stdio server packed as an MCP Bundle. Uses
a different form entirely:
https://clau.de/desktop-extention-submission

Both artifacts are published by `release.yml` on every version tag — for the
current version, `firestarter.mcpb` and the npm tarball at
https://github.com/Analog-Labs/firestarter-mcp/releases/latest

---

## Listing metadata

| Field | Value |
|---|---|
| Server URL | `https://api.firestarter.network/mcp` |
| Transport | Streamable HTTP (WebSocket also served on the same path) |
| Authentication | OAuth 2.0 (DCR RFC 7591 + PKCE S256; RFC 9728/8414 discovery live) — API key `Authorization: Bearer fs_live_…` also supported |
| Homepage | https://firestarter.network |
| Documentation | https://firestarter.network/mcp |
| Support | https://firestarter.network/docs |
| Privacy policy | https://firestarter.network/privacy |
| Icon | `mcpb/assets/icon-512.png` |
| Required env (local) | `FIRESTARTER_API_KEY` |
| Optional env (local) | `FIRESTARTER_API_URL` (default `https://api.firestarter.network`) |
| App screenshots | **Required** — the shopping grid makes this an MCP App: 3–5 PNGs ≥1000px wide, cropped to the app response (no prompt visible), each with its prompt text supplied separately |

**Description** (49 words):

> Firestarter turns natural language into real commerce. Describe what you want
> and the agent finds verified sellers, compares pricing and shipping, then buys
> only after your explicit approval — plus order tracking, returns, receipts, and
> disputes. Sellers can list and reprice products, sync Shopify catalogs, fulfill
> orders, and monitor payouts.

**Tagline** (55 char max): `Buy and sell real products, with approval before pay`

---

## Checklist status

Audited against the pre-submission checklist. One item awaits an answer from
Anthropic (money movement) and one asset remains to prepare (test credentials);
everything else passes as of v2.6.0.

| Criterion | Status |
|---|---|
| Separate read and write tools | Pass — 86 purpose-built tools, no catch-all `api_request`. The reader/setter split (`firestarter_spend_cap` / `firestarter_set_spend_cap`, and the auto-approve pair) exists for exactly this rule. |
| Reference API docs in custom query tools | N/A — no tool takes a freeform endpoint, path, or body. |
| Tool annotations | Pass — every tool has a `title` plus explicit `readOnlyHint`/`destructiveHint`/`openWorldHint` (#59, v2.6.0), enforced by `mcp-tool-annotations.test.ts` and `scripts/smoke-bundle.mjs`. |
| Tool names ≤ 64 chars | Pass — longest is `firestarter_untrust_community_drops`, 35. |
| Narrow, accurate descriptions | Pass — descriptions are generated into both manifests from the registered text and pinned by `mcp-manifest-parity.test.ts`. |
| Avoid prompt-injection patterns | Pass since v2.6.0 (#58) — see below. |
| Functional quality | Pass — tools return actionable errors, not bare 500s. Re-verify via Inspector before submitting. |
| API ownership | Pass — first-party; the server domain matches the service. |
| Unsupported use cases | **Needs a decision — see below.** |
| Privacy policy (local connector) | Pass — "Privacy Policy" section in `README.md`, `privacy_policies` in `mcpb/manifest.json`, HTTPS URL live. Covers collection, use/storage, third-party sharing, retention, and contact. |
| Public documentation | Pass — https://firestarter.network/mcp returns 200. |
| Public repo (MCPB) | Pass. |
| Test credentials | **To prepare** — a fully populated account is required. |

### 1. Prompt-injection patterns — resolved in v2.6.0

The checklist is explicit: *"Describe what the tool does. Do not tell Claude how
to behave."* 43 descriptions carrying behavioural directives were restated as
neutral contracts in [#58](https://github.com/Analog-Labs/firestarter-mcp/pull/58)
("ALWAYS pass the buyer's location" became "when the buyer's location is
provided, results are localized…"); safety-critical confirmation is carried by
`destructiveHint` annotations rather than prose. Runtime **error strings**
deliberately keep their directive phrasing — the checklist wants actionable
error messages, and those are results, not descriptions.

When editing descriptions, keep the declarative register. They live in
`tools.ts` and are synced outward with `npm run sync-manifests`.

### 2. Money movement

The checklist lists as **not accepted**: *"Transfer money, cryptocurrency, or
other financial assets."*

Five tools move or expose funds: `firestarter_fund_wallet`,
`firestarter_withdraw_wallet`, `firestarter_wallet_balance`,
`firestarter_payouts`, `firestarter_connect_payouts`.

The rule most plausibly targets money-transmission apps rather than commerce
checkout, and buying a product is not a value transfer in that sense — but
`withdraw_wallet` moves money out to a seller's own account, which is closer to
the line. This is worth raising with `mcp-review@anthropic.com` **before**
submitting rather than discovering it in review (status: pre-clearance email
drafted 2026-08-19, awaiting their answer). If it is a problem, the seller
payout tools could ship only in the local extension, or be dropped from the
listed surface.

### 3. Authentication — resolved

OAuth 2.0 is live on the production endpoint: unauthenticated `POST /mcp`
returns 401 with a `WWW-Authenticate: Bearer resource_metadata="…"` challenge,
RFC 9728 protected-resource metadata resolves at
`/.well-known/oauth-protected-resource/mcp`, and the RFC 8414 document
advertises PKCE S256 plus dynamic client registration at `/oauth/register`.
In the portal's Authentication step, select **OAuth with dynamic client
registration** (supported out of the box) and flag the partial-auth behaviour:
`firestarter_preview` works keyless while other tools require auth. Static API
keys remain supported for non-OAuth clients.

For directory-scale traffic Anthropic recommends CIMD or Anthropic-held
credentials over DCR (DCR registers a new client per connection) — fine to
launch on DCR, revisit if connection volume grows.

### 4. Parallel track: the OpenAI plugin directory

A separate submission with its own rules —
[submission](https://developers.openai.com/plugins/deploy/submission),
[guidelines](https://developers.openai.com/plugins/app-guidelines). Key deltas
from Anthropic's process: physical-goods commerce is allowed but the sanctioned
pattern is **external checkout on your own domain** (or OpenAI's Checkout API) —
in-conversation charging via `firestarter_approve` needs a decision before
submitting; wallet tools are barred there too ("money transfer execution");
`openWorldHint` must be explicit on every tool (shipped in v2.6.0); the
authorization server must advertise a UserInfo endpoint with verified email
claims and serve a domain-verification token at
`/.well-known/openai-apps-challenge` (both shipped in firestarter-commerce);
a terms-of-service URL and OpenAI business verification are required.

---

## Verify before submitting

```bash
npm ci
npm run typecheck
npm test
npm run build:mcpb && npx mcpb validate mcpb/manifest.json
node scripts/smoke-bundle.mjs      # every tool has a title + safety hint
```

Then exercise the surface the way a reviewer will:

1. **MCP Inspector** against the live server — the checklist expects every tool
   to have been run:
   ```bash
   npx @modelcontextprotocol/inspector
   # URL: https://api.firestarter.network/mcp
   # Header: Authorization: Bearer fs_test_…
   ```
2. **As a custom connector in Claude**, per
   https://claude.com/docs/connectors/building/testing
3. **Install the `.mcpb`** from the release and confirm the tools appear and the
   API key prompt stores to the OS keychain.

A quick liveness check:

```bash
curl -s -X POST https://api.firestarter.network/mcp \
  -H "Authorization: Bearer fs_test_your_key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
```

Expect `200`, an `mcp-session-id` header, and `serverInfo.version` matching the
release. Unauthenticated `POST /mcp` must return `401`.

---

## Releasing a new version

Never hand-edit the version. Bump it in a PR:

```bash
npm version 2.1.2 --no-git-tag-version   # syncs all six files that state it
```

Merging to `main` runs the gates and publishes the tag, the `.mcpb`, and the
tarball. `main` is admin-restricted, so the bump goes through review like any
other change.

The six version sources are `package.json`, `mcp.json`, `src/mcp/mcp.json`,
`mcpb/manifest.json`, `src/mcp/server.ts` (stdio handshake) and `src/mcp/route.ts`
(remote HTTP/WS handshake). `route.ts` was missed for several releases and
reported `1.1.0` to every remote client; `mcpb-manifest.test.ts` now pins both.

---

## Troubleshooting

- **Reviewer says the manifest and runtime disagree.** Run
  `npm run sync-manifests` and `npm run sync-version`; both are enforced by tests.
- **Extension installs without an icon.** `mcpb/assets` must be packed alongside
  the manifest — `scripts/build-mcpb.mjs` handles this; don't hand-pack.
- **Server exits immediately.** `FIRESTARTER_API_KEY` is unset. Expected
  behaviour, with a clear message.
- **Tools hit the wrong host.** `FIRESTARTER_API_URL` is pointed elsewhere;
  remove it to fall back to production.
