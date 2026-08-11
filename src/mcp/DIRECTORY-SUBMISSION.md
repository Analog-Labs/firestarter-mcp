# Submitting Firestarter to the Connectors Directory

A human runs every step here. This guide does not submit anything for you.

Requirements come from Anthropic's
[submission page](https://claude.com/docs/connectors/building/submission) and
[pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria).

| | |
|---|---|
| Server name | `firestarter` |
| Display name | Firestarter Commerce |
| Version | `2.1.1` |
| Surface | 83 tools, 7 resources, 10 prompts |
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

Both artifacts are published by `release.yml` on every version tag. For `2.1.1`:

- `firestarter.mcpb`
- `firestarter-mcp-server-2.1.1.tgz`

at https://github.com/Analog-Labs/firestarter-mcp/releases/tag/v2.1.1

---

## Listing metadata

| Field | Value |
|---|---|
| Server URL | `https://api.firestarter.network/mcp` |
| Transport | Streamable HTTP (WebSocket also served on the same path) |
| Authentication | API key, `Authorization: Bearer fs_live_…` |
| Homepage | https://firestarter.network |
| Documentation | https://firestarter.network/mcp |
| Support | https://firestarter.network/docs |
| Privacy policy | https://firestarter.network/privacy |
| Icon | `mcpb/assets/icon-512.png` |
| Required env (local) | `FIRESTARTER_API_KEY` |
| Optional env (local) | `FIRESTARTER_API_URL` (default `https://api.firestarter.network`) |

**Description** (49 words):

> Firestarter turns natural language into real commerce. Describe what you want
> and the agent finds verified sellers, compares pricing and shipping, then buys
> only after your explicit approval — plus order tracking, returns, receipts, and
> disputes. Sellers can list and reprice products, sync Shopify catalogs, fulfill
> orders, and monitor payouts.

**Tagline** (55 char max): `Buy and sell real products, with approval before pay`

---

## Checklist status

Audited against the pre-submission checklist. Two items need a decision before
submitting; everything else passes.

| Criterion | Status |
|---|---|
| Separate read and write tools | Pass — 83 purpose-built tools, no catch-all `api_request`. The reader/setter split (`firestarter_spend_cap` / `firestarter_set_spend_cap`, and the auto-approve pair) exists for exactly this rule. |
| Reference API docs in custom query tools | N/A — no tool takes a freeform endpoint, path, or body. |
| Tool annotations | Pass — every tool has a `title` and a `readOnlyHint`/`destructiveHint`, enforced by `mcp-tool-annotations.test.ts` and `scripts/smoke-bundle.mjs`. |
| Tool names ≤ 64 chars | Pass — longest is `firestarter_untrust_community_drops`, 35. |
| Narrow, accurate descriptions | Pass — descriptions are generated into both manifests from the registered text and pinned by `mcp-manifest-parity.test.ts`. |
| Avoid prompt-injection patterns | **Needs work — see below.** |
| Functional quality | Pass — tools return actionable errors, not bare 500s. Re-verify via Inspector before submitting. |
| API ownership | Pass — first-party; the server domain matches the service. |
| Unsupported use cases | **Needs a decision — see below.** |
| Privacy policy (local connector) | Pass — "Privacy Policy" section in `README.md`, `privacy_policies` in `mcpb/manifest.json`, HTTPS URL live. Covers collection, use/storage, third-party sharing, retention, and contact. |
| Public documentation | Pass — https://firestarter.network/mcp returns 200. |
| Public repo (MCPB) | Pass. |
| Test credentials | **To prepare** — a fully populated account is required. |

### 1. Prompt-injection patterns

The checklist is explicit: *"Describe what the tool does. Do not tell Claude how
to behave."* Descriptions are rejected if they "tell Claude to behave in ways
unrelated to the tool's function."

**19 of 83 descriptions currently carry behavioural directives.** Examples:

- `firestarter_execute` — "ALWAYS pass the buyer's `location` …", "you do NOT
  need to ask for their street, zip, or phone"
- `firestarter_set_auto_approve_limit` — "Always confirm the exact dollar amount
  with the buyer before setting it — never invent, assume, or round a value"
- `firestarter_set_spend_cap` — "never tell the buyer you cannot change the cap"
- `firestarter_request_escrow` — "never automate messages to Craigslist or
  marketplace posters"

These are good agent guidance and they measurably improve behaviour, which is
why they are there. They are also the thing this rule names. Before submitting,
decide per description whether to keep it, and expect questions on the ones that
read as instructions rather than description. The safest rewrite states the
constraint as fact about the tool ("orders above the cap are rejected") rather
than as an order to Claude ("never tell the buyer …").

Since descriptions live in `tools.ts` and are synced outward, edit them there and
run `npm run sync-manifests`.

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
submitting rather than discovering it in review. If it is a problem, the seller
payout tools could ship only in the local extension, or be dropped from the
listed surface.

### 3. Authentication

Firestarter uses a static API key, not OAuth 2.0. The submission page lists
"Use OAuth 2.0 for authenticated services" as a requirement, but the portal's
Authentication step also accepts "a custom connection where users supply their
own URL or credentials at connection time," which is what Firestarter is. Not a
blocker on the face of it; expect it to be asked about.

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
