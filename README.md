# Firestarter MCP Server

The [Model Context Protocol](https://modelcontextprotocol.io) server for
[Firestarter](https://firestarter.network) — AI-native commerce execution.
Lets an AI assistant search real products, buy them with your approval, track
deliveries, and run a seller business end to end.

Distributed two ways:

| Surface | How |
|---|---|
| **Claude Desktop** | Install the `.mcpb` desktop extension (`npm run build:mcpb`) |
| **Any MCP client** | Point it at `https://api.firestarter.network/mcp` with a Bearer API key |

## Quick start

```bash
npm ci
npm run build        # builds the inline shopping UI, then compiles
npm test
npm run build:mcpb   # produces mcpb/dist/firestarter.mcpb
```

Set `FIRESTARTER_API_KEY` (`fs_live_...` for live orders, `fs_test_...` for
sandbox) to run the stdio server. Get a key at
[firestarter.network/dashboard](https://firestarter.network/dashboard).

## Safety model

Purchases never complete without an explicit approval step: `firestarter_execute`
finds and prices options, and only `firestarter_approve` charges. Tools that
move money or delete records are annotated `destructiveHint: true` so MCP hosts
prompt before running them; read-only tools are annotated so they don't.

## Privacy Policy

Full policy: **https://firestarter.network/privacy** · Questions: **privacy@firestarter.network**

This section covers the Firestarter Desktop Extension (`apps/api/mcpb`), which runs the
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
