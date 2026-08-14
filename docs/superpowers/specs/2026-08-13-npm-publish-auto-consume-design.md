# Publish `@analog-labs/mcp-server` to npm; auto-consume in commerce

**Date:** 2026-08-13
**Status:** Approved design (adversarially verified), pending implementation plan
**Repos:** `Analog-Labs/firestarter-mcp` (producer), `Analog-Labs/firestarter-commerce` (consumer)

## Goal

Every release of the MCP server lands on the public npm registry under the
`analog-labs` npm organisation with provenance, and firestarter-commerce picks
up each new version automatically — a bot-opened, human-merged PR — instead of
today's hand-written URL-bump PRs.

## Current state (evidenced 2026-08-13)

- `release.yml` in firestarter-mcp fires on push to `main`; a `decide` job
  releases only when `package.json`'s version has no `v<version>` tag yet
  (release.yml:35-59). It re-runs all CI gates, `npm pack`s a prebuilt tarball
  (`prepare` runs the full build), and `gh release create` attaches the
  tarball + the `.mcpb` bundle. **No npm publish exists anywhere** — a comment
  at release.yml:99-105 documents this as a deliberate decision this design
  reverses.
- Commerce pins the tarball by URL: `apps/api/package.json:26` →
  `releases/download/v2.2.0/firestarter-mcp-server-2.2.0.tgz`, sha512-locked.
  Currently two releases behind (latest: v2.2.2).
- Every bump is a manual PR (#640 → #662 → … → #723). Two of the last three
  bump PRs broke CI with `npm ci` EUSAGE because the URL was edited without
  regenerating the lockfile.
- Dependabot has `open-pull-requests-limit: 0` on all ecosystems and cannot
  bump URL deps anyway. No Renovate. No cross-repo automation.
- `@analog-labs/mcp-server` is unpublished (404). `origin/main` ==
  `origin/staging` at 2.2.2; grid PR #23 (base `staging`) carries 2.3.0; no
  `v2.3.0` tag exists. Commerce's default branch is `main`.
- Both repos' workflows use `actions/setup-node@v4` with Node 22, which
  bundles npm 10.9.x.

## Decisions (made by Ali, 2026-08-13)

| Decision | Choice |
|---|---|
| npm organisation | `analog-labs` (package renamed `@analog-labs/mcp-server`) |
| Update mechanism | Release-triggered `repository_dispatch` → bot PR in commerce |
| Publish auth | npm OIDC trusted publishing (no long-lived npm write token) |
| Merge gating | PR-gated — a human merges every bump PR; no auto-merge |
| GitHub release assets | Kept unchanged (`.mcpb` + tarball; Claude Desktop path) |

## Part 1 — Package rename

`@firestarter/mcp-server` → `@analog-labs/mcp-server`.

- **firestarter-mcp:** the npm name appears in `package.json` (name field)
  **and** `package-lock.json` (root name) — the rename PR must regenerate the
  lockfile or `npm ci` fails on the name mismatch, in the release job itself.
  The `firestarter-mcp` bin name, the `firestarter.mcpb` bundle, product
  naming, and the mcpb manifest are all unchanged.
- **commerce:** 42 references across 21 git-tracked files under `apps/api`
  (package.json ×1, vitest.config.ts ×1, Dockerfile comments ×2, src ×8
  across `index.ts`/`lib/margin.ts`/`routes/ucp.ts`/`routes/discovery.ts`,
  tests ×30 across 15 files). Mechanical find-and-replace in the cutover PR;
  the lockfile is regenerated, never hand-edited; typecheck + tests catch
  stragglers.
- The `npm pack` tarball filename becomes `analog-labs-mcp-server-<ver>.tgz`;
  `release.yml` derives the name dynamically — no workflow change for this.
- `package.json`'s `repository.url` must exactly match
  `Analog-Labs/firestarter-mcp` (case-sensitive) — npm rejects the provenance
  bundle with a 422 on mismatch (npm/cli#8036). Verify during the rename.

## Part 2 — Producer: `release.yml` publishes to npm

`package.json` gains `"publishConfig": { "access": "public" }`. Not strictly
required (the CLI flag suffices), but provenance publishes of new packages
hard-fail unless access is explicit (npm/cli#7706), so pin it in the package
**and** pass the flag.

The release job gains, in order, between `npm pack` and `gh release create`:

1. **npm CLI upgrade** — trusted publishing requires **npm ≥ 11.5.1 and
   Node ≥ 22.14.0** (docs.npmjs.com/trusted-publishers). Node 22 bundles npm
   10.9.x, so add `npm install -g npm@latest` before publishing (alternative:
   move the job to Node 24, whose bundled npm qualifies — rejected for now to
   keep the build environment unchanged). The job also gains
   `permissions: id-token: write` (required for the OIDC exchange; must be
   set at job level since the workflow default is `contents: write` only) and
   the publish must run on a GitHub-hosted runner (it does).
2. **Guarded publish** — derive the name from `package.json`; skip when
   `npm view "<name>@$VERSION" version` returns **non-empty output** (some npm
   versions exit 0 with empty output for a missing version — test output, not
   exit code). Otherwise
   `npm publish "$TARBALL" --provenance --access public`. Trusted publishing
   auto-enables provenance, but the explicit flag is harmless insurance and
   documents intent. Publishing the already-packed tarball keeps the registry
   bits byte-identical to the GitHub release asset.

After `gh release create`, a new final step:

3. **Dispatch to commerce** — with `VERSION="${TAG#v}"` (bare semver — the
   payload contract is **no `v` prefix**):
   `gh api repos/Analog-Labs/firestarter-commerce/dispatches -f event_type=mcp-release -f 'client_payload[version]='"$VERSION"`
   authenticated with a new `COMMERCE_DISPATCH_TOKEN` secret (fine-grained
   PAT; see Security). `continue-on-error: true` plus a `::warning::`
   annotation on failure — a dead dispatch must not fail the release, and the
   consumer has a scheduled catch-up path, but the failure must be visible.

Ordering is load-bearing: **publish → release → dispatch** means commerce is
never told about a version the registry can't serve yet (the 2026-08-10
404-on-asset failure class disappears structurally).

## Part 3 — Consumer: `bump-mcp.yml` in commerce

New workflow, one job, three triggers:

- `repository_dispatch: types: [mcp-release]` — fast path, minutes after
  release.
- `schedule` (daily) — compares the registry's latest against the current
  pin. Catch-up for any lost dispatch, and the fallback that lets the
  dispatch PAT be dropped entirely later if desired.
- `workflow_dispatch` with optional `version` input — manual.

Guards, in order, before any work:

1. **Dependency guard:** if `@analog-labs/mcp-server` is not yet a dependency
   of `apps/api`, no-op with a visible notice (protects the window before the
   cutover PR, and makes pre-bootstrap schedule runs clean no-ops).
2. **Version validation:** normalize the target (strip a leading `v`, from
   either `client_payload.version` or the human-typed input) and require
   `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` before it is ever
   interpolated into a shell command — dispatch payloads and manual inputs
   are untrusted.
3. **Semver-greater only:** proceed only when the target is strictly greater
   than the current pin. Equal → no-op. **Lower → no-op with a warning**, so
   a registry mishap (dist-tag accident, unpublish window) can never open a
   downgrade PR into a payment-adjacent API. A failed registry query fails
   the run visibly and retries next schedule.

Job: checkout `staging` → `cd apps/api && npm install
@analog-labs/mcp-server@<version> --save-exact` (regenerates the lockfile —
this kills the EUSAGE failure class) → push branch `chore/bump-mcp-<version>`
→ open a PR into `staging` titled
`chore(api): bump @analog-labs/mcp-server to v<version>` → close any still-open
bump PR for a lower version (superseded). Idempotent: skip when a PR for the
target version is already open.

**Credential (verified constraint):** PRs created with the built-in
`github.token` do **not** trigger `pull_request` workflows — the bump PR would
show zero CI checks. The push and PR creation therefore use `MCP_BUMP_TOKEN`,
a second fine-grained PAT (commerce only, Contents + Pull requests r/w),
stored in commerce's Actions secrets. PAT-created PRs trigger CI normally and
don't need the org's "Actions may create PRs" setting.

**No auto-merge.** CI Gate runs on the PR; a human merges.

Default-branch constraint (verified): `repository_dispatch` and `schedule`
only trigger workflow files on the **default branch** — `bump-mcp.yml` must be
promoted to commerce's `main` before the automation is live.

## Part 4 — Consumer cutover PR

One atomic PR in commerce (imports must match the installed package):

1. Rename all 42 `@firestarter/mcp-server` references to
   `@analog-labs/mcp-server`.
2. `apps/api/package.json`: URL dependency → exact registry pin of the first
   workflow-published version (2.3.0 — see Sequencing; the pin target must
   exist on the registry before this PR can pass `npm ci`).
3. Regenerate `package-lock.json` via `npm install`.
4. Delete stale `apps/api/mcp.json` (v2.0.0 vendored-era leftover; verified
   imported/read by nothing — `discovery.ts:3` imports the package's copy).

## Part 5 — Bootstrap (Ali, manual, ~15 min)

Trusted publishing **cannot** mint the first publish of a not-yet-existing
package (docs.npmjs.com/cli/v11/commands/npm-trust: the package must already
exist; open feature request npm/cli#8544). So:

1. **Create or confirm the `analog-labs` org on npmjs.com** (fresh
   `npm login` — the token on this machine is dead, E401). A 404 on the scope
   proves only that no packages are published, **not** that the org name is
   free — if `analog-labs` turns out to be held by a third party, **stop**:
   the scope decision reopens and cascades into every rename.
2. **Stub publish** — from a scratch directory (never the real repo), publish
   a minimal placeholder: `{ "name": "@analog-labs/mcp-server", "version":
   "0.0.0-bootstrap.0" }` + README pointing at the repo, via
   `npm publish --access public --tag bootstrap`. The `bootstrap` dist-tag
   means `latest` never exists until the first real release, so nothing can
   install the stub by accident. Publishing a stub (not real code) means no
   untested build ever reaches the registry, and no real version number is
   burned — npm forbids republishing a version, so the real 2.3.0 must come
   from the workflow, once, with provenance.
3. **Configure the trusted publisher** on the package (npmjs.com settings or
   `npm trust`): repo `Analog-Labs/firestarter-mcp`, workflow `release.yml`.
4. **Mint two fine-grained PATs** (as org owner — owner-created tokens skip
   the org approval queue), both 90-day expiry with a renewal reminder:
   - `COMMERCE_DISPATCH_TOKEN`: repo `firestarter-commerce` only, Contents
     r/w (the verified minimum for `repository_dispatch`). → Actions secret
     in **firestarter-mcp**.
   - `MCP_BUMP_TOKEN`: repo `firestarter-commerce` only, Contents r/w +
     Pull requests r/w. → Actions secret in **commerce**.

## Sequencing

Hard ordering constraints — each step assumes all prior ones:

1. **Grid PR #23 merges into `staging`** (brings 2.3.0). No staging→main
   promotion happens until step 5.
2. **firestarter-mcp rename PR** into `staging`, based on the post-#23 tip:
   rename + lockfile regen + `publishConfig` + `repository.url` check +
   `release.yml` changes (Part 2). Version stays 2.3.0 — same unreleased
   version, one eventual release carries everything.
3. **Bootstrap (Part 5) completes** — org, stub, trusted publisher, both
   PATs — before any promotion.
4. **Commerce PR: `bump-mcp.yml`** merges and is promoted to `main`
   (default-branch requirement). Safe to go live early: the dependency guard
   no-ops until the cutover lands.
5. **firestarter-mcp staging→main promotion.** `decide` sees no `v2.3.0` tag
   → gates → publish guard finds 2.3.0 absent → **workflow publishes 2.3.0
   with OIDC + provenance** (the trusted-publishing path is exercised on the
   very first real release) → GitHub release → dispatch fires → bump
   workflow runs and no-ops on the dependency guard, proving the
   dispatch→workflow wiring live.
6. **Commerce cutover PR** (Part 4) pins 2.3.0, which now exists with
   provenance. Merges through staging → main as usual.
7. **Steady state** from 2.3.1 on: merge a version bump in firestarter-mcp →
   auto-publish → dispatch → bot PR with full CI → human merges. Done.

## Failure modes

| Failure | Behaviour |
|---|---|
| npm publish fails (registry outage, OIDC misconfig) | Release job fails loudly before the GitHub release exists; re-run is idempotent (`decide` + output-tested publish guard). |
| Dispatch fails / PAT expired | Release completes (`continue-on-error`) with a `::warning::` annotation; daily schedule catches up ≤ 24 h; manual `workflow_dispatch` anytime. |
| Registry query fails in the schedule job | Run fails visibly; next schedule retries. |
| Registry "latest" is somehow lower than the pin | No-op with warning — never a downgrade PR. |
| Bump PR breaks commerce CI | PR-gated; nothing merges. Lockfile desync cannot recur (`npm install --save-exact` regenerates it). PAT-created PR guarantees CI actually runs. |
| Bad MCP release reaches npm | Human gate on the bump PR is the backstop; `npm deprecate` on the producer side. |
| Rapid successive releases | Per-version idempotency; the job closes superseded open bump PRs when opening a newer one. |
| Stub version confusion | `0.0.0-bootstrap.0` sits behind the `bootstrap` dist-tag; `latest` first exists when 2.3.0 publishes. |

## Security

- **OIDC trusted publishing:** no npm write credential exists anywhere;
  every workflow publish carries provenance linking package → repo → run.
- **Two fine-grained PATs are the new credentials, and the honest risk:**
  anyone with write access to either repo's workflows can exfiltrate its
  secret; `COMMERCE_DISPATCH_TOKEN` (in firestarter-mcp) and `MCP_BUMP_TOKEN`
  (in commerce) both grant Contents write on commerce — the same
  CI-credential class as the 2026-08 access-review finding. Mitigations:
  single-repo scope, minimum permissions, 90-day expiry with renewal
  reminders, org-owner-created. The schedule path makes the dispatch PAT
  droppable (accept ~24 h latency). A GitHub App with per-run installation
  tokens is the cleaner long-term replacement for both; out of scope today.
- **Abandoned `@firestarter` name — risk accepted:** the old name was only
  ever consumed as a URL-pinned tarball, never resolved through any registry,
  so no lockfile or manifest anywhere resolves `@firestarter/mcp-server`
  against npm — scope-squatting it cannot redirect any existing install path.
  Recorded here rather than defensively claiming a second org.
- **Blast radius of a bad bump:** human merge gate on every bump PR, in a
  payment-adjacent API, on an unprotected `staging` branch — auto-merge stays
  off until branch protection exists.

## Testing & verification

- `bump-mcp.yml`: manual `workflow_dispatch` pre-cutover → dependency-guard
  no-op with notice; post-cutover at the current pin → clean no-op; at a
  malformed version (`; rm -rf /`) → rejected by validation; at a lower
  version → warning no-op.
- Producer: the sequenced go-live (step 5) exercises decide → gates → OIDC
  publish → provenance → release → dispatch on the first real release;
  verify with `npm view @analog-labs/mcp-server@2.3.0` and the provenance
  badge on npmjs.com.
- Success criteria: a version bump merged in firestarter-mcp results — with
  no human action other than merging the bot PR — in commerce running that
  version, registry-published, provenance-attested, lockfile coherent.

## Out of scope

- Enabling Dependabot routine bumps generally (limit stays 0 elsewhere).
- Auto-merge of bump PRs (revisit once commerce branch protection exists).
- Private/paid npm features; the package is public.
- Any change to `.mcpb` Desktop Extension distribution (release asset + copy
  inside the npm package, both unchanged).
- Claiming the old `@firestarter` npm scope (risk accepted; see Security).
- Replacing the two PATs with a GitHub App (noted as the better long-term
  shape; separate follow-up).
