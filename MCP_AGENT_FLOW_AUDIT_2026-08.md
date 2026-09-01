# Firestarter MCP — Buyer & Seller Agent-Flow Audit

**Date:** 2026-08-12 · **Version audited:** 2.1.2 (`2e0f30f`) · **Scope:** `firestarter-mcp` (83 tools), plus the `/mcp` mount in `firestarter-commerce`

**Baseline at audit time:** `npx vitest run` → 58 files, 483 tests, all passing. Everything below was a gap in what is *modelled/covered*, not a regression.

> **Status, 2026-08-12.** Findings #0-#5, #7 and #9 are fixed across two PRs:
> [firestarter-commerce#721](https://github.com/Analog-Labs/firestarter-commerce/pull/721) (the setup guide)
> and the `fix/agent-flow-audit` PR in this repo (everything else).
> Suite now 61 files / 522 tests. Remaining: #6, #8, #10-#15.

The question this audit asks is narrow and specific: **when a buyer's or seller's agent drives these tools, does it get where it needs to go?** Not "is the code correct" — mostly it is, and it is unusually thoughtful — but "does an LLM holding only `tools/list` output and tool results complete the journey without dead-ending, guessing, or buying the wrong thing."

---

## Executive summary

| # | Finding | Journey | Severity |
|---|---|---|---|
| **0** ✅ | **The public setup guide at `/mcp` specifies the wrong transport — every manual-setup snippet fails with HTTP 400** | **Onboarding** | **Critical** |
| 1 ✅ | `firestarter_preview` never prints the listing id — the handoff to `execute` is unusable in text-only hosts | Buyer | **High** |
| 2 ✅ | "Still searching" is rendered to the agent as **"No matches"** | Buyer | **High** |
| 3 ✅ | Approve resolves an option by *index* against a re-fetch sorted on mutable keys; the safe `option_id` path is unreachable | Buyer | **High** |
| 4 ✅ | Money-moving tools annotated `destructiveHint: false` — hosts won't prompt | Both | **High** |
| 5 ✅ | The annotation test asserts a rule it doesn't enforce (9-tool allowlist over 83 tools) | Both | Medium |
| 6 | 83 tools / 125 KB / ~35k tokens of `tools/list` before the agent does anything | Both | Medium |
| 7 ✅ | `firestarter_shipping_estimate` is documented read-only but annotated `readOnlyHint: false` | Buyer | Medium |
| 8 | `execute` has no `quantity` param, though `preview` does | Buyer | Medium |
| 9 ✅ | HTTP transport: `mcp-session-id` is not bound to the API key; session map never expires | Both | Medium |
| 10 | Dead `wise` / `payoneer` params and handler branches in `firestarter_payouts` | Seller | Low |
| 11 | `confirm_delivery` / `review` fall back to the *execution* id as an order id | Buyer | Low |
| 12 | `approve` has no idempotency key, though `withdraw_wallet` does | Buyer | Low |
| 13 | `crypto.randomUUID()` sits outside the `try` in `withdraw_wallet` | Market owner | Low |
| 14 | Version drift: repo `2.1.2`, live `2.1.3`, submission guide `2.1.1` | Release | Low |
| 15 ✅ | Setup guide steers every new user to a `fs_live_` key; test mode is never mentioned | Onboarding | Medium |

---

## What is already right

Worth stating plainly, because it shapes what the fixes should preserve:

- **Margin, duties, and discount disclosure land *with* the price**, before approval — not after ([tools.ts:944-950](src/mcp/tools.ts#L944-L950), [tools.ts:1073-1075](src/mcp/tools.ts#L1073-L1075)). The all-in shown is computed by the same pure function the charge path uses, so shown == charged.
- **`PRICE_CHANGED` carries a single-use `consent_nonce`** ([tools.ts:1646-1660](src/mcp/tools.ts#L1646-L1660)) — an agent cannot re-approve a moved price by guessing. That is the correct shape for machine consent.
- **Browse-only options are labelled honestly by *why***: external result vs. a Firestarter store that hasn't enabled checkout vs. the seller's own listing ([tools.ts:962-970](src/mcp/tools.ts#L962-L970)). Each gets a different instruction to the agent.
- **Auth error text distinguishes "bad key" from "right key, wrong endpoint"** ([tools.ts:74-89](src/mcp/tools.ts#L74-L89)) and explicitly tells the agent no search ran — which stops the model fabricating a search result.
- **The relevance floor refuses to pitch a weak match as buyable** ([tools.ts:1277-1286](src/mcp/tools.ts#L1277-L1286)).
- **The image budget is derived from the 1 MB tool-result ceiling**, with a running total as the hard backstop ([tools.ts:558-572](src/mcp/tools.ts#L558-L572)).

The prose in these descriptions is doing real work. The findings below are mostly places where the *plumbing* doesn't carry what the prose promises.

---

## 0. The public setup guide specifies the wrong transport — Critical

**Where:** [`apps/web/src/pages/MCP.tsx:20-72`](../firestarter-commerce/apps/web/src/pages/MCP.tsx#L20-L72) (the page served at `https://firestarter.network/mcp`)

Every manual-setup snippet on the page — Claude Code, Claude Desktop, and Cursor — specifies **SSE**:

```bash
claude mcp add firestarter \
  --transport sse \
  --url https://api.firestarter.network/mcp \
  --header "Authorization: Bearer fs_live_YOUR_KEY"
```

```json
{ "mcpServers": { "firestarter": {
    "transport": "sse",
    "url": "https://api.firestarter.network/mcp", ... } } }
```

The server does not serve SSE. [`route.ts`](src/mcp/route.ts) mounts
`WebStandardStreamableHTTPServerTransport` — **Streamable HTTP**, the transport that replaced SSE.
There is no `/sse` + `/messages` endpoint pair anywhere in the codebase.

**The page's own linked manifest says so.** The banner at the top of the same page links to
`/.well-known/mcp.json`, which is generated from the real tool set and declares:

```json
{ "endpoint": "https://api.firestarter.network/mcp", "transport": "streamable-http" }
```

### Verified against production, 2026-08-12

An SSE client's first move is `GET` the URL expecting a `text/event-stream` with an `endpoint` event:

```console
$ curl -i -H "Authorization: Bearer …" -H "Accept: text/event-stream" \
       https://api.firestarter.network/mcp
HTTP/2 400
content-type: application/json
```

`{"error":"Session ID required for GET/DELETE"}` — from the final fallthrough in `app.all("/")`,
which only handles `POST` for new sessions. The correct transport connects cleanly:

```console
$ curl -i -X POST https://api.firestarter.network/mcp \
       -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
       -d '{"jsonrpc":"2.0","id":1,"method":"initialize",…}'
HTTP/2 200
content-type: text/event-stream
mcp-session-id: 1a525150-27f6-4fa2-a062-3d1eb88d9745
```

**This is not a degraded experience — it is a hard failure.** Anyone who follows the documented
manual setup for Claude Code, Cursor, or the Claude Desktop config file cannot connect at all. Only
the two paths that never name a transport work: the `.mcpb` download and the Claude Desktop
"Connectors" UI. Those are presented as alternatives to manual setup, so a developer who prefers a
config file — the Claude Code and Cursor audience the section is written for — hits a wall.

**Fix (as shipped in [#721](https://github.com/Analog-Labs/firestarter-commerce/pull/721)).** A blanket
`sse` → `http` swap would *not* have worked. Each client's config differs, and checking the current
docs turned up two further errors in the Claude Code snippet alone:

| Client | Was | Now |
|---|---|---|
| Claude Code | `--transport sse`, `--url <url>` | `--transport http`, **URL positional** — there is no `--url` flag |
| Claude Code (JSON) | `"transport": "sse"` | `"type": "http"` — a `url` with no `type` is read as stdio and skipped |
| Cursor | `"transport": "sse"` + url | `url` + `headers` only; Cursor has no transport/type key |
| Windsurf | `serverUrl` + headers | unchanged, already correct |
| Claude Desktop | config-file block | removed — Desktop does not take a remote server this way |

The snippets moved out of the JSX component into `mcpConfigs.ts` so `mcpConfigs.test.ts` can pin the
transport against the manifest's value and each snippet against its client's documented shape.

### Two further inaccuracies on the same page

- **Contradictory Claude Desktop instructions.** The page tells Desktop users to edit
  `claude_desktop_config.json` (line 30) *and* to use Settings → Connectors (line 127) *and* to
  install the `.mcpb` (line 105). Three paths, no guidance on which to pick. The `.mcpb` is the one
  the submission guide treats as canonical — lead with it and drop the config-file block for Desktop.
- **`firestarter_cancel` is described wrongly.** The page says it will *"Cancel an execution and
  trigger an automatic refund if it has already been paid."* The tool's real contract
  ([tools.ts:2016](src/mcp/tools.ts#L2016)) adds a restriction the page omits: **an order that has
  already shipped cannot be cancelled** — it returns `ORDER_ALREADY_SHIPPED` and directs the caller
  to `firestarter_return`. A buyer reading the page expects cancel-anytime.
- **`firestarter_execute` is described as searching "Google Shopping and Shopify stores."** It also
  searches the Firestarter seller catalog ([tools.ts:23-26](src/mcp/tools.ts#L23-L26)) — which is the
  only source that is actually *buyable through Firestarter*. The description omits the part that
  makes the product work.
- **5 of 83 tools are documented.** Reasonable as a highlight reel, but the page is the value in the
  "Documentation" field of the directory submission. Nothing there covers the seller journey at all.

---

## 15. Setup guide steers everyone to a live key — Medium

Related to #0 and worth calling out separately. Every snippet and every instruction on the page uses
`fs_live_YOUR_KEY`, and the phrase "test mode" appears nowhere.

The server has a genuinely good sandbox: an `fs_test_…` key routes every purchase through simulated
payment, shipping, and tracking — no real money, no real seller contacted — and `firestarter_status`
goes out of its way to report which mode is active ([tools.ts:1483-1485](src/mcp/tools.ts#L1483-L1485)).

For a tool whose very first successful action can charge a card, sending every new developer straight
to a live key is the wrong default. Add a line to the manual-setup section: *"Use `fs_test_…` while
you're wiring things up — every order is simulated. Swap to `fs_live_…` when you're ready to spend."*

---

## 1. `firestarter_preview` never gives the agent an id — High

**Where:** [tools.ts:1435-1454](src/mcp/tools.ts#L1435-L1454)

The preview handler renders each option as:

```
1. **Sony WH-1000XM5** — $348.00 + free shipping · AudioHub
   ✓ buyable through Firestarter
```

…and closes with:

> `N options are buyable now — call firestarter_execute (or pass a listing_id) to purchase, after confirming with the buyer.`

**The id is never in the text.** For a *buyable* option the `url` isn't printed either (only browse-only rows get `— view: <url>`). So for exactly the options the buyer is most likely to choose, the agent's text context contains **no identifier and no link** — nothing to pin a purchase to.

The id *is* in `structuredContent` ([schemas.ts:36](src/mcp/schemas.ts#L36) `previewOption.id`), but `structuredContent` support is uneven across hosts. Any host that renders only `content` — which is the conservative default — leaves the model with product names and prices only.

**What the agent does instead:** falls back to `firestarter_execute({ request: "Sony WH-1000XM5" })`, which re-runs the full multi-source search (25–45 s per the comments at [tools.ts:23-30](src/mcp/tools.ts#L23-L30)) and may rank a *different* seller's listing first. The buyer picked option 1; they may get option 4.

Note the inconsistency: `firestarter_catalog_search` — the sibling browse tool — **does** print `id: \`${l.id}\`` on every row ([tools.ts:3676](src/mcp/tools.ts#L3676)).

**Fix (1 line):** mirror catalog_search — append `` `\n   id: \`${o.id}\`` `` for options where `o.purchasable` (the id is only chainable for FS-store sources; the schema comment already says so). Add a test asserting the id appears in `content[0].text`, not just in `structuredContent`.

---

## 2. "Still searching" is reported as "No matches" — High

**Where:** [tools.ts:367-388](src/mcp/tools.ts#L367-L388) and [tools.ts:1293-1305](src/mcp/tools.ts#L1293-L1305)

`pollExecution` breaks its wait loop on **any** exception:

```ts
try {
  const poll = await apiRequest("GET", `/v1/executions/${executionId}/poll`);
  if (poll.has_options || TERMINAL_STATUSES.includes(poll.status)) break;
} catch {
  // Fallback: if /poll 404s (old API version), break and fetch full.
  break;
}
```

The comment scopes this to a 404 from an older API, but the `catch` is unqualified — a transient 500, a DNS blip, or the 12 s per-request timeout on the **first** tick exits the loop immediately, with no retry. It then does a single full fetch of an execution that is very likely still `finding`.

Back in the `execute` handler, the empty-options branch does not check status:

```ts
} else if (exec.status === "failed" || !Array.isArray(exec.options) || exec.options.length === 0) {
  // → "**No matches — do you know where the buyer is?**"
```

An execution in `finding` or `quoting` has no options yet, so it takes this branch. The agent receives a response that says `Status: finding` on one line and **"No matches"** in bold on the next. Models follow the bolded, action-shaped line.

This also fires on the plain timeout path: the poll cap is 45 s, and the code's own comments record prod server-side preview latency "already peaking at 27s" before the agent → MCP → gateway → API hops are added. A cold cache is a realistic way to hit it.

**Consequence:** on the single most important buyer moment, the agent tells the buyer nothing was found while the search is still running and will shortly produce options. The buyer walks away; the execution completes into the void.

**Fix:** branch on non-terminal status *before* the empty-options branch and say so —

```ts
const STILL_WORKING = ["finding", "quoting", "pending", "running"];
if (STILL_WORKING.includes(exec.status)) {
  blocks.push({ type: "text", text:
    `\n\n**Still searching** — this one is taking longer than usual. Nothing has failed and no card is involved. ` +
    `Check back with \`firestarter_status\` (execution \`${exec.id}\`) in a few seconds.` });
}
```

Separately, narrow the `catch` in `pollExecution` to break only on a genuine 404 and otherwise continue the loop (a transient error should cost one tick, not the whole wait).

---

## 3. Option selection is index-based, and the safe path is unreachable — High

**Where:** [tools.ts:1592-1610](src/mcp/tools.ts#L1592-L1610)

When the agent passes `selected_option: 2`, approve re-fetches the execution and indexes into the returned array:

```ts
// The approve route takes an option *id*; resolve the displayed index
// against the execution's options (same match_score DESC order the agent saw).
const exec = await apiRequest("GET", `/v1/executions/${execution_id}`);
const opts = Array.isArray(exec.options) ? exec.options : [];
const chosen = opts[selected_option];
```

**The stated contract is wrong.** The API does not sort by `match_score DESC`. Per [`execution-response.ts:381-387`](../firestarter-commerce/apps/api/src/lib/execution-response.ts#L381-L387) it sorts by **`selected` first, then `purchasable`, then `match_score`**:

```ts
.sort((a, b) => {
  if (a.selected !== b.selected) return a.selected ? -1 : 1;
  if (a.purchasable !== b.purchasable) return a.purchasable ? -1 : 1;
  return (b.match_score ?? -Infinity) - (a.match_score ?? -Infinity);
});
```

Two of the three sort keys are **mutable between the render and the approve**. `selected` moves an option to index 0. `purchasable` flips when a store enables checkout or a re-quote lands. Any `firestarter_message` refinement re-runs find/quote and can change both — while the agent is still holding the numbering from the earlier render.

In the common path (execute polls to `awaiting_approval`, worker has already pre-selected, agent approves immediately) the order is stable and this is fine. The exposure is the refine-then-approve path and any re-quote in between. There is **no cross-check** — no title or price comparison against what the agent displayed — so a mismatch charges the buyer for a product they did not choose, silently.

**The escape hatch is documented but unreachable.** `option_id` is described as *"Exact option id (e.g. 'opt_abc123') … as returned in API errors or the execution resource."* But `formatExecution` **never renders `opt.id`** (verified across [tools.ts:954-1101](src/mcp/tools.ts#L954-L1101)). A text-only agent has no way to obtain an `opt_…` id from normal tool output, so it is forced onto the fragile index path.

**Fix:** render the id on each option line in `formatExecution` (same one-line change as finding #1), and update `firestarter_approve`'s description to prefer `option_id` over `selected_option`. Optionally have approve echo the resolved option's title/price in its confirmation so a mis-resolution is visible rather than silent.

---

## 4. Money-moving tools are annotated non-destructive — High

The README states the safety model as:

> *"Tools that move money or delete records are annotated `destructiveHint: true` so MCP hosts prompt before running them."*

A full annotation dump of all 83 registered tools contradicts this. Tools that spend, redirect, or forgive money while advertising `destructiveHint: false`:

| Tool | What it actually does | Annotated |
|---|---|---|
| `firestarter_assist_book` | *"dispatches a real crew and the fee is charged to the buyer's order"* | `destr=false` |
| `firestarter_payouts` | Sets/changes where **all seller earnings** are sent (Stripe/PayPal) | `destr=false` |
| `firestarter_connect_payouts` | Same, for market-owner earnings | `destr=false` |
| `firestarter_create_voucher` | *"YOU FUND THE DISCOUNT: it comes out of your proceeds"* — up to 100% | `destr=false` |
| `firestarter_create_drop` | Commits wallet/seller funds to a discount pot | `destr=false` |
| `firestarter_seller_disputes` (`action: "refund"`) | Issues a **full refund** and releases escrow | `destr=false` |
| `firestarter_disputes` (`accept` / `withdraw`) | Settles or abandons an escrow claim | `destr=false` |
| `firestarter_join_market` / `firestarter_leave_market` | Redirects fee attribution; description itself says *"Confirm with the buyer before calling — this is an account-level change"* | `destr=false` |

`firestarter_assist_book` is the sharpest case: its own description tells the *model* to get explicit human confirmation, but the annotation tells the *host* it needn't prompt. The safety guarantee is delegated to the model's compliance with prose — which is exactly what annotations exist to avoid.

`firestarter_payouts` is the highest-value one: changing a payout destination is the single most attractive target for a prompt-injected agent, and it currently runs unprompted.

**Fix:** set `destructiveHint: true` on the above. Note that `destructiveHint` is only meaningful when `readOnlyHint: false`, which is already the case for all of them.

---

## 5. The annotation test asserts a rule it doesn't enforce — Medium

**Where:** [tests/unit/mcp-tool-annotations.test.ts](tests/unit/mcp-tool-annotations.test.ts)

The file header states the generating rule precisely:

> *"a tool is read-only only if every request it issues is a GET. Anything that POSTs, PATCHes, PUTs, or DELETEs is a write, and the subset that moves money or destroys a record is destructive."*

But the tests only check a hand-maintained `DESTRUCTIVE` list of 9 tools and a `READ_ONLY` list of 6 — 15 of 83. The remaining 68 are checked only for *presence* of an annotation, never for correctness. That is exactly how finding #4 accumulated: each new money tool was added with a copy-pasted `destructiveHint: false` and no test objected.

Two further gaps:

- `allTools()` matches only `/^\s*server\.tool\(\s*$/`, so **`firestarter_preview`** — registered via `registerToolCompat` — is invisible to every assertion in the file.
- The test greps source text rather than reading the registered annotations, so it cannot see what a client actually receives.

**Fix:** build the server in-memory, call `listTools()`, and assert against real annotations. Add an inverted check with an explicit exemption list — *"every tool whose handler contains a POST/PUT/PATCH/DELETE to a money or account path must be `destructiveHint: true`"* — so the next money tool fails the build rather than shipping silently.

---

## 6. Context cost: 83 tools, ~35k tokens before anything happens — Medium

Measured by building the server and serializing a real `tools/list`:

```
tools:                    83
tools/list JSON bytes:    128,062  (125.1 KB)
rough tokens:             ~35,600
top-level descriptions:   47,298 chars   (median 512, max 2,138)
```

Heaviest single tools: `firestarter_list` 8.1 KB, `firestarter_execute` 6.2 KB, `firestarter_preview` 5.3 KB, `firestarter_approve` 5.0 KB. The remaining 71 tools total 78 KB.

Every agent pays this on every conversation, buyer and seller alike — a buyer purchasing coffee loads all 30+ market/community/drop/wallet tools and the full seller catalog surface. On smaller-context hosts this crowds out the conversation; on all hosts it measurably degrades tool-selection accuracy, because 83 candidates with overlapping semantics is a hard retrieval problem. There are, for example, three distinct search-ish tools (`preview`, `catalog_search`, `execute`) plus `market_preview` and `discover_markets`.

The descriptions are long for a *good* reason — they encode hard-won behavioural corrections (don't collect a card up front; don't pre-select a weak match; don't re-ask for the address). This is not a case for cutting prose.

**Fix (in order of payoff):**
1. **Serve role-scoped toolsets.** The key already knows whether the org is a seller. Gate the ~30 seller tools and ~20 market tools behind capability, or expose `?toolset=buyer|seller|market` on the HTTP mount and a config option on the `.mcpb`. A buyer-only surface is ~20 tools / ~30 KB.
2. **Collapse the market/drop cluster.** `trust_community_drops` / `untrust_community_drops`, `approve_drop` / `reject_drop`, `watch` / `unwatch` / `check` are action-pairs that belong as an `action` enum on one tool — the pattern `firestarter_drops` and `firestarter_disputes` already use well.
3. Move the multi-paragraph flow narratives out of `description` and into an MCP **prompt** or a `firestarter://guide/buying` resource, leaving descriptions at the ~2-sentence selection-relevant core.

---

## 7. `shipping_estimate` is read-only but not annotated so — Medium

**Where:** [tools.ts:1816](src/mcp/tools.ts#L1816)

The description opens: *"Estimate shipping for a listing BEFORE starting a purchase — **read-only**: no execution is created, no approval, nothing is bought."*

The annotation says `{ title: "Estimate Shipping", readOnlyHint: false, destructiveHint: false }`.

It POSTs (`POST /v1/shipping/estimate`), which is presumably why it was marked as a write — but the rule that matters to a host is *does this change state*, and it does not. The cost is a confirmation prompt in the middle of browsing, on precisely the tool built so a buyer could ask "how much is shipping?" without committing. Agents in auto-approve-read-only hosts will avoid it.

**Fix:** `readOnlyHint: true`. Same reasoning applies to `firestarter_market_preview`, which is already correctly `readOnlyHint: true` despite a GET — the precedent exists.

---

## 8. `execute` has no `quantity`, but `preview` does — Medium

`firestarter_preview` accepts `quantity: z.number().int().min(1).max(100)` ([tools.ts:1363](src/mcp/tools.ts#L1363)). `firestarter_execute` accepts no such parameter ([tools.ts:1206-1234](src/mcp/tools.ts#L1206-L1234)) — quantity can only reach the server inside the free-text `request` string.

Yet quantity is plainly a first-class server concept: option rendering reads `opt.quantity` and prints `"$X items x3"` ([tools.ts:1002](src/mcp/tools.ts#L1002)).

**Consequence:** the agent previews 5 units, shows a 5-unit total, then buys — and must hope the NL extractor re-derives "5" from the request string. A silent fallback to quantity 1 is a wrong-amount charge; there is no echo the agent can check against beyond reading the rendered total back.

**Fix:** add `quantity: z.number().int().min(1).max(100).optional()` to `execute` and forward it on the body.

---

## 9. HTTP transport: session id is not bound to the API key — Medium

> **Update 2026-08-31:** the key-hash binding that closed this finding broke OAuth clients — an `fs_oauth_` access token is replaced on every refresh, so claude.ai's first call after a refresh got 404 on its live session ("Unable to reach Firestarter", hourly). The property is now held the way the MCP spec intends: every upstream call carries the Bearer of the request that triggered it (`src/mcp/request-context.ts`), so a session id confers no authority on its own. Pinned in `tests/integration/mcp-session-binding.test.ts`.

**Where:** [route.ts](src/mcp/route.ts) `app.all("/")`, and the mount at [`apps/api/src/index.ts:266`](../firestarter-commerce/apps/api/src/index.ts#L266)

```ts
const apiKey = extractApiKey(c);
if (!apiKey) return c.json({ error: "..." }, 401);

const sessionId = c.req.header("mcp-session-id");
if (sessionId && transports.has(sessionId)) {
  const transport = transports.get(sessionId)!;
  return transport.handleRequest(c.req.raw);   // <-- apiKey never used again
}
```

Three things follow:

1. **The presented Bearer token is discarded for any existing session.** The transport was built with the *original* caller's key, so whoever presents a valid `mcp-session-id` operates as the session's owner — buying, changing payout destinations, withdrawing wallet balances. `extractApiKey` only checks the header is well-formed; the key is never validated here (validation happens upstream on the first tool call), so *any* string works as the Bearer for a hijacked session.
2. **`transports` never expires.** Entries are removed on `transport.onclose`; a client that disconnects without a DELETE leaves the session resident indefinitely. Unbounded growth, and a growing pool of live credentials to hijack.
3. `/mcp` is mounted with no auth middleware in front of it — the global `app.use("/*", ...)` chain is `secureHeaders`, CORS, logger, body limit, metrics only.

Session ids are `crypto.randomUUID()` over TLS, so hijack needs a leak (a proxy log, an error report, a shared-host header dump) rather than a guess. That half is defence-in-depth, not an open door.

**The unauthenticated-growth half is directly reachable, and was confirmed against production.** The `initialize` probe in finding #0 used `Authorization: Bearer fs_test_probe` — a string that is not a real key — and got:

```
HTTP/2 200
mcp-session-id: 1a525150-27f6-4fa2-a062-3d1eb88d9745
```

A session object was created and pinned in the `transports` map by a caller with no valid credential. Because `extractApiKey` only checks the header is well-formed and validation happens upstream at first *tool call*, anyone can mint resident sessions in a loop: no auth, no TTL, no cap. Each carries a full `McpServer` with 83 registered tools, 7 resources, and 10 prompts. That is an unauthenticated memory-growth vector against the production API, not merely an untidy map.

**Fix, in priority order:**
1. Validate the API key before `createTransport` (a cheap upstream `GET /v1/me`, cached) so unauthenticated callers cannot allocate sessions at all.
2. Store a hash of the key alongside each transport and compare on reuse; 404 on mismatch.
3. TTL sweep — evict after ~30 min idle — plus a ceiling on concurrent sessions per key.

The **WebSocket transport does this correctly** — `handleMcpWebSocketUpgrade` builds a fresh server per socket, bound to that socket's key ([ws-transport.ts:105-130](src/mcp/ws-transport.ts#L105-L130)).

---

## 10-13. Smaller items

**10 — Dead `wise` / `payoneer` surface (Seller, Low).** [tools.ts:3076-3080](src/mcp/tools.ts#L3076-L3080) narrows `provider` to `["stripe", "paypal"]` — correctly, since neither other rail yields a spendable destination. But the schema still advertises `wise_recipient_id` (*"Required when provider='wise'"*) and `payoneer_email`, and the handler still carries both branches ([tools.ts:3142-3156](src/mcp/tools.ts#L3142-L3156)) which are now unreachable. An agent reading the schema sees two providers it can never select, and may attempt `provider: "wise"` → raw Zod validation error rather than a helpful message. Delete the params and the dead branches.

**11 — Execution id used as an order id (Buyer, Low).** `firestarter_confirm_delivery` ([tools.ts:2162-2164](src/mcp/tools.ts#L2162-L2164)) and `firestarter_review` ([tools.ts:2189-2191](src/mcp/tools.ts#L2189-L2191)) both do `orderData.order_id || orderData.id`. `order_id` is only populated once an order row exists ([`execution-response.ts:119`](../firestarter-commerce/apps/api/src/lib/execution-response.ts#L119)); before that the fallback POSTs `exec_…` to `/buyer/orders/:id/confirm`, producing a confusing 404 instead of *"this order hasn't been placed yet."* Guard on `order_id` being present and return the actionable message.

**12 — `approve` has no idempotency key (Buyer, Low).** `firestarter_withdraw_wallet` correctly mints one per logical withdrawal ([tools.ts:5384-5396](src/mcp/tools.ts#L5384-L5396)) with an excellent explanatory description. `firestarter_approve` — the other tool that moves money — sends none, and after POSTing it polls for up to 30 s ([tools.ts:1612](src/mcp/tools.ts#L1612)). A client timing out mid-poll and retrying is a realistic double-submit. The server presumably rejects a second approve on a non-`awaiting_approval` execution, but that's an untested assumption on the charge path. Worth either an `Idempotency-Key` for symmetry, or an explicit test pinning the server's second-approve behaviour.
**Resolved 2026-08-20.** The assumption is verified, not presumed: the approve route claims the execution with an atomic `UPDATE … WHERE status = 'awaiting_approval' RETURNING id` and answers a repeat/concurrent approve with `409 ALREADY_APPROVED` — pinned by nine assertions across commerce's approve-route/approve-flow/full-lifecycle-approval suites. No client key can add anything there. The half that WAS open sat one step earlier: a timed-out `POST /v1/executions` whose error text says "retry" created a duplicate execution (the double-buy vector commerce migration 0018 names — the server dedupes on `Idempotency-Key`, but the MCP client never sent one). `firestarter_execute` now sends a content-hashed, 10-minute-bucketed key, so an agent's retry of the same intent replays the original execution; `tests/unit/execute-idempotency.test.ts` pins the header, its stability across a retry, and that distinct intents mint distinct keys.

**14 — Three-way version drift (Release, Low).** `package.json`, `server.ts`, and `route.ts` all say **2.1.2**; production `/.well-known/mcp.json` reports **2.1.3**; [`DIRECTORY-SUBMISSION.md`](src/mcp/DIRECTORY-SUBMISSION.md) — the document that carries the version into the Anthropic listing — says **2.1.1** and names release artifacts `firestarter-mcp-server-2.1.1.tgz`. `scripts/sync-version.mjs` keeps the three *source* files in lockstep but does not touch the submission guide, so the guide silently rots one release at a time. Either add it to the sync script's file list or have it read the version from `package.json` at build time. (The `Surface: 83 tools, 7 resources, 10 prompts` line in that guide *is* accurate — verified.)

**13 — Unguarded `crypto.randomUUID()` (Market owner, Low).** [tools.ts:5388](src/mcp/tools.ts#L5388) sits *outside* the `try`, and `crypto` is a global rather than an import. `package.json` declares `engines.node: ">=18"`, where `globalThis.crypto` is not unflagged (it became default in Node 19). On a Node 18 host this throws a `ReferenceError` out of the handler entirely — an MCP protocol error rather than the friendly message every other failure path produces. Either `import { randomUUID } from "node:crypto"` or move the line inside the `try` and raise the engines floor.
**Resolved 2026-08-20.** `tools.ts` now imports `randomUUID`/`createHash` from `node:crypto`; the test suite pins that `withdraw_wallet` works with the `crypto` global absent (Node 18).

---

## Suggested order of work

**Ship today — the guide is turning away every developer who follows it:**
0. `sse` → `http` in all three config snippets on `apps/web/src/pages/MCP.tsx` (#0). One-word fix, largest impact in this document. Add a test that asserts the page's transport string matches `/.well-known/mcp.json`'s.

**Ship first — three ~1-line changes that fix the two worst buyer failures:**
1. Render `opt.id` in `formatExecution` and `o.id` in the preview text (#1, #3)
2. Add the `STILL_WORKING` status branch in `execute` (#2)
3. Narrow `pollExecution`'s `catch` to 404-only (#2)

**Then — safety annotations, ~30 minutes:**
4. Flip `destructiveHint` on the 8 money tools; flip `readOnlyHint` on `shipping_estimate` (#4, #7)
5. Rewrite the annotation test against real `listTools()` output with an inverted rule (#5)

**Then — the structural one:**
6. Role-scoped toolsets (#6). This is the change that most improves day-to-day agent behaviour, and it is also the largest.

**Also soon:** #9 step 1 (validate the key before allocating a session) — it is a small change closing an unauthenticated growth vector on production.

**Backlog:** #8 quantity, #10-15.

---

## Appendix — how the measurements were taken

- **Tool surface** (`83`, `125.1 KB`, `~35.6k tokens`): built the server in-process against `dist/`, connected an `InMemoryTransport` client pair, called `listTools()`, and serialized the result. Per-tool byte counts are `JSON.stringify(tool).length`.
- **Annotation table:** read from the same `listTools()` response — i.e. exactly what a host receives, not a source grep.
- **Transport behaviour (#0, #9):** `curl` against `https://api.firestarter.network/mcp` on 2026-08-12. Both probes are read-only — an SSE-style `GET` and an `initialize` handshake. No tool was invoked and no money path was touched.
- **Baseline:** `npx vitest run` → 58 files / 483 tests passing, at `2e0f30f`.
