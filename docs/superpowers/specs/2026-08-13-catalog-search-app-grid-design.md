# Product images in Claude: catalog_search joins the MCP App grid

**Status:** approved 2026-08-13
**Repo:** `Analog-Labs/firestarter-mcp`
**Base:** `origin/main` @ `0e2c8e1` (includes PR #18, `fix/agent-flow-audit`)
**Branch:** `feat/catalog-search-app-grid`

## Problem

Firestarter product photos do not appear when a buyer browses the catalog through
Claude. The architecture for showing them already exists — three display channels
were built months ago — so this is not a redesign. It is one operational failure
plus three code gaps.

1. **The installed and deployed builds predate the image work.** The live MCP
   server observed in the prior session exposed neither the #611 image-URL lines
   in `firestarter_catalog_search` nor its `country` parameter, and
   `firestarter_listings` still carried pre-HEAD description text. The API side is
   fine: `/v1/listings/catalog` already selects `l.images`. This is a stale
   `firestarter.mcpb` and a stale remote deploy, not a data problem.
2. **`firestarter_catalog_search` never joined the MCP App path.** Only
   `firestarter_preview` declares `_meta.ui.resourceUri`, so the buyer-facing
   browse tool renders as plain text even on a current build.
3. **The App's CSP allowlist misses a real catalog origin.** Listing
   `lst_etSM0EwR` hosts its photo on `https://cole.pocodot.ai`, which is absent
   from `IMAGE_DOMAINS`, so the grid degrades to the "No photo" placeholder.
4. **Grid cards are dead links on some hosts.** The widget uses
   `<a target="_blank">` inside the sandboxed iframe; hosts that omit
   `allow-popups` block it. `app.openLink()` is the sanctioned path out.

## Goals

- A buyer asking Claude to search the Firestarter catalog sees an inline product
  grid with photos, prices, and buyability — not a wall of text with images
  buried in the collapsed tool-result accordion.
- Cards in that grid navigate to the listing's share link on every host.
- The change actually reaches users: a released version, not just a merged commit.

## Non-goals

Explicitly out of scope for this spec, each deferred with a reason:

- **Rehost-on-write to a first-party image origin.** The durable fix for gap 3 is
  to migrate external image URLs to `/v1/img/<id>` so one origin covers the whole
  catalog and `IMAGE_DOMAINS` stops needing maintenance. The tooling already
  exists — `apps/api/src/cli/rehost-listing-images.ts` in `firestarter-commerce`
  reads a `REHOST_HOST_ALLOWLIST` env var, so **no code change is required** — but
  running it needs production database access, which this workstream does not
  have. Tracked as a follow-up, not a blocker.
- **The `firestarter_execute` options grid.** The moment of purchase is the most
  valuable place for a product grid, but `firestarter_execute` returns no
  `structuredContent` today, so wiring it means writing a new mapper first. Worth
  doing next; a larger blast radius on the buy flow than this change earns.
- **A seller-side grid variant.** Today's card would mislabel draft listings as
  "Browse-only". Needs a widget change before the tool change.

## Design

### 1. Base branch and release

`origin/staging` in this repo is more than ten commits behind `origin/main` and
receives nothing; `main` is trunk. CI (`.github/workflows/ci.yml`) gates pull
requests into `main`. `release.yml` fires on every push to `main` but is a no-op
unless `package.json`'s version has no matching tag.

Therefore: branch off `origin/main`, PR into `main`, and **bump the version to
2.2.0 in the PR**. Without the bump the merge produces no release, no npm
publish, and no new `.mcpb` asset — leaving problem 1 unfixed regardless of code
quality. The version bump goes through `npm version 2.2.0 --no-git-tag-version`,
which fires the `version` lifecycle script and syncs all five files that state
the version.

This deviates from the standing "always base `staging`" rule, which applies to
`collab-cadence-ai` and `firestarter-commerce`, not here.

### 2. Server: `catalog_search` joins the MCP App path

**`src/mcp/schemas.ts`** gains `catalogOutputShape` and `toCatalogStructured()`,
following the module's established versioned-shape-plus-mapper pattern: the Zod
shape is advertised as the tool's `outputSchema` *and* consumed by the mapper
that builds `structuredContent`, so schema/mapper drift surfaces as a typecheck
or test failure rather than a silent runtime error.

Field names are chosen to match what `ui/shopping-results.client.ts` already
reads — `product_name`, `images`, `current_price`, `currency`, `buyable`,
`share_url` — so **the widget needs no change for the grid to light up**. The
shape carries `schema_version`, `environment`, `count`, `buyable_count`,
`has_more`, `broadened_to`, `community`, and `listings[]`; each listing carries
`id`, `product_name`, `category`, `current_price`, `currency`, a machine-precise
`price: { currency, amount_minor }` via the existing `toMinorUnits`, `buyable`,
`share_url`, `images[]`, `picked_by_community`, and `pick_note`.

`toCatalogStructured` defaults every field, so a blocked, empty, or partial API
response still produces a schema-valid object. This matters because the SDK
validates `structuredContent` against `outputSchema` on every call — an
undefaulted field would turn a degraded upstream response into a hard tool error.

**`src/mcp/tools.ts`** converts `firestarter_catalog_search` from the positional
`server.tool(name, description, inputSchema, annotations, handler)` form to
`registerToolCompat(server, name, config, handler)`, with `description`,
`inputSchema`, `outputSchema: catalogOutputShape`, `annotations` (unchanged
values), and `_meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } }`. This is the
exact config `firestarter_preview` already uses. `registerToolCompat` routes any
config carrying `_meta.ui` through `registerAppTool`, which normalizes the modern
and legacy UI metadata keys for whichever host version connects, and falls back
to the classic `.tool()` signature for the minimal server doubles in the unit
tests.

`structuredContent` attaches on both non-error return paths — the success path
and the zero-result path. The error path keeps `isError: true` and no structured
payload. Text lines and inline image blocks are unchanged; the change is purely
additive, and hosts without MCP Apps support ignore the meta and fall back to the
existing text-plus-image-block result.

The `images` array is filtered to `http(s)` URLs at map time, matching the
widget's own `firstImage()` guard.

### 3. Widget: CSP allowlist and host-mediated navigation

**`src/mcp/shopping-app.ts`** adds `https://cole.pocodot.ai` to `IMAGE_DOMAINS`.

Stated limitation: this session has no live Firestarter MCP connection, so the
origin could not be re-verified here. It rests on the prior session's observation
of listing `lst_etSM0EwR`. The entry is inert if that observation was wrong — an
unused CSP allowlist entry changes nothing — and the PR description will say so
rather than implying verification that did not happen. The patch lists an exact
origin because whether `csp.resourceDomains` accepts wildcard subdomains was
never confirmed.

**`src/mcp/ui/shopping-results.client.ts`** replaces the anchor cards with
`data-url` cards carrying `role="link"` and `tabindex="0"`, plus a single
delegated click/keydown handler on `root` that calls `app.openLink({ url })`. The
listener is delegated rather than per-card because `render()` rewrites
`innerHTML` and would drop per-node listeners. A rejected `openLink` is caught and
ignored so a host declining the request leaves the grid usable.

`npm run build:ui` regenerates `shopping-results.generated.ts`, which is
committed; the widget is not part of the Node `tsc` build.

### 4. `firestarter_listings` list-view thumbnails

The #611 work embedded photos in the listing *detail* path only. The list view —
what a seller gets from a bare "show my products" — still emits text alone. This
adds `inlineImageBlocks` over each listing's first photo to the list path.

Accepted tradeoff, stated rather than buried: this adds up to three base64 images
to every bare `firestarter_listings` call, a real per-call token cost on a seller
tool that previously had none. `MAX_EMBED_IMAGES = 3` and the existing per-
response image budget cap it, so a long list cannot breach the 1MB tool-result
cap.

## Testing

A new test at `tests/integration/mcp-catalog-structured.test.ts` — named after
its `firestarter_preview` counterpart, `mcp-preview-structured-e2e.test.ts` —
pins the structured-output contract for `firestarter_catalog_search`, using the
existing fake-server plus mocked-`fetch` harness from
`tests/unit/mcp-catalog-search-query-hygiene.test.ts`:

- a normal hit returns `structuredContent` that parses against
  `catalogOutputSchema`, with `listings` mapped one-to-one and `buyable_count`
  agreeing with the rows;
- a zero-result search still returns a schema-valid `structuredContent` with an
  empty `listings` array;
- a broadened retry sets `broadened_to` to the head noun;
- non-`http(s)` entries in an upstream `images` array are filtered out;
- a listing with a missing or non-numeric `current_price` maps to `null` rather
  than `NaN`, and still validates.

A second test at `tests/integration/mcp-listings-list-thumbnails.test.ts` covers
§4: that the list view embeds each listing's first photo, that a catalog longer
than `MAX_EMBED_IMAGES` is capped rather than unbounded, and that a photoless
listing still returns text alone.

Existing suites that must keep passing without modification:
`mcp-catalog-search-query-hygiene.test.ts` (its fake server implements only
`.tool`, which exercises the `registerToolCompat` fallback),
`mcp-listing-images.test.ts`, and `mcp-tool-annotations.test.ts` with its
committed snapshot. The annotation snapshot is expected to be unchanged, because
catalog_search's hint values do not move — this will be confirmed by running the
suite, not assumed. Note that PR #18 rewrote that test to read annotations off a
live client and to recognize `registerToolCompat(` in its source scan, so the
registration-form change is already accounted for there.

Full gate before opening the PR:

```bash
npm run build:ui
npm run typecheck
npm test
npm run build
npm run build:mcpb
```

## Verification and handoff

Automated verification stops at the build. Nothing in a terminal session can
render an MCP App, so the visual confirmation is a manual step:

1. Reinstall `mcpb/dist/firestarter.mcpb` in Claude Desktop (Settings →
   Extensions) and restart. Claude prompts "Always allow" the first time the App
   renders.
2. Ask for a catalog search ("search the Firestarter catalog for coffee") and
   confirm a grid appears rather than text.
3. Click a card and confirm it opens the share link.
4. Deploy the released build to `api.firestarter.network/mcp` so claude.ai web,
   mobile, and Cowork connectors get it.

Field caveat worth knowing during step 1: connecting Desktop through the
`mcp-remote` proxy can strip the `ui` capability entirely
(modelcontextprotocol/ext-apps#671). Prefer the mcpb/stdio install or a native
remote connector when checking whether the grid works.

## Risks

| Risk | Mitigation |
|---|---|
| `cole.pocodot.ai` is not actually a live catalog origin | Inert if wrong; flagged as unverified in the PR. Superseded by the rehost follow-up. |
| `outputSchema` validation rejects a degraded API response | `toCatalogStructured` defaults every field; tests cover empty, zero-result, and malformed-price cases. |
| List-view thumbnails inflate seller-tool responses | Capped by `MAX_EMBED_IMAGES` and the response image budget; scope can be dropped independently of the rest. |
| Merge produces no release, leaving deployed build stale | Version bump to 2.2.0 is part of the PR, not a follow-up. |
