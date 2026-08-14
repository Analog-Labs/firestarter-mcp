# npm Publish + Auto-Consume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@analog-labs/firestarter-mcp` publishes to npm with provenance on every release, and firestarter-commerce automatically opens a PR pinning each new version.

**Architecture:** The existing `release.yml` in firestarter-mcp gains a guarded `npm publish` (OIDC trusted publishing, no npm secret) and a `repository_dispatch` ping to commerce. A new `bump-mcp.yml` in commerce receives the ping (plus a daily schedule and manual trigger), regenerates the lockfile with `npm install --save-exact`, and opens a PR-gated bump. A one-time stub publish bootstraps the package so trusted publishing can be configured.

**Tech Stack:** GitHub Actions, npm ≥ 11.5.1 (trusted publishing), `gh` CLI, bash.

**Spec:** `docs/superpowers/specs/2026-08-13-npm-publish-auto-consume-design.md` (in firestarter-mcp; committed on this branch — read it first, it argues every decision here).

## Global Constraints

- Package name: `@analog-labs/firestarter-mcp` — exactly this string everywhere; the `firestarter-mcp` bin name and `firestarter.mcpb` bundle names do NOT change.
- Trusted publishing needs npm ≥ 11.5.1; both repos' jobs run Node 22 (npm 10.9.x), so the release job must `npm install -g npm@latest` before publishing.
- Dispatch payload contract: bare semver, no `v` prefix (`2.3.1`, never `v2.3.1`).
- Version 2.3.0 is already taken by in-flight work (grid PR #23) — this plan's firestarter-mcp changes ride the same 2.3.0 release; do NOT bump the version anywhere in this plan.
- Never push to `staging` or `main` directly — every change lands via PR with base `staging` (both repos), using explicit refspecs (`git push origin HEAD:refs/heads/<branch>`).
- No `NPM_TOKEN` or `NODE_AUTH_TOKEN` may appear anywhere — auth is OIDC-only.
- Two fine-grained PATs exist after Task 5, both scoped to `Analog-Labs/firestarter-commerce` only: `COMMERCE_DISPATCH_TOKEN` (Contents r/w; secret in firestarter-mcp) and `MCP_BUMP_TOKEN` (Contents r/w + Pull requests r/w; secret in commerce).
- Repos on disk: producer `/Users/alitanveer/Documents/Professional/analog/firestarter-mcp`, consumer `/Users/alitanveer/Documents/Professional/analog/firestarter-commerce`. macOS — BSD `sed -i ''`.

---

### Task 1: Pre-flight gate

**Files:** none (verification only)

**Interfaces:**
- Produces: confirmation that grid PR #23 is merged into `staging` and no `v2.3.0` tag exists — every later firestarter-mcp task assumes both.

- [ ] **Step 1: Verify PR #23 is merged**

Run:
```bash
gh pr view 23 --repo Analog-Labs/firestarter-mcp --json state,mergedAt --jq '.state'
```
Expected: `MERGED`. If `OPEN`: **stop** — tell Ali the rename PR must be based on the post-#23 staging tip (spec: Sequencing 1) and wait for the merge. Do not proceed with any firestarter-mcp task.

- [ ] **Step 2: Verify v2.3.0 is untagged and staging carries 2.3.0**

Run:
```bash
cd /Users/alitanveer/Documents/Professional/analog/firestarter-mcp
git fetch origin --tags --quiet
git ls-remote --tags origin | grep -c "refs/tags/v2.3.0" || echo "no v2.3.0 tag (expected)"
git show origin/staging:package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version'
```
Expected: `no v2.3.0 tag (expected)` and version `2.3.0`. If a `v2.3.0` tag already exists, **stop**: 2.3.0 released without the rename; the firestarter-mcp tasks then need a fresh version bump (`npm version patch --no-git-tag-version`, which syncs all five version files) folded into Task 2 — flag to Ali before continuing.

---

### Task 2: firestarter-mcp — rename to `@analog-labs/firestarter-mcp`

**Files:**
- Modify: `package.json:2` (name), plus add `publishConfig`
- Modify: `package-lock.json` (regenerated, lines 2 and 8 carry the name)
- Branch: `feat/npm-publish` created from `docs/npm-publish-spec` (so the committed spec+plan travel with the code PR)

**Interfaces:**
- Produces: package named `@analog-labs/firestarter-mcp` with `publishConfig: {"access":"public"}`; `npm pack` now emits `analog-labs-firestarter-mcp-2.3.0.tgz`. Tasks 3–4 edit the workflow in this same branch; Task 8's cutover consumes the published name.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/alitanveer/Documents/Professional/analog/firestarter-mcp
git fetch origin --quiet
git checkout docs/npm-publish-spec
git rebase origin/staging   # picks up #23; spec commit add541a rides on top
git checkout -b feat/npm-publish
```

- [ ] **Step 2: Write the failing check** — the pack name is the test

Run:
```bash
npm pack --dry-run --silent 2>/dev/null | tail -1; node -p 'require("./package.json").publishConfig ?? "MISSING publishConfig"'
```
Expected (RED): tarball name still `firestarter-mcp-server-2.3.0.tgz`; `MISSING publishConfig`.

- [ ] **Step 3: Rename and add publishConfig**

In `package.json`, change line 2 and add `publishConfig` after `"license"`:

```json
  "name": "@analog-labs/firestarter-mcp",
```
```json
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
```

- [ ] **Step 4: Regenerate the lockfile and verify repository.url**

```bash
npm install
node -p 'require("./package.json").repository.url'
```
Expected: lockfile's two `name` fields now `@analog-labs/firestarter-mcp` (`grep -n '@analog-labs/firestarter-mcp' package-lock.json | head -3`); repository.url prints exactly `git+https://github.com/Analog-Labs/firestarter-mcp.git` — case-sensitive match with the real repo (`Analog-Labs/firestarter-mcp`) is required or npm rejects provenance with a 422 (npm/cli#8036). It already matches; just confirm.

- [ ] **Step 5: Verify GREEN + full gates**

```bash
npm pack --dry-run --silent 2>/dev/null | tail -1
npm ci && npm run typecheck && npm test
```
Expected: `analog-labs-firestarter-mcp-2.3.0.tgz`; `npm ci` succeeds against the regenerated lockfile (the failure mode this prevents is EUSAGE name-mismatch in the release job); typecheck and all tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: rename package to @analog-labs/firestarter-mcp for npm publishing"
```

---

### Task 3: firestarter-mcp — guarded npm publish in `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml` (release job: permissions, setup-node, new steps between `Pack the npm tarball` [lines 114-124] and `Create the tag and publish the release` [lines 128-138])

**Interfaces:**
- Consumes: `steps.pack.outputs.tarball` (existing pack step) and `needs.decide.outputs.tag` (existing decide job).
- Produces: `@analog-labs/firestarter-mcp@<version>` on registry.npmjs.org with provenance, before the GitHub release exists. Task 4 appends the dispatch after the release step.

- [ ] **Step 1: Job-level permissions + registry-url**

In `release.yml`, the `release:` job currently inherits workflow-level `permissions: contents: write` (lines 22-23). Add job-level permissions (job-level REPLACES workflow-level, so contents must be restated) directly under `release:` / `runs-on: ubuntu-latest`:

```yaml
  release:
    name: Build, tag, and attach the extension bundle and npm tarball
    needs: decide
    if: needs.decide.outputs.release == 'true'
    runs-on: ubuntu-latest
    # id-token lets npm's trusted-publishing OIDC exchange run; contents must
    # be restated because job-level permissions replace the workflow default.
    permissions:
      contents: write
      id-token: write
```

And extend the existing setup-node step (lines 69-72) with the registry URL from npm's documented trusted-publishing setup:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          registry-url: "https://registry.npmjs.org"
```

- [ ] **Step 2: Add the publish step after `Pack the npm tarball`**

Insert between the pack step and `Create the tag and publish the release`:

```yaml
      # Publish to npm via OIDC trusted publishing — no token exists anywhere.
      # Requires npm >= 11.5.1 (Node 22 bundles 10.9.x, hence the upgrade) and
      # a GitHub-hosted runner. The guard tests npm view's OUTPUT, not its exit
      # code (some npm versions exit 0 with empty output for a missing
      # version): re-runs and the bootstrapped stub era skip cleanly, because
      # npm forbids republishing a version that exists. Publishing the packed
      # tarball keeps the registry bits byte-identical to the release asset.
      - name: Publish to npm (skipped when the version already exists)
        env:
          TARBALL: ${{ steps.pack.outputs.tarball }}
        run: |
          set -euo pipefail
          npm install -g npm@latest
          npm --version
          name="$(node -p 'require("./package.json").name')"
          version="$(node -p 'require("./package.json").version')"
          existing="$(npm view "${name}@${version}" version 2>/dev/null || true)"
          if [ -n "$existing" ]; then
            echo "${name}@${version} is already on the registry — skipping publish."
          else
            npm publish "$TARBALL" --provenance --access public
            echo "published ${name}@${version} with provenance"
          fi
```

- [ ] **Step 3: Validate the workflow file parses**

```bash
node -e "const y=require('yaml');const fs=require('fs');const d=y.parse(fs.readFileSync('.github/workflows/release.yml','utf8'));console.log('jobs:',Object.keys(d.jobs));console.log('release perms:',JSON.stringify(d.jobs.release.permissions));console.log('steps:',d.jobs.release.steps.map(s=>s.name||s.uses||s.run.slice(0,30)).join(' | '))"
```
(`yaml` is already in node_modules via transitive deps; if not: `npm exec --yes -- yaml --help` is unnecessary — fall back to `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`.)
Expected: parses; `release perms: {"contents":"write","id-token":"write"}`; the publish step sits between the pack and release-create steps.

- [ ] **Step 4: Test the guard logic locally against real registry data**

```bash
name="react"
existing="$(npm view "${name}@18.2.0" version 2>/dev/null || true)"; [ -n "$existing" ] && echo "GUARD: would skip (correct for existing)"
existing="$(npm view "${name}@99.99.99" version 2>/dev/null || true)"; [ -z "$existing" ] && echo "GUARD: would publish (correct for missing)"
existing="$(npm view "@analog-labs/firestarter-mcp@2.3.0" version 2>/dev/null || true)"; [ -z "$existing" ] && echo "GUARD: would publish (correct for unpublished package)"
```
Expected: all three `GUARD:` lines print — the guard skips existing versions, publishes missing ones, and treats a wholly-unpublished package (E404) as publishable.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): publish to npm via OIDC trusted publishing"
```

---

### Task 4: firestarter-mcp — dispatch to commerce after the release

**Files:**
- Modify: `.github/workflows/release.yml` (append one step after `Create the tag and publish the release`)

**Interfaces:**
- Consumes: `needs.decide.outputs.tag` (e.g. `v2.3.0`); secret `COMMERCE_DISPATCH_TOKEN` (created in Task 5 — the step degrades to a warning until it exists).
- Produces: `repository_dispatch` event `mcp-release` with `client_payload.version` = bare semver, which Task 6's `bump-mcp.yml` consumes.

- [ ] **Step 1: Append the dispatch step at the end of the release job**

```yaml
      # Tell firestarter-commerce a new version is on the registry. Best-effort
      # by design: a dead dispatch (expired PAT, missing secret) must not fail
      # a completed release — commerce's daily schedule catches up within 24h —
      # but it must be VISIBLE, hence the warning annotation. Payload contract:
      # bare semver, no v prefix. Ordering matters: this runs after npm publish
      # and gh release create, so commerce is never told about a version the
      # registry cannot serve yet.
      - name: Notify firestarter-commerce (repository_dispatch)
        continue-on-error: true
        env:
          GH_TOKEN: ${{ secrets.COMMERCE_DISPATCH_TOKEN }}
          TAG: ${{ needs.decide.outputs.tag }}
        run: |
          set -euo pipefail
          version="${TAG#v}"
          if [ -z "${GH_TOKEN}" ]; then
            echo "::warning::COMMERCE_DISPATCH_TOKEN is not set — commerce picks this up via its daily schedule instead."
            exit 1
          fi
          if gh api "repos/Analog-Labs/firestarter-commerce/dispatches" \
              -f event_type=mcp-release \
              -f "client_payload[version]=${version}"; then
            echo "dispatched mcp-release ${version} to firestarter-commerce"
          else
            echo "::warning::repository_dispatch to firestarter-commerce failed — its daily schedule will catch up within 24h."
            exit 1
          fi
```

- [ ] **Step 2: Validate parse + step order**

```bash
python3 -c "
import yaml
d = yaml.safe_load(open('.github/workflows/release.yml'))
steps = [s.get('name', s.get('uses','run')) for s in d['jobs']['release']['steps']]
print('\n'.join(steps))
assert steps[-1] == 'Notify firestarter-commerce (repository_dispatch)'
assert 'Publish to npm (skipped when the version already exists)' in steps
i_pub, i_rel, i_disp = (steps.index(x) for x in ['Publish to npm (skipped when the version already exists)','Create the tag and publish the release','Notify firestarter-commerce (repository_dispatch)'])
assert i_pub < i_rel < i_disp, 'publish -> release -> dispatch ordering violated'
print('ORDERING OK')
"
```
Expected: step list ends with the dispatch step and `ORDERING OK`.

- [ ] **Step 3: Commit and open the producer PR**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): notify firestarter-commerce via repository_dispatch"
git push origin HEAD:refs/heads/feat/npm-publish
gh pr create --repo Analog-Labs/firestarter-mcp --base staging --head feat/npm-publish \
  --title "feat: publish @analog-labs/firestarter-mcp to npm + notify commerce" \
  --body "Implements docs/superpowers/specs/2026-08-13-npm-publish-auto-consume-design.md (spec + plan included on this branch).

- Rename @firestarter/mcp-server -> @analog-labs/firestarter-mcp (lockfile regenerated)
- publishConfig access public; repository.url verified for provenance
- release.yml: OIDC trusted publish (guarded, npm>=11.5.1) between pack and release-create
- repository_dispatch 'mcp-release' to firestarter-commerce, best-effort with visible warning

Merge AFTER the Task 5 bootstrap (npm org + stub + trusted publisher + PATs) is done — see the plan's Task 7 gate.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR URL printed. **Do not merge yet** — Task 7 gates the merge on the bootstrap.

---

### Task 5: Bootstrap — npm org, stub, trusted publisher, PATs (**Ali, interactive**)

**Files:** none in-repo. Scratch dir only.

**Interfaces:**
- Produces: `@analog-labs/firestarter-mcp` exists on the registry (stub `0.0.0-bootstrap.0` behind dist-tag `bootstrap`); trusted publisher configured; secrets `COMMERCE_DISPATCH_TOKEN` (firestarter-mcp) and `MCP_BUMP_TOKEN` (commerce). Tasks 6–8 depend on all of it.

This task cannot be executed by an agent — `npm login` is a browser flow and PAT minting is a GitHub UI flow. Present these commands to Ali verbatim and wait for confirmation.

- [ ] **Step 1 (Ali): Claim/confirm the org and log in**

```bash
npm login   # fresh login — the token in ~/.npmrc is dead (E401)
npm whoami  # expect your username
```
Then on npmjs.com: create org `analog-labs` (or confirm you own it). **If the name is held by a third party, STOP — the scope decision reopens and cascades into every rename (spec, Bootstrap 1).**

- [ ] **Step 2 (Ali): Publish the stub**

```bash
mkdir -p /tmp/mcp-stub && cd /tmp/mcp-stub
cat > package.json <<'EOF'
{
  "name": "@analog-labs/firestarter-mcp",
  "version": "0.0.0-bootstrap.0",
  "description": "Placeholder enabling npm trusted publishing for github.com/Analog-Labs/firestarter-mcp — real releases are >= 2.3.0.",
  "license": "MIT"
}
EOF
printf 'Placeholder — real package: https://github.com/Analog-Labs/firestarter-mcp\n' > README.md
npm publish --access public --tag bootstrap
npm view @analog-labs/firestarter-mcp dist-tags   # expect: { bootstrap: '0.0.0-bootstrap.0' } and NO latest
```
The `bootstrap` dist-tag means `latest` won't exist until the workflow publishes 2.3.0 — nothing can install the stub by accident.

- [ ] **Step 3 (Ali): Configure the trusted publisher**

On npmjs.com → package `@analog-labs/firestarter-mcp` → Settings → Trusted publisher: **GitHub Actions**, organization `Analog-Labs`, repository `firestarter-mcp`, workflow filename `release.yml`, environment: leave blank.

- [ ] **Step 4 (Ali): Mint the two PATs and store them**

github.com → Settings → Developer settings → Fine-grained tokens → New. Resource owner **Analog-Labs** (you're an org owner, so no approval queue), repository access: **only `firestarter-commerce`**, expiry 90 days (set a renewal reminder):

1. `commerce-dispatch` — Repository permissions: **Contents: Read and write** (nothing else).
2. `mcp-bump` — Repository permissions: **Contents: Read and write** + **Pull requests: Read and write**.

```bash
gh secret set COMMERCE_DISPATCH_TOKEN --repo Analog-Labs/firestarter-mcp    # paste token 1
gh secret set MCP_BUMP_TOKEN --repo Analog-Labs/firestarter-commerce        # paste token 2
```

---

### Task 6: commerce — `bump-mcp.yml`

**Files:**
- Create: `.github/workflows/bump-mcp.yml` (in firestarter-commerce)
- Branch: `feat/bump-mcp-workflow` off `origin/staging`

**Interfaces:**
- Consumes: `github.event.client_payload.version` (bare semver, from Task 4); secret `MCP_BUMP_TOKEN` (Task 5); the `@analog-labs/firestarter-mcp` dependency key in `apps/api/package.json` (absent until Task 8 — the dependency guard makes that a clean no-op).
- Produces: PR-gated bump PRs on branch `chore/bump-mcp-<version>`, base `staging`, title `chore(api): bump @analog-labs/firestarter-mcp to v<version>`.

- [ ] **Step 1: Branch**

```bash
cd /Users/alitanveer/Documents/Professional/analog/firestarter-commerce
git fetch origin --quiet
git checkout -b feat/bump-mcp-workflow origin/staging
```

- [ ] **Step 2: Write the guard-logic test harness first (RED)**

The resolve logic is the only real logic in the workflow — test it as plain bash before the workflow exists. Save as `/tmp/bump-guard-test.sh`:

```bash
#!/bin/bash
# Harness for bump-mcp.yml's resolve-target logic. Run against a fixture dir.
set -u
fixture() { # $1=dep-version-or-empty  $2=dispatched  $3=typed
  dir="$(mktemp -d)"; mkdir -p "$dir/apps/api"
  if [ -n "$1" ]; then deps="{\"@analog-labs/firestarter-mcp\": \"$1\"}"; else deps="{}"; fi
  printf '{ "name": "api", "dependencies": %s }' "$deps" > "$dir/apps/api/package.json"
  ( cd "$dir" && DISPATCHED="$2" TYPED="$3" bash /tmp/resolve-target.sh )
}
echo "T1 no-dep guard:";        fixture ""      "2.3.1" ""       # expect proceed=false notice
echo "T2 equal no-op:";        fixture "2.3.0" "2.3.0" ""       # expect proceed=false
echo "T3 downgrade refusal:";  fixture "2.3.0" "2.2.9" ""       # expect proceed=false warning
echo "T4 valid bump:";         fixture "2.3.0" "2.3.1" ""       # expect proceed=true version=2.3.1
echo "T5 v-prefix normalize:"; fixture "2.3.0" "v2.3.1" ""      # expect proceed=true version=2.3.1
echo "T6 injection rejected:"; fixture "2.3.0" '2.3.1; rm -rf /' ""  # expect hard error
```

Run: `bash /tmp/bump-guard-test.sh`
Expected: FAIL — `/tmp/resolve-target.sh: No such file or directory` for every case.

- [ ] **Step 3: Implement the resolve logic (GREEN)**

Save as `/tmp/resolve-target.sh` — this exact body goes into the workflow in Step 5:

```bash
set -euo pipefail
PKG="@analog-labs/firestarter-mcp"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"
dep="$(node -p "require('./apps/api/package.json').dependencies['@analog-labs/firestarter-mcp'] ?? ''")"
if [ -z "$dep" ]; then
  echo "::notice::apps/api does not depend on ${PKG} yet (pre-cutover) — nothing to bump."
  echo "proceed=false" >> "$GITHUB_OUTPUT"; exit 0
fi
raw="${DISPATCHED:-${TYPED:-}}"
if [ -z "$raw" ]; then
  raw="$(npm view "$PKG" version)"  # registry latest; a failed query fails the run visibly
fi
version="${raw#v}"
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "::error::'${raw}' is not a valid semver version"; exit 1
fi
current="$dep"
if [ "$version" = "$current" ]; then
  echo "::notice::already pinned to ${current} — nothing to do."
  echo "proceed=false" >> "$GITHUB_OUTPUT"; exit 0
fi
highest="$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)"
if [ "$highest" != "$version" ]; then
  echo "::warning::target ${version} is lower than the current pin ${current} — refusing to open a downgrade PR."
  echo "proceed=false" >> "$GITHUB_OUTPUT"; exit 0
fi
{ echo "version=$version"; echo "current=$current"; echo "proceed=true"; } >> "$GITHUB_OUTPUT"
```

Run: `bash /tmp/bump-guard-test.sh`
Expected: T1 notice+proceed=false, T2 proceed=false, T3 warning+proceed=false, T4 proceed=true/version=2.3.1, T5 proceed=true/version=2.3.1, T6 `::error::` and nonzero exit. (T4/T5 target 2.3.1 which doesn't exist on the registry — irrelevant here, resolve only validates and compares.)

- [ ] **Step 4: Verify the harness passes all six cases**

Re-run and eyeball every case; any deviation is a logic bug — fix before proceeding.

- [ ] **Step 5: Write the workflow**

Create `.github/workflows/bump-mcp.yml`:

```yaml
name: Bump MCP server

# Opens a PR bumping @analog-labs/firestarter-mcp when firestarter-mcp releases.
#
# Three doors into one job: the release's repository_dispatch (fast path,
# minutes), a daily schedule (catch-up if a dispatch is ever lost — this is
# what makes the dispatch PAT droppable), and workflow_dispatch (manual).
# repository_dispatch and schedule only fire from the DEFAULT branch (main),
# so this file must be promoted to main before the automation is live.
#
# Everything runs on MCP_BUMP_TOKEN, not github.token: PRs created with the
# built-in token do not trigger pull_request workflows, which would produce
# zero-check bump PRs — the opposite of PR-gated. github.token gets no
# permissions at all.
on:
  repository_dispatch:
    types: [mcp-release]
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:
    inputs:
      version:
        description: "Version to bump to (bare semver, e.g. 2.3.1). Empty = registry latest."
        required: false

permissions: {}

concurrency:
  group: bump-mcp
  cancel-in-progress: false

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: staging
          token: ${{ secrets.MCP_BUMP_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Guards, in order: not-yet-a-dependency (pre-cutover window), semver
      # validation of untrusted input (dispatch payload and human-typed input
      # are both interpolated into a shell command below), and
      # strictly-greater-than-the-pin (a registry mishap must never open a
      # downgrade PR into a payment-adjacent API).
      - name: Resolve target version
        id: target
        env:
          DISPATCHED: ${{ github.event.client_payload.version }}
          TYPED: ${{ inputs.version }}
        run: |
          set -euo pipefail
          PKG="@analog-labs/firestarter-mcp"
          dep="$(node -p "require('./apps/api/package.json').dependencies['@analog-labs/firestarter-mcp'] ?? ''")"
          if [ -z "$dep" ]; then
            echo "::notice::apps/api does not depend on ${PKG} yet (pre-cutover) — nothing to bump."
            echo "proceed=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          raw="${DISPATCHED:-${TYPED:-}}"
          if [ -z "$raw" ]; then
            raw="$(npm view "$PKG" version)"
          fi
          version="${raw#v}"
          if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
            echo "::error::'${raw}' is not a valid semver version"; exit 1
          fi
          current="$dep"
          if [ "$version" = "$current" ]; then
            echo "::notice::already pinned to ${current} — nothing to do."
            echo "proceed=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          highest="$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1)"
          if [ "$highest" != "$version" ]; then
            echo "::warning::target ${version} is lower than the current pin ${current} — refusing to open a downgrade PR."
            echo "proceed=false" >> "$GITHUB_OUTPUT"; exit 0
          fi
          { echo "version=$version"; echo "current=$current"; echo "proceed=true"; } >> "$GITHUB_OUTPUT"

      - name: Skip if a PR for this version is already open
        if: steps.target.outputs.proceed == 'true'
        id: existing
        env:
          GH_TOKEN: ${{ secrets.MCP_BUMP_TOKEN }}
          VERSION: ${{ steps.target.outputs.version }}
        run: |
          set -euo pipefail
          n="$(gh pr list --repo "$GITHUB_REPOSITORY" --head "chore/bump-mcp-${VERSION}" --state open --json number --jq length)"
          if [ "$n" -gt 0 ]; then
            echo "::notice::a PR for ${VERSION} is already open — nothing to do."
            echo "proceed=false" >> "$GITHUB_OUTPUT"
          else
            echo "proceed=true" >> "$GITHUB_OUTPUT"
          fi

      # npm install --save-exact regenerates the lockfile — the EUSAGE
      # package.json/package-lock desync that broke the manual v2.1.3 bump
      # PRs structurally cannot recur.
      - name: Bump, push, open the PR
        if: steps.target.outputs.proceed == 'true' && steps.existing.outputs.proceed == 'true'
        env:
          GH_TOKEN: ${{ secrets.MCP_BUMP_TOKEN }}
          VERSION: ${{ steps.target.outputs.version }}
          CURRENT: ${{ steps.target.outputs.current }}
        run: |
          set -euo pipefail
          branch="chore/bump-mcp-${VERSION}"
          git config user.name "mcp-bump-bot"
          git config user.email "noreply@analog.one"
          git checkout -b "$branch"
          ( cd apps/api && npm install "@analog-labs/firestarter-mcp@${VERSION}" --save-exact )
          git add apps/api/package.json apps/api/package-lock.json
          git commit -m "chore(api): bump @analog-labs/firestarter-mcp to v${VERSION}"
          git push origin "HEAD:refs/heads/${branch}"
          gh pr create --repo "$GITHUB_REPOSITORY" --base staging --head "$branch" \
            --title "chore(api): bump @analog-labs/firestarter-mcp to v${VERSION}" \
            --body "Automated bump ${CURRENT} -> ${VERSION} (lockfile regenerated via npm install --save-exact). Merge when CI Gate is green."
          # Close superseded bump PRs — but ONLY strictly-lower versions, so a
          # late-arriving dispatch for an older release can never close a newer PR.
          gh pr list --repo "$GITHUB_REPOSITORY" --state open --json number,headRefName \
            --jq '.[] | select(.headRefName | startswith("chore/bump-mcp-")) | [.number, (.headRefName | ltrimstr("chore/bump-mcp-"))] | @tsv' \
          | while IFS=$'\t' read -r pr ver; do
              [ "$ver" = "$VERSION" ] && continue
              highest="$(printf '%s\n%s\n' "$ver" "$VERSION" | sort -V | tail -1)"
              if [ "$highest" = "$VERSION" ]; then
                gh pr close "$pr" --repo "$GITHUB_REPOSITORY" --comment "Superseded by the v${VERSION} bump." --delete-branch || true
              fi
            done
```

- [ ] **Step 6: Validate parse + trigger shape**

```bash
python3 -c "
import yaml
d = yaml.safe_load(open('.github/workflows/bump-mcp.yml'))
assert d[True]['repository_dispatch']['types'] == ['mcp-release'] if True in d else d['on']['repository_dispatch']['types'] == ['mcp-release']
print('triggers OK')
" 2>/dev/null || python3 -c "
import yaml
d = yaml.safe_load(open('.github/workflows/bump-mcp.yml'))
on = d.get('on', d.get(True))
assert on['repository_dispatch']['types'] == ['mcp-release']
assert 'schedule' in on and 'workflow_dispatch' in on
print('triggers OK')
"
```
(YAML parses bare `on:` as boolean `True` — hence the fallback.) Expected: `triggers OK`.

- [ ] **Step 7: Commit and open the PR**

```bash
git add .github/workflows/bump-mcp.yml
git commit -m "ci: auto-bump @analog-labs/firestarter-mcp on release (PR-gated)"
git push origin HEAD:refs/heads/feat/bump-mcp-workflow
gh pr create --repo Analog-Labs/firestarter-commerce --base staging --head feat/bump-mcp-workflow \
  --title "ci: auto-bump @analog-labs/firestarter-mcp on release (PR-gated)" \
  --body "Receives firestarter-mcp's repository_dispatch (plus daily schedule + manual trigger) and opens a lockfile-coherent bump PR into staging. Guards: not-yet-a-dependency no-op, semver validation of untrusted input, no downgrades, per-version idempotency, supersede-close of lower-version PRs only. Uses MCP_BUMP_TOKEN so bump PRs actually trigger CI (github.token-created PRs do not).

Live only once promoted to main (repository_dispatch/schedule fire from the default branch).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR URL. Ali merges to staging, then this must ride the next staging→main promotion before dispatches land (Task 7 sequencing).

---

### Task 7: Go-live gate — merge, promote, watch the first publish (**Ali merges; agent watches**)

**Files:** none (orchestration)

**Interfaces:**
- Consumes: Task 4's producer PR, Task 5's bootstrap, Task 6's consumer PR.
- Produces: `@analog-labs/firestarter-mcp@2.3.0` on npm with provenance; `latest` dist-tag exists. Task 8 pins it.

- [ ] **Step 1 (Ali): Merge order**

1. Merge the commerce `feat/bump-mcp-workflow` PR into `staging`, and promote commerce `staging` → `main` (normal promotion PR) so `bump-mcp.yml` is on the default branch.
2. Confirm Task 5 bootstrap is fully done (stub visible: `npm view @analog-labs/firestarter-mcp dist-tags` shows `bootstrap`; both secrets set).
3. Merge the firestarter-mcp `feat/npm-publish` PR into `staging`, then open and merge the staging→main promotion PR in firestarter-mcp.

- [ ] **Step 2: Watch the release run**

```bash
gh run list --repo Analog-Labs/firestarter-mcp --workflow Release --limit 1
gh run watch --repo Analog-Labs/firestarter-mcp "$(gh run list --repo Analog-Labs/firestarter-mcp --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: decide=release (no v2.3.0 tag) → gates → publish step runs the real OIDC publish (guard finds 2.3.0 absent) → release created → dispatch step succeeds.

- [ ] **Step 3: Verify the published artifact**

```bash
npm view @analog-labs/firestarter-mcp@2.3.0 version dist.tarball
npm view @analog-labs/firestarter-mcp dist-tags        # latest: 2.3.0, bootstrap: 0.0.0-bootstrap.0
npm view @analog-labs/firestarter-mcp@2.3.0 --json | node -p 'JSON.parse(require("fs").readFileSync(0)).dist.attestations?.url ?? "NO PROVENANCE"'
```
Expected: version resolves; `latest` now points at 2.3.0; an attestations URL prints (provenance). `NO PROVENANCE` = trusted-publisher misconfig — fix on npmjs.com and re-run the release workflow (idempotent: decide still releases? No — the tag now exists, so re-run via `workflow_dispatch` re-enters decide; the guard means only the publish is skipped if it succeeded. If the publish itself failed, the release job failed BEFORE `gh release create`, so no tag exists and a plain re-run repeats cleanly.)

- [ ] **Step 4: Verify the dispatch landed as a clean no-op**

```bash
gh run list --repo Analog-Labs/firestarter-commerce --workflow "Bump MCP server" --limit 1 --json conclusion,event
```
Expected: one run, `event: repository_dispatch`, `conclusion: success` — the dependency guard no-oped with a notice (cutover hasn't happened). This proves the dispatch→workflow wiring live.

---

### Task 8: commerce — cutover PR (rename + registry pin)

**Files:**
- Modify: all 21 tracked files under `apps/api` carrying `@firestarter/mcp-server` (list produced by git grep below; includes `package.json`, `vitest.config.ts`, `Dockerfile`, `src/index.ts`, `src/lib/margin.ts`, `src/routes/ucp.ts`, `src/routes/discovery.ts`, `tests/**` ×14)
- Modify: `apps/api/package-lock.json` (regenerated)
- Delete: `apps/api/mcp.json` (stale vendored-era file, v2.0.0, imported by nothing)
- Branch: `chore/mcp-registry-cutover` off `origin/staging`

**Interfaces:**
- Consumes: `@analog-labs/firestarter-mcp@2.3.0` on the registry (Task 7).
- Produces: commerce consuming the registry pin; from here `bump-mcp.yml`'s dependency guard passes and the steady-state loop is live.

- [ ] **Step 1: Branch + RED check**

```bash
cd /Users/alitanveer/Documents/Professional/analog/firestarter-commerce
git fetch origin --quiet
git checkout -b chore/mcp-registry-cutover origin/staging
git grep -c '@firestarter/mcp-server' -- 'apps/api' ':!apps/api/package-lock.json' | awk -F: '{s+=$2} END {print s" refs (expect 42)"}'
```
Expected: `42 refs (expect 42)` (±small drift if staging moved — any nonzero count is the RED state; record the number).

- [ ] **Step 2: Rename every reference**

```bash
git grep -l '@firestarter/mcp-server' -- 'apps/api' ':!apps/api/package-lock.json' \
  | xargs sed -i '' 's|@firestarter/mcp-server|@analog-labs/firestarter-mcp|g'
git grep -c '@firestarter/mcp-server' -- 'apps/api' ':!apps/api/package-lock.json' || echo "0 refs left (GREEN)"
```
Expected: `0 refs left (GREEN)`.

- [ ] **Step 3: Swap the URL dep for the exact registry pin**

The sed above renamed the KEY in `apps/api/package.json` but its VALUE is still the v2.2.0 tarball URL. Replace value + lockfile in one move:

```bash
cd apps/api
npm install @analog-labs/firestarter-mcp@2.3.0 --save-exact
node -p 'require("./package.json").dependencies["@analog-labs/firestarter-mcp"]'   # expect "2.3.0"
grep -n '"@analog-labs/firestarter-mcp"' package-lock.json | head -3               # resolved to registry.npmjs.org
cd ../..
```
Expected: pin `2.3.0`; lockfile resolves to `https://registry.npmjs.org/@analog-labs/firestarter-mcp/-/mcp-server-2.3.0.tgz` with integrity hash.

- [ ] **Step 4: Delete the stale vendored-era manifest**

```bash
git rm apps/api/mcp.json
```
(Verified imported by nothing: `discovery.ts:3` imports the package's copy via `@analog-labs/firestarter-mcp/mcp.json`.)

- [ ] **Step 5: Verify — install, typecheck, tests**

```bash
cd apps/api
npm ci
npm run typecheck
npm test
cd ../..
```
Expected: `npm ci` clean against the regenerated lockfile; typecheck and the full suite pass (the 14 renamed test files execute against the registry-installed 2.3.0, which contains the same grid feature the tests last ran against as a tarball).

- [ ] **Step 6: Commit and open the cutover PR**

```bash
git add -A
git commit -m "chore(api): consume @analog-labs/firestarter-mcp from npm (v2.3.0)"
git push origin HEAD:refs/heads/chore/mcp-registry-cutover
gh pr create --repo Analog-Labs/firestarter-commerce --base staging --head chore/mcp-registry-cutover \
  --title "chore(api): consume @analog-labs/firestarter-mcp from npm (v2.3.0)" \
  --body "Cutover from the GitHub-release tarball URL to the npm registry pin.

- Rename @firestarter/mcp-server -> @analog-labs/firestarter-mcp (42 refs, 21 files)
- URL dep -> exact pin 2.3.0 (provenance-attested, published by release.yml via OIDC)
- Lockfile regenerated; stale vendored-era apps/api/mcp.json deleted (imported by nothing)

From this merge on, bump-mcp.yml's dependency guard passes and new MCP releases arrive as automated PR-gated bumps.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR URL; CI Gate runs (human-authored PR). Ali merges.

---

### Task 9: Steady-state verification

**Files:** none (verification; documents what to watch on the next release)

**Interfaces:**
- Consumes: everything above, live.

- [ ] **Step 1: Manual no-op probe of the full consumer path**

```bash
gh workflow run "Bump MCP server" --repo Analog-Labs/firestarter-commerce
sleep 30
gh run list --repo Analog-Labs/firestarter-commerce --workflow "Bump MCP server" --limit 1 --json conclusion,event --jq '.[0]'
```
Expected: `conclusion: success`, `event: workflow_dispatch` — resolves registry latest (2.3.0), equal to pin, clean no-op.

- [ ] **Step 2: Document the 2.3.1 expectation**

The first fully-unattended cycle happens at the next real version. When any PR merging to firestarter-mcp `main` carries a version bump: Release publishes with provenance → dispatch fires → `chore/bump-mcp-<ver>` PR appears in commerce within minutes with CI running → human merges → deploy. If the PR doesn't appear within ~10 minutes, check `gh run list --repo Analog-Labs/firestarter-commerce --workflow "Bump MCP server"`; the daily schedule (06:17 UTC) is the backstop. Nothing to commit — confirm to Ali that the pipeline is live and hand over the PAT renewal dates (90 days from Task 5).

---

## Self-Review (completed)

- **Spec coverage:** Part 1 → Task 2; Part 2 → Tasks 3–4; Part 3 → Task 6; Part 4 → Task 8; Part 5 → Task 5; Sequencing 1 → Task 1, 2–4 → Task 5–6 ordering, 5 → Task 7, 6 → Task 8, 7 → Task 9; every failure-mode row is implemented in the step that owns it (guarded publish, continue-on-error dispatch, downgrade refusal, supersede-close of lower versions only).
- **Placeholder scan:** none — every step carries runnable commands or complete file content.
- **Type consistency:** step outputs `proceed`/`version`/`current` used identically across Task 6's steps; secret names `COMMERCE_DISPATCH_TOKEN`/`MCP_BUMP_TOKEN` identical across Tasks 4, 5, 6; branch and PR-title conventions identical across Tasks 6 and 8.
