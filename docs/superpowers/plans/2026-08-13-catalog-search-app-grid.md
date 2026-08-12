# Catalog Search MCP App Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `firestarter_catalog_search` render as the inline product-photo grid in Claude instead of plain text, make the grid's cards navigable on every host, and release the result so installed and deployed builds actually receive it.

**Architecture:** `firestarter_catalog_search` moves from the positional `server.tool(...)` registration to `registerToolCompat(...)` with an `outputSchema` and `_meta.ui.resourceUri` — the exact config `firestarter_preview` already uses, which routes through `registerAppTool` so a supporting host renders the existing `shopping-results` App. A new versioned Zod shape plus mapper in `schemas.ts` produces the `structuredContent` that App consumes; its field names match what the widget client already reads, so the widget needs no change to light up. Two smaller fixes ride along: one missing origin in the App's CSP allowlist, and replacing the widget's sandbox-blocked anchor cards with host-mediated `app.openLink()` navigation.

**Tech Stack:** TypeScript 6.0.3 (ESM, `.js` import specifiers), Zod 4, `@modelcontextprotocol/sdk` 1.29, `@modelcontextprotocol/ext-apps` 1.7.5, Vitest 4, esbuild (widget bundle).

## Global Constraints

- **Branch:** `feat/catalog-search-app-grid`, already created off `origin/main` @ `0e2c8e1`. Upstream tracking is deliberately unset — never `git push -u`; push with an explicit refspec (`git push origin feat/catalog-search-app-grid`).
- **Base for the PR:** `main`. Not `staging` — `origin/staging` in this repo is 10+ commits behind and receives nothing.
- **Never push to `main` or `staging` directly.** Integration is by PR only.
- **Version:** bump to `2.2.0` in this PR (Task 5). `release.yml` is a no-op without it, which would leave the stale-deployed-build problem unfixed.
- **Import specifiers:** this package is `"type": "module"` — intra-repo imports must carry the `.js` extension (`./schemas.js`), even from `.ts` sources.
- **`src/mcp/ui/*.client.ts` is excluded from `tsc`.** It uses DOM globals the Node build does not type. Its gate is `npm run build:ui` (esbuild) succeeding, not `npm run typecheck`.
- **`src/mcp/ui/shopping-results.generated.ts` is generated and committed.** Never hand-edit it; regenerate with `npm run build:ui` and commit the result.
- **Any tool carrying an `outputSchema` must return `structuredContent` on every non-error path.** Verified in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:185-207`: `validateToolOutput` returns early when `result.isError` is set, and otherwise throws `McpError` if `structuredContent` is absent, then validates it against the schema.

---

### Task 1: Catalog structured schema and mapper

Pure data mapping, testable without a server. Produces the typed payload Task 2 attaches to tool results.

**Files:**
- Modify: `src/mcp/schemas.ts` (append after line 154, the end of `toPreviewStructured`)
- Test: `tests/integration/mcp-catalog-structured.test.ts` (create)

**Interfaces:**
- Consumes: `MCP_OUTPUT_SCHEMA_VERSION` and `toMinorUnits` — both already imported/defined in `schemas.ts`. `toMinorUnits(major: number | null | undefined, currency: string | null | undefined): number | null`.
- Produces:
  - `catalogOutputShape` — a raw Zod shape object (not a `z.object`), so it can be passed straight to `registerTool`'s `outputSchema`.
  - `catalogOutputSchema: z.ZodObject` — `z.object(catalogOutputShape)`, for tests.
  - `type CatalogStructured = z.infer<typeof catalogOutputSchema>`.
  - `toCatalogStructured(data: any, listings: any[], broadenedTo: string | null): CatalogStructured`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/mcp-catalog-structured.test.ts`:

```ts
/**
 * firestarter_catalog_search — structured output contract.
 *
 * The catalog tool advertises an `outputSchema`, which makes `structuredContent`
 * mandatory on every non-error return (the SDK throws otherwise) and is what the
 * shopping-results MCP App renders as a product grid. These tests pin both
 * halves: that the mapper produces a schema-valid payload from whatever the API
 * returns — including degraded rows — and that the tool attaches it on every
 * path a host can reach without an error.
 */
import { describe, it, expect } from "vitest";
import {
  catalogOutputSchema,
  toCatalogStructured,
  MCP_OUTPUT_SCHEMA_VERSION,
} from "../../src/mcp/schemas.js";

const API_DATA = { query: { environment: "test" }, has_more: false };

const ROW = {
  id: "lst_w1",
  product_name: "Leather Wallet",
  category: "Accessories",
  current_price: 20,
  currency: "USD",
  buyable: true,
  share_url: "https://firestarter.network/l/lst_w1",
  images: ["https://cdn.shopify.com/a.jpg"],
};

describe("toCatalogStructured", () => {
  it("maps a listing row into a schema-valid payload", () => {
    const out = toCatalogStructured(API_DATA, [ROW], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.schema_version).toBe(MCP_OUTPUT_SCHEMA_VERSION);
    expect(out.environment).toBe("test");
    expect(out.count).toBe(1);
    expect(out.buyable_count).toBe(1);
    expect(out.listings[0]).toMatchObject({
      id: "lst_w1",
      product_name: "Leather Wallet",
      current_price: 20,
      currency: "USD",
      buyable: true,
      share_url: "https://firestarter.network/l/lst_w1",
      images: ["https://cdn.shopify.com/a.jpg"],
    });
    // Machine-precise money alongside the float, honoring the ISO-4217 exponent.
    expect(out.listings[0].price).toEqual({ currency: "USD", amount_minor: 2000 });
  });

  it("counts only buyable rows in buyable_count", () => {
    const out = toCatalogStructured(API_DATA, [ROW, { ...ROW, id: "lst_w2", buyable: false }], null);
    expect(out.count).toBe(2);
    expect(out.buyable_count).toBe(1);
  });

  it("drops non-http image entries so the widget never renders a broken src", () => {
    const out = toCatalogStructured(
      API_DATA,
      [{ ...ROW, images: ["javascript:alert(1)", "/relative.jpg", null, "https://ok.test/b.jpg"] }],
      null,
    );
    expect(out.listings[0].images).toEqual(["https://ok.test/b.jpg"]);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
  });

  it("maps a missing or non-numeric price to null rather than NaN", () => {
    const out = toCatalogStructured(API_DATA, [{ ...ROW, current_price: undefined }], null);
    expect(out.listings[0].current_price).toBeNull();
    expect(out.listings[0].price.amount_minor).toBeNull();
    // NaN would pass `typeof === "number"` but fail the schema; this is the guard.
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
  });

  it("stays schema-valid for an empty result set", () => {
    const out = toCatalogStructured(API_DATA, [], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.count).toBe(0);
    expect(out.buyable_count).toBe(0);
    expect(out.listings).toEqual([]);
  });

  it("defaults every field when the API response is empty or malformed", () => {
    const out = toCatalogStructured({}, [{}], null);
    expect(() => catalogOutputSchema.parse(out)).not.toThrow();
    expect(out.environment).toBe("live");
    expect(out.community).toBeNull();
    expect(out.listings[0]).toMatchObject({ id: "", product_name: "", category: null, buyable: false });
  });

  it("records the broadened head noun and the buyer's community", () => {
    const data = { query: { environment: "live", community: { name: "Analog" } }, has_more: true };
    const out = toCatalogStructured(data, [{ ...ROW, picked_by_community: true, pick_note: "  great leather  " }], "wallet");
    expect(out.broadened_to).toBe("wallet");
    expect(out.community).toBe("Analog");
    expect(out.has_more).toBe(true);
    expect(out.listings[0].picked_by_community).toBe(true);
    expect(out.listings[0].pick_note).toBe("great leather");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/mcp-catalog-structured.test.ts`
Expected: FAIL — the import cannot resolve `catalogOutputSchema` / `toCatalogStructured` from `schemas.ts`.

- [ ] **Step 3: Write the implementation**

Append to the end of `src/mcp/schemas.ts` (after the closing brace of `toPreviewStructured` on line 154):

```ts

const catalogListing = z.object({
  /** Listing id (lst_...) — chain to firestarter_execute's listing_id to buy. */
  id: z.string(),
  product_name: z.string(),
  category: z.string().nullable(),
  current_price: z.number().nullable(),
  currency: z.string(),
  /** Integer minor units (e.g. cents) in the listing's native currency. */
  price: z.object({ currency: z.string(), amount_minor: z.number().int().nullable() }),
  buyable: z.boolean(),
  share_url: z.string().nullable(),
  /** http(s) product photo URLs; the shopping-results app renders images[0]. */
  images: z.array(z.string()),
  picked_by_community: z.boolean(),
  pick_note: z.string().nullable(),
});

/** Raw shape advertised as `firestarter_catalog_search`'s `outputSchema`. */
export const catalogOutputShape = {
  schema_version: z.literal(MCP_OUTPUT_SCHEMA_VERSION),
  environment: z.string(),
  count: z.number().int(),
  buyable_count: z.number().int(),
  has_more: z.boolean(),
  /** Set when a zero-result query was broadened to its head noun. */
  broadened_to: z.string().nullable(),
  /** The buyer's community, when they're in one (attributes ★ picks). */
  community: z.string().nullable(),
  listings: z.array(catalogListing),
};

export const catalogOutputSchema = z.object(catalogOutputShape);
export type CatalogStructured = z.infer<typeof catalogOutputSchema>;

/**
 * Map a `/v1/listings/catalog` response into the typed structured payload the
 * shopping-results MCP App renders (its client reads `structuredContent.listings`
 * — same key handling as preview's `options`). Field names deliberately match
 * what the widget already understands: product_name, images, current_price,
 * currency, buyable, share_url.
 *
 * Every field is defaulted. The SDK validates `structuredContent` against the
 * advertised `outputSchema` on every call, so a blocked, empty, or partial API
 * response must still map to a schema-valid object rather than a tool error.
 */
export function toCatalogStructured(
  data: any,
  listings: any[],
  broadenedTo: string | null,
): CatalogStructured {
  const rows = listings.map((l: any) => {
    const priceNum = Number(l?.current_price);
    const current_price = Number.isFinite(priceNum) ? priceNum : null;
    const currency = typeof l?.currency === "string" ? l.currency : "USD";
    return {
      id: typeof l?.id === "string" ? l.id : "",
      product_name: typeof l?.product_name === "string" ? l.product_name : "",
      category: typeof l?.category === "string" ? l.category : null,
      current_price,
      currency,
      price: { currency, amount_minor: toMinorUnits(current_price, currency) },
      buyable: !!l?.buyable,
      share_url: typeof l?.share_url === "string" ? l.share_url : null,
      images: Array.isArray(l?.images)
        ? l.images.filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
        : [],
      picked_by_community: l?.picked_by_community === true,
      pick_note: typeof l?.pick_note === "string" && l.pick_note.trim() ? l.pick_note.trim() : null,
    };
  });
  return {
    schema_version: MCP_OUTPUT_SCHEMA_VERSION,
    environment: typeof data?.query?.environment === "string" ? data.query.environment : "live",
    count: rows.length,
    buyable_count: rows.filter((r) => r.buyable).length,
    has_more: !!data?.has_more,
    broadened_to: broadenedTo,
    community: typeof data?.query?.community?.name === "string" ? data.query.community.name : null,
    listings: rows,
  };
}
```

Note on `current_price: undefined` → `Number(undefined)` is `NaN`, `Number.isFinite(NaN)` is `false`, so it maps to `null`. That is the guard the fourth test pins.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/mcp-catalog-structured.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/schemas.ts tests/integration/mcp-catalog-structured.test.ts
git commit -m "feat(mcp): versioned structured-output schema for catalog search

Adds catalogOutputShape + toCatalogStructured following the module's
schema-plus-mapper pattern, so a drift between the advertised outputSchema
and the mapped object fails a typecheck rather than a live call.

Field names match what ui/shopping-results.client.ts already reads
(product_name, images, current_price, currency, buyable, share_url), so
wiring the tool up needs no widget change.

Every field defaults: the SDK validates structuredContent against the
schema on every call, so a partial or blocked API response has to stay
schema-valid instead of becoming a tool error.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `firestarter_catalog_search` joins the MCP App path

**Files:**
- Modify: `src/mcp/tools.ts` — import line 9; registration block lines 3652-3781; return statements at 3720-3728 (zero-result) and 3776 (success)
- Test: `tests/integration/mcp-catalog-structured.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: `catalogOutputShape`, `toCatalogStructured` from Task 1. `SHOPPING_RESULTS_URI` and `registerToolCompat`, both already in `tools.ts` (imported at line 11, defined at line 1156).
- Produces: `firestarter_catalog_search` results carrying `structuredContent: CatalogStructured` on both non-error paths.

Reference implementation to mirror: `firestarter_preview` at `src/mcp/tools.ts:1350-1384`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/mcp-catalog-structured.test.ts`. This reuses the fake-server plus mocked-`fetch` harness from `tests/unit/mcp-catalog-search-query-hygiene.test.ts` — the fake implements only `.tool`, which also exercises the `registerToolCompat` fallback path.

First widen the existing vitest import at the top of the file. Change:

```ts
import { describe, it, expect } from "vitest";
```

to:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";
```

One import statement per module — do not add a second `from "vitest"` line.

Then append:

```ts
type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

/** Per-URL responder: return listings for a given q, [] otherwise. */
let respond: (q: string | null) => any[];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = new URL(String(url));
      const listings = respond(u.searchParams.get("q"));
      return new Response(
        JSON.stringify({ query: { environment: "test" }, count: listings.length, listings, has_more: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

describe("firestarter_catalog_search — structured content on every non-error path", () => {
  beforeEach(() => {
    respond = () => [ROW];
    installFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("attaches schema-valid structuredContent to a normal hit", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(res.structuredContent).toBeDefined();
    expect(() => catalogOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toHaveLength(1);
    expect(res.structuredContent.listings[0].id).toBe("lst_w1");
    // The text result is unchanged — this addition is additive for hosts
    // without MCP Apps support.
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Leather Wallet");
  });

  it("attaches schema-valid structuredContent to a zero-result search", async () => {
    respond = () => [];
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(res.content[0].text).toContain("No catalog listings matched");
    // Without this the SDK throws: an outputSchema makes structuredContent
    // mandatory on any result that is not isError.
    expect(res.structuredContent).toBeDefined();
    expect(() => catalogOutputSchema.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.listings).toEqual([]);
  });

  it("records the head noun in broadened_to when a query is broadened", async () => {
    respond = (q) => (q === "wallet" ? [ROW] : []);
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "red leather wallet" });
    expect(res.structuredContent.broadened_to).toBe("wallet");
    expect(res.structuredContent.listings).toHaveLength(1);
  });

  it("leaves broadened_to null when the first query hits", async () => {
    const tools = captureTools();
    const res = await tools.firestarter_catalog_search({ query: "wallet" });
    expect(res.structuredContent.broadened_to).toBeNull();
  });
});
```

A note so a surprise does not read as a bug: the stubbed `fetch` answers *every*
URL with the listings JSON, including `https://cdn.shopify.com/a.jpg` when the
handler calls `inlineImageBlocks`. That is intentional — `inlineImageBlocks`
magic-byte-validates the bytes it gets, rejects the JSON, and returns no image
blocks. Nothing throws, and these tests assert on `structuredContent`, not on
image blocks.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/mcp-catalog-structured.test.ts`
Expected: the four new tests FAIL with `expected undefined to be defined` — the tool returns no `structuredContent` yet. The seven Task 1 tests still pass.

- [ ] **Step 3: Convert the registration to `registerToolCompat`**

In `src/mcp/tools.ts`, change the import on line 9 from:

```ts
import { previewOutputShape, toPreviewStructured, PREVIEW_REASON_LABELS } from "./schemas.js";
```

to:

```ts
import { previewOutputShape, toPreviewStructured, PREVIEW_REASON_LABELS, catalogOutputShape, toCatalogStructured } from "./schemas.js";
```

Then replace lines 3653-3675 — from `server.tool(` through the `async ({ query, ... }) => {` handler opening — with the config-object form.

**This is a mechanical restructure, not a rewrite.** Every string literal already
in the file — the tool description and all seven `.describe()` strings — moves
across **byte-for-byte**. Do not retype them from this plan; cut and paste them
from `tools.ts`, which is why they appear here as elisions rather than as text
you could accidentally transcribe wrong. The old shape is:

```ts
  server.tool(
    "firestarter_catalog_search",
    "Search the Firestarter NETWORK catalog — …(long description, leave the string exactly as it is)…",
    {
      query: z.string().optional().describe("…"),
      …the other six input fields, unchanged…
    },
    { title: "Search Catalog", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ query, category, country, min_price, max_price, buyable_only, limit }) => {
```

The new text keeps every string byte-identical and only restructures:

```ts
  registerToolCompat(
    server,
    "firestarter_catalog_search",
    {
      description: "…the same long description string, copied verbatim…",
      inputSchema: {
        …the same seven z.* input fields, copied verbatim…
      },
      outputSchema: catalogOutputShape,
      annotations: { title: "Search Catalog", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      // MCP Apps: render catalog hits as the same inline product grid
      // firestarter_preview uses (photos, price, buyability). Additive — hosts
      // without app support fall back to the text + image-block result below.
      _meta: { ui: { resourceUri: SHOPPING_RESULTS_URI } },
    },
    async ({ query, category, country, min_price, max_price, buyable_only, limit }: {
      query?: string; category?: string; country?: string; min_price?: number; max_price?: number; buyable_only?: boolean; limit?: number;
    }) => {
```

Three things that are easy to get wrong here:

1. **The handler parameter needs an explicit type annotation.** `registerToolCompat` declares `handler: any`, so the inference the positional `server.tool` overload provided is gone. Without the annotation, `tsc` reports an implicit-`any` error on the destructured parameter.
2. **`server,` is the first argument** to `registerToolCompat`, before the name.
3. **Do not reword the description or any `.describe()` string.** `scripts/sync-manifest-descriptions.ts` keeps `mcp.json` and `src/mcp/mcp.json` in sync with these; changing copy here without re-running the sync puts the manifests out of date.

Verify the strings survived the move intact before going on:

Run: `git diff -U0 src/mcp/tools.ts | grep -c '^[-+].*Search the Firestarter NETWORK catalog'`
Expected: `2` — one removed line, one added. Then confirm they are the same string:

Run: `git diff -U0 src/mcp/tools.ts | grep '^[-+].*Search the Firestarter NETWORK catalog' | sed 's/^[-+]//;s/^ *description: //;s/^ *//' | sort -u | wc -l`
Expected: `1`. A `2` means the description text changed — restore it from `git show HEAD:src/mcp/tools.ts`.

- [ ] **Step 4: Attach `structuredContent` to the zero-result path**

At what is currently line 3720, the zero-result early return. Change:

```ts
        if (listings.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No catalog listings matched${q && q !== query ? ` for "${q}"` : ""}. Try a broader search term (a single product noun), remove price/category filters, or drop \`buyable_only\`.`,
            }],
          };
        }
```

to:

```ts
        if (listings.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No catalog listings matched${q && q !== query ? ` for "${q}"` : ""}. Try a broader search term (a single product noun), remove price/category filters, or drop \`buyable_only\`.`,
            }],
            // An outputSchema makes structuredContent mandatory on every result
            // that is not isError — an empty grid, not a validation failure.
            structuredContent: toCatalogStructured(data, [], null),
          };
        }
```

- [ ] **Step 5: Attach `structuredContent` to the success path**

At what is currently line 3776. Change:

```ts
        return { content: [{ type: "text" as const, text: lines.join("\n") }, ...catalogImages] };
```

to:

```ts
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }, ...catalogImages],
          // Drives the shopping-results MCP App grid (its client reads
          // structuredContent.listings); also a typed contract for agents.
          structuredContent: toCatalogStructured(data, listings, broadenedTo),
        };
```

Leave the `catch` block's `isError: true` return exactly as it is — `validateToolOutput` skips validation on error results, so it needs no structured payload.

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `npx vitest run tests/integration/mcp-catalog-structured.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Run the suites this change could disturb**

Run: `npx vitest run tests/unit/mcp-catalog-search-query-hygiene.test.ts tests/unit/mcp-tool-annotations.test.ts`
Expected: PASS.

Two things to watch, neither expected to fail:
- The query-hygiene fake server implements only `.tool`, so `registerToolCompat` takes the fallback branch `s.tool(name, config.description, config.inputSchema, handler)`. The handler is still the last argument, which is what the fake captures.
- `mcp-tool-annotations.test.ts` reads annotations off a live `McpServer` via `tools/list` and its `toolSourceBlocks()` regex matches `registerToolCompat(` as well as `server.tool(`, so moving the tool between forms is already accounted for. `catalog_search`'s hint values do not change, so `tests/unit/tool-annotations.snapshot.json` should need no update. If the snapshot test does fail, read the diff before touching it — every entry there is a decision about what a host may run unattended. Do not blindly re-run with `UPDATE_ANNOTATION_SNAPSHOT=1`.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0. An implicit-`any` error on the handler parameter means Step 3's type annotation was dropped.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools.ts tests/integration/mcp-catalog-structured.test.ts
git commit -m "feat(mcp): render catalog search as the inline product grid

firestarter_catalog_search is the buyer-facing browse tool, but it was the
only shopping tool that never joined the MCP App path — firestarter_preview
alone declared _meta.ui.resourceUri, so browsing the catalog in Claude
returned text while its photos sat in the collapsed tool-result accordion.

Moves the tool to registerToolCompat with the same config preview uses:
outputSchema, annotations, and the shopping-results resourceUri, which
registerToolCompat routes through registerAppTool so both the modern and
legacy UI metadata keys are set for whichever host connects.

structuredContent attaches on both non-error paths. The SDK skips output
validation for isError results but throws when a schema-bearing tool
returns none otherwise, so the zero-result path needs it too — it renders
an empty grid rather than failing the call.

Text and image blocks are untouched; hosts without MCP Apps support see
exactly what they saw before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Widget CSP allowlist and host-mediated card navigation

**Files:**
- Modify: `src/mcp/shopping-app.ts:26-29` (`IMAGE_DOMAINS`)
- Modify: `src/mcp/ui/shopping-results.client.ts:101-103` (card markup) and after line 117 (delegated handler)
- Regenerate: `src/mcp/ui/shopping-results.generated.ts` via `npm run build:ui`

**Interfaces:**
- Consumes: `app.openLink(params, options?): Promise<{ isError?: boolean }>` from `@modelcontextprotocol/ext-apps` (`dist/src/app.d.ts:1222`). Note it **resolves** with `isError: true` when the host denies the request; it does not reject. A rejection only happens on transport failure.
- Produces: nothing other tasks consume.

No unit test here: the widget runs inside a sandboxed iframe, is excluded from `tsc`, and has no DOM test harness in this repo. Its gate is that `npm run build:ui` bundles cleanly and the generated asset changes — plus the manual check in Task 5.

- [ ] **Step 1: Add the missing origin to the CSP allowlist**

In `src/mcp/shopping-app.ts`, change:

```ts
const IMAGE_DOMAINS = [
  "https://cdn.shopify.com",
  "https://api.firestarter.network",
];
```

to:

```ts
const IMAGE_DOMAINS = [
  "https://cdn.shopify.com",
  "https://api.firestarter.network",
  // Pocodot-pipeline listings (e.g. lst_etSM0EwR) carry photos on this origin
  // today — without it the grid shows "No photo" for every such product. The
  // durable fix is rehost-on-write to /v1/img/<id> (see cli/rehost-listing-images
  // in firestarter-commerce, which already reads a REHOST_HOST_ALLOWLIST env var)
  // so ONE first-party origin covers the whole catalog; keep this list as the
  // stopgap for origins already in the wild.
  "https://cole.pocodot.ai",
];
```

Exact origin rather than a wildcard: whether `csp.resourceDomains` accepts wildcard subdomains was never confirmed.

- [ ] **Step 2: Replace the anchor cards with `data-url` cards**

In `src/mcp/ui/shopping-results.client.ts`, change lines 101-103:

```ts
      return link
        ? `<a class="card" href="${esc(link)}" target="_blank" rel="noreferrer noopener">${card}</a>`
        : `<div class="card">${card}</div>`;
```

to:

```ts
      // Navigation must go through app.openLink (host-mediated): a bare
      // <a target="_blank"> inside the sandboxed iframe is blocked on hosts
      // that omit allow-popups, which turns every card into a dead link. The
      // data-url attribute feeds the delegated click/keydown handler below.
      return link
        ? `<div class="card link" data-url="${esc(link)}" role="link" tabindex="0" style="cursor:pointer">${card}</div>`
        : `<div class="card">${card}</div>`;
```

- [ ] **Step 3: Add the delegated listener**

In the same file, insert after the `const app = new App(...)` block (currently ending line 117) and before `app.ontoolresult`:

```ts

// One delegated listener (render() rewrites innerHTML, dropping per-node
// listeners): a click or Enter on a data-url card asks the HOST to open the
// share link — the sanctioned way out of the sandbox. A host that declines
// resolves with isError rather than rejecting; either way the fallback is to
// do nothing and leave the grid usable.
function openCard(target: EventTarget | null): void {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-url]") : null;
  const url = el?.dataset.url;
  if (url) void app.openLink({ url }).catch(() => { /* transport failure — grid stays usable */ });
}
root.addEventListener("click", (ev) => openCard(ev.target));
root.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") openCard(ev.target);
});
```

The listener must go **after** `const app = ...` — `openCard` closes over `app`, and `const` is not hoisted for use before initialization at module-evaluation time. It must go **before or after** `app.ontoolresult`; either works, but keep it adjacent to the `App` construction for readability.

- [ ] **Step 4: Regenerate the widget bundle**

Run: `npm run build:ui`
Expected: exit 0. Then confirm the generated asset actually changed:

Run: `git diff --stat src/mcp/ui/shopping-results.generated.ts`
Expected: a non-empty diffstat. An empty one means the build did not pick up the edits — do not proceed.

- [ ] **Step 5: Confirm the new behavior is in the bundle**

Run: `grep -c "openLink" src/mcp/ui/shopping-results.generated.ts`
Expected: at least 1.

Run: `grep -c 'target="_blank"' src/mcp/ui/shopping-results.generated.ts`
Expected: 0 — the old anchor path is gone.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS. Nothing tests the widget directly; this is a regression check that the `shopping-app.ts` change did not disturb resource registration.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/shopping-app.ts src/mcp/ui/shopping-results.client.ts src/mcp/ui/shopping-results.generated.ts
git commit -m "fix(mcp-app): allowlist the pocodot image origin, open cards via the host

Two ways the product grid failed even where it rendered.

Photos: an MCP App iframe has no network access beyond
csp.resourceDomains, and pocodot-pipeline listings host their images on
cole.pocodot.ai, which was not in the list — every such product degraded
to the 'No photo' placeholder. Adds the exact origin as a stopgap; the
durable fix is rehosting those photos onto a first-party origin.

Links: the cards were <a target=\"_blank\"> inside a sandboxed iframe,
which hosts that omit allow-popups block outright, making every card a
dead click. Routes navigation through app.openLink instead, via one
delegated listener because render() rewrites innerHTML and would drop
per-node handlers. Keyboard users get Enter, and the cards carry
role=link and tabindex.

The cole.pocodot.ai origin comes from an earlier session's observation of
listing lst_etSM0EwR and could not be re-verified here; it is inert if
that was wrong.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `firestarter_listings` list-view thumbnails

The #611 work embedded photos in the listing **detail** path only. A bare "show my products" still returns text alone.

**Files:**
- Modify: `src/mcp/tools.ts:3887` (the list-view return)
- Test: `tests/integration/mcp-listings-list-thumbnails.test.ts` (create)

**Interfaces:**
- Consumes: `inlineImageBlocks(urls: Array<string | null | undefined>): Promise<Array<{ type: "image"; data: string; mimeType: string; annotations: { audience: ("user" | "assistant")[]; priority: number } }>>` — defined at `src/mcp/tools.ts:553`. It dedups, filters to `http(s)`, caps at `MAX_EMBED_IMAGES` (3, line 412), and enforces the response image budget.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/mcp-listings-list-thumbnails.test.ts`:

```ts
/**
 * firestarter_listings (list view) — inline thumbnails.
 *
 * #611 embedded photos in the DETAIL path only, so a seller asking "show my
 * products" got text and no pictures. This pins that the list view embeds them
 * too, and that the cap holds: inlineImageBlocks tops out at MAX_EMBED_IMAGES,
 * which is what keeps a long catalog from blowing the 1MB tool-result cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = {
    tool: (name: string, ...rest: any[]) => {
      tools[name] = rest[rest.length - 1] as ToolHandler;
    },
  };
  registerTools(fakeServer as any, "fsk_test_key", "http://api.test");
  return tools;
}

// Smallest bytes that pass the server-side magic-byte check for a JPEG.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function listingsPayload(count: number) {
  return {
    listings: Array.from({ length: count }, (_, i) => ({
      id: `lst_${i}`,
      product_name: `Product ${i}`,
      status: "active",
      current_price: 10 + i,
      images: [`https://img.test/${i}.jpg`],
    })),
  };
}

function installFetch(count: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      if (/^https:\/\/img\.test\//.test(u)) {
        return new Response(JPEG, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(JPEG.length) },
        });
      }
      return new Response(JSON.stringify(listingsPayload(count)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_listings — list view thumbnails", () => {
  it("embeds the first photo of each listing as an image block", async () => {
    installFetch(2);
    const tools = captureTools();
    const res = await tools.firestarter_listings({});
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Your listings (2)");
    const images = res.content.filter((c: any) => c.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0].mimeType).toBe("image/jpeg");
  });

  it("caps the embedded images so a long catalog can't blow the result size cap", async () => {
    installFetch(12);
    const tools = captureTools();
    const res = await tools.firestarter_listings({});
    const images = res.content.filter((c: any) => c.type === "image");
    expect(images.length).toBeLessThanOrEqual(3); // MAX_EMBED_IMAGES
    // The text still lists every product; only the pictures are capped.
    expect(res.content[0].text).toContain("Your listings (12)");
  });

  it("returns text alone when no listing has a photo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ listings: [{ id: "lst_0", product_name: "P", status: "active", current_price: 5, images: [] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const tools = captureTools();
    const res = await tools.firestarter_listings({});
    expect(res.content.filter((c: any) => c.type === "image")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/mcp-listings-list-thumbnails.test.ts`
Expected: the first two tests FAIL (`expected [] to have length 2`) — the list view returns text only. The third passes vacuously.

- [ ] **Step 3: Write the implementation**

In `src/mcp/tools.ts`, change what is currently line 3887:

```ts
        return { content: [{ type: "text" as const, text }] };
```

to:

```ts
        // #611 follow-up: thumbnail the first photos so "show my products" has
        // visuals in the list view too (the detail path already embeds them).
        // inlineImageBlocks caps at MAX_EMBED_IMAGES and enforces the response
        // image budget, so a long list can never blow the 1MB tool-result cap.
        const listImages = await inlineImageBlocks(listings.map((l: any) => (Array.isArray(l.images) ? l.images[0] : null)));
        return { content: [{ type: "text" as const, text }, ...listImages] };
```

Take care to edit the **list-view** return, not the detail-view one. The list view is the return immediately after the line reading `text += `\nPass a listing ID for full detail. …``. The detail view already embeds images and must not be touched.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/mcp-listings-list-thumbnails.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Confirm the detail path still behaves**

Run: `npx vitest run tests/integration/mcp-listing-images.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools.ts tests/integration/mcp-listings-list-thumbnails.test.ts
git commit -m "feat(mcp): thumbnail listing photos in the seller list view

#611 embedded product photos in the firestarter_listings DETAIL path but
left the list view text-only, so a seller asking to see their products got
names and prices and no pictures.

Costs up to three base64 images on a call that previously carried none.
inlineImageBlocks dedups, caps at MAX_EMBED_IMAGES, and enforces the
response image budget, so the ceiling is bounded no matter how long the
catalog is.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Version bump, full gate, and pull request

Without the version bump this merge produces no release, no npm publish, and no new `.mcpb` asset — leaving the stale-build problem that motivated the whole change.

**Files:**
- Modify: `package.json`, `package-lock.json`, `mcpb/manifest.json`, `mcp.json`, `src/mcp/mcp.json`, `src/mcp/server.ts` — all via `npm version`, none by hand

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a PR into `main`.

- [ ] **Step 1: Bump the version**

Run: `npm version 2.2.0 --no-git-tag-version`

This fires the `version` lifecycle script (`scripts/sync-version.mjs`), which syncs every file that states the version and stages `mcpb/manifest.json mcp.json src/mcp/mcp.json src/mcp/server.ts`.

- [ ] **Step 2: Confirm the version is consistent everywhere**

Run: `grep -rn '2\.2\.0' package.json mcpb/manifest.json src/mcp/server.ts | head`
Expected: a match in each of the three files. A file still reading `2.1.3` means the sync script did not cover it — fix before continuing.

- [ ] **Step 3: Run the complete CI gate locally**

Run these in order, exactly as `.github/workflows/ci.yml` does:

```bash
npm run typecheck
npm test
npm run build
npm run build:mcpb
npx mcpb validate mcpb/manifest.json
node scripts/smoke-bundle.mjs
```

Expected: every command exits 0. `smoke-bundle.mjs` proves the packed bundle completes an MCP handshake — a bundle that builds but cannot speak MCP is the failure that matters.

If `npm run build` reports a diff in `src/mcp/ui/shopping-results.generated.ts`, commit the regenerated file: `build` re-runs `build:ui`, and the committed asset must match what the build produces.

- [ ] **Step 4: Commit the bump**

```bash
git add package.json package-lock.json mcpb/manifest.json mcp.json src/mcp/mcp.json src/mcp/server.ts
git commit -m "chore: release 2.2.0 — ship the catalog product grid

The image work is worthless while the installed .mcpb and the deployed
remote both predate it. release.yml is a no-op on a merge that does not
change the version, so the bump ships in the same PR as the code.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push with an explicit refspec**

Run: `git push origin feat/catalog-search-app-grid`

Never `git push -u`, and never a bare `git push` — the branch deliberately has no upstream so neither can reach `main`.

- [ ] **Step 6: Open the pull request**

```bash
gh pr create --base main --head feat/catalog-search-app-grid \
  --title "feat(mcp): render catalog search as an inline product grid" \
  --body "$(cat <<'BODY'
Product photos do not appear when a buyer browses the catalog through Claude.
The display architecture already existed; what was missing was one operational
gap and three code gaps.

## What changed

- **`firestarter_catalog_search` joins the MCP App path.** It was the only
  buyer-facing shopping tool without `_meta.ui.resourceUri`, so the browse tool
  rendered as text while its photos sat in the collapsed tool-result accordion.
  It now carries the same config `firestarter_preview` uses, backed by a new
  versioned `outputSchema` and mapper in `schemas.ts`.
- **CSP allowlist.** Pocodot-pipeline listings host photos on
  `cole.pocodot.ai`, which the App iframe could not load, so those products
  showed "No photo".
- **Card navigation.** The grid used `<a target="_blank">` inside a sandboxed
  iframe, which hosts that omit `allow-popups` block. Cards now go through
  `app.openLink()`.
- **Seller list view** gets the thumbnails the detail view got in #611.
- **Version bump to 2.2.0**, so the merge actually cuts a release — the
  installed `.mcpb` and the deployed remote both predate the image work, which
  is the real reason images are missing today.

## Verification

`typecheck`, `test`, `build`, `build:mcpb`, `mcpb validate`, and
`smoke-bundle` all pass locally. New tests pin the structured-output contract
on the hit, zero-result, and broadened-retry paths, plus degraded-row mapping
and the list-view thumbnail cap.

Two limits worth stating rather than glossing:

- **The `cole.pocodot.ai` origin is unverified in this pass.** It comes from an
  earlier session's observation of listing `lst_etSM0EwR`; there was no live
  MCP connection available to re-check it. The entry is inert if that was wrong.
- **No terminal session can render an MCP App**, so the grid has not been seen.
  The visual check is manual: reinstall `mcpb/dist/firestarter.mcpb`, restart
  Claude Desktop, search the catalog, click a card.

## Follow-ups, deliberately not in this PR

- **Rehost-on-write** to `/v1/img/<id>` so one first-party origin covers the
  catalog and `IMAGE_DOMAINS` stops needing maintenance.
  `apps/api/src/cli/rehost-listing-images.ts` already reads a
  `REHOST_HOST_ALLOWLIST` env var, so this needs no code change — only a run
  against the production database.
- **The `firestarter_execute` options grid** — the moment of purchase, and the
  most valuable next step. Needs its own mapper first.
- **A seller-side card variant**: today's card would mislabel drafts as
  "Browse-only".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 7: Confirm CI is green**

Run: `gh pr checks --watch`
Expected: the `Typecheck, test, bundle` job passes. Do not report the work as shipped until it does.

---

## Manual verification (requires Claude Desktop — cannot be done from a terminal session)

After the PR merges and `release.yml` publishes 2.2.0:

1. Reinstall `mcpb/dist/firestarter.mcpb` in Claude Desktop (Settings → Extensions) and restart. Claude prompts "Always allow" the first time the App renders.
2. Ask: "preview wall clocks" → grid via `firestarter_preview` (the pre-existing path, as a control).
3. Ask: "search the Firestarter catalog for coffee" → grid via `firestarter_catalog_search` (new).
4. Click a card → the share link opens.
5. Deploy the released build to `api.firestarter.network/mcp` so claude.ai web, mobile, and Cowork connectors get it.

Caveat for step 1: connecting Desktop through the `mcp-remote` proxy can strip the `ui` capability entirely (modelcontextprotocol/ext-apps#671). Prefer the mcpb/stdio install or a native remote connector when checking whether the grid works — a missing grid there may be the proxy, not this change.
