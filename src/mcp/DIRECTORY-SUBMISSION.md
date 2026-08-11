# How to submit the Firestarter MCP server to a directory

This guide walks a human through listing the Firestarter MCP server in a public MCP
directory. It does **not** submit anything for you — every step is something you
run or paste yourself.

The server it describes is the stdio MCP server in [`server.ts`](./server.ts),
declared by the manifest in [`mcp.json`](./mcp.json). Server name: `firestarter`.
Version: `1.0.0`. Five tools: `firestarter_execute`, `firestarter_status`,
`firestarter_approve`, `firestarter_cancel`, `firestarter_message`.

Target directories (default at launch):
1. **Claude Code MCP directory** (Anthropic) — the registry Claude Code and
   Claude Desktop pull from.
2. **Cursor MCP directory** — Cursor's "Add to Cursor" / MCP registry.

---

## Prerequisites

Before you submit anywhere, confirm all of these. A directory reviewer will check
the same things, so clearing them first avoids a rejection round-trip.

1. **The package is installable.** The run command is `npx tsx firestarter-mcp`.
   That resolves through the root `package.json` `bin` entry
   `"firestarter-mcp": "./src/mcp/server.ts"`. For `npx` to find it by name, the
   package must be published to npm (as `firestarter-api`, the `name` in
   `package.json`) or installed locally. If it is not yet on npm, publish it first
   or list it with a local/`git+https` install command instead.
   - `tsx` is the runner because the bin target is a TypeScript file
     (`server.ts`). It is already a dependency, so `npx tsx firestarter-mcp`
     pulls it in. Do not drop `tsx` from the command.

2. **You have an API key to test with.** The server exits immediately if
   `FIRESTARTER_API_KEY` is unset (`server.ts` lines 9–12). Reviewers may smoke-test;
   you want a working key path. Get one from the Firestarter API
   (https://api.firestarter.network).

3. **The server starts and lists tools.** Verify locally (see the Verification
   section below) before pasting anything into a directory form.

4. **You can edit / open a PR against the directory's source repo.** Most MCP
   directories are GitHub-backed and accept listings via pull request. Have a
   GitHub account ready.

---

## What to paste (the canonical config block)

Most directories want a JSON snippet in the `mcpServers` shape that Claude Code,
Claude Desktop, and Cursor all consume. Paste this:

```json
{
  "mcpServers": {
    "firestarter": {
      "command": "npx",
      "args": ["tsx", "firestarter-mcp"],
      "env": {
        "FIRESTARTER_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

To pin a non-default API base, add `"FIRESTARTER_API_URL"` to `env`. Omit it to use
`https://api.firestarter.network`.

The full machine-readable manifest (name, version, description, transport, env,
and all five tool schemas) is [`mcp.json`](./mcp.json) in this directory. If a
submission form asks for a manifest file or a tools list, upload or paste that.

Listing metadata most forms ask for:

| Field | Value |
|---|---|
| Server name | `firestarter` |
| Display name | Firestarter Commerce |
| Version | `1.0.0` |
| Description | Execute commerce transactions from natural language. Find products matching a request, verify suppliers, get pricing, and optionally handle payment and delivery, with an approval step before money moves. |
| Transport | stdio |
| Homepage | https://api.firestarter.network |
| Run command | `npx tsx firestarter-mcp` |
| Required env | `FIRESTARTER_API_KEY` |
| Optional env | `FIRESTARTER_API_URL` (default `https://api.firestarter.network`) |
| Tools | `firestarter_execute`, `firestarter_status`, `firestarter_approve`, `firestarter_cancel`, `firestarter_message` |

---

## Steps — Claude Code MCP directory

1. Open the Anthropic MCP directory / registry submission page. The MCP registry
   project lives at https://github.com/modelcontextprotocol/registry and the
   directory surfaced inside Claude Code / Claude Desktop is fed from it. Start
   from https://modelcontextprotocol.io and follow its "submit a server" /
   "registry" link to the current intake (the exact URL moves as the program
   evolves; the docs site is the stable entry point).

2. Choose the submission path the page offers:
   - **PR-based:** fork the registry repo, add an entry for `firestarter` using
     the metadata table above plus the config block, and open a pull request.
   - **Form-based:** fill in the fields from the metadata table. Where it asks for
     the install/run command, use `npx tsx firestarter-mcp`. Where it asks for
     env vars, declare `FIRESTARTER_API_KEY` (required) and `FIRESTARTER_API_URL`
     (optional).

3. If the form accepts a manifest file, attach [`mcp.json`](./mcp.json).

4. Submit the PR or form. **You do this — this guide stops here.**

5. Respond to reviewer feedback. The usual asks: confirm the package is
   `npx`-installable, confirm tool descriptions match runtime, confirm the server
   handles a missing API key gracefully (it exits with a clear message — that is
   expected).

---

## Steps — Cursor MCP directory

1. Open Cursor's MCP directory submission page (Cursor → Settings → MCP, or the
   Cursor MCP directory web page with its "Submit" / "Add your server" entry).
   Cursor consumes the same `mcpServers` config shape as the block above.

2. Provide the listing metadata from the table above.

3. For the install config, paste the canonical config block. Cursor's "Add to
   Cursor" deep links encode exactly this `command` + `args` + `env`, so keeping
   `command: "npx"` and `args: ["tsx", "firestarter-mcp"]` verbatim matters.

4. If Cursor requests a one-click install link, generate it from that same config
   (Cursor's docs describe the `cursor://` deep-link format). The payload is the
   server block — `firestarter` with `npx tsx firestarter-mcp` and the
   `FIRESTARTER_API_KEY` env var.

5. Submit. **You do this — this guide stops here.**

---

## Verification (run before submitting)

Confirm the server actually starts and advertises its five tools, so you are not
submitting a broken listing.

1. Start the server with a key set:

   ```bash
   FIRESTARTER_API_KEY=your-api-key-here npx tsx firestarter-mcp
   ```

   It runs on stdio and waits silently for a client. No crash and no
   `FIRESTARTER_API_KEY ... is required` message means startup is healthy.
   (Ctrl-C to stop.)

2. Confirm the missing-key guard works (reviewers may test this):

   ```bash
   npx tsx firestarter-mcp
   ```

   Expected: it prints `FIRESTARTER_API_KEY environment variable is required` and
   exits non-zero. That is correct behavior, not a bug.

3. Confirm the tool list end to end by wiring the canonical config block into a
   local Claude Code / Claude Desktop / Cursor MCP config and reloading. You should
   see the five `firestarter_*` tools appear.

---

## Troubleshooting

- **`npx` can't find `firestarter-mcp`.** The package isn't published or installed
  under the name `firestarter-api`. Publish to npm, or change the documented run
  command to a local path (e.g. `npx tsx /absolute/path/to/src/mcp/server.ts`) or a
  `git+https` install for the submission.
- **Server exits instantly on launch.** `FIRESTARTER_API_KEY` is unset. Set it in
  the `env` block of the config (see lines 9–12 of `server.ts`).
- **Tools call the wrong host.** `FIRESTARTER_API_URL` is pointed somewhere else.
  Remove it to fall back to `https://api.firestarter.network`.
- **Reviewer says the manifest and runtime disagree.** Re-check [`mcp.json`](./mcp.json)
  against [`server.ts`](./server.ts); the manifest mirrors the `server.tool(...)`
  registrations exactly. If `server.ts` changes, regenerate the manifest before
  resubmitting.

---

## Notes for the submitter

- Directory URLs and exact form fields change over time. The two stable entry
  points are https://modelcontextprotocol.io (Claude Code / Anthropic) and Cursor's
  in-app MCP settings. Everything you need to fill either is in the metadata table
  and the canonical config block above.
- This guide and `mcp.json` are the only two files added for the submission. They
  describe the server exactly as it exists in `server.ts` at version `1.0.0`; bump
  both if you change the server before submitting.
