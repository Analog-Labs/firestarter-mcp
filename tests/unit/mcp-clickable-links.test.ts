/**
 * Clickable links in tool results.
 *
 * Tool text is markdown, but a bare URL is only auto-linked by renderers that
 * implement the GFM autolink extension — several MCP clients do not, so every
 * link we emitted was dead text the user had to select and copy. These pin the
 * balance we settled on:
 *
 *  - the links a human would actually click ARE markdown links: a listing's
 *    share page, the card-setup page, carrier tracking, a community URL;
 *  - product IMAGE urls stay BARE, so chat clients keep auto-unfurling a
 *    preview and agents can still fetch the bytes (#611) — and so a 50-row
 *    catalogue is not a wall of blue;
 *  - at most ONE link per catalogue row, carried on the product name rather
 *    than added as an extra line;
 *  - a seller-controlled label can never retarget the link (markdown-link
 *    injection through a product name).
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

const SHARE = "https://firestarter.network/l/lst_abc";
const IMG = "https://api.firestarter.network/v1/img/deadbeef";

function jsonResponse(status: number, data: any): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Route every call this suite makes; unknown routes throw loudly. */
function installFetch(routes: Array<[RegExp, any]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      for (const [re, body] of routes) if (re.test(u)) return jsonResponse(200, body);
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

function text(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("catalog_search rows", () => {
  const listing = {
    id: "lst_abc",
    product_name: "Leather Wallet",
    category: "Accessories",
    current_price: 20,
    currency: "USD",
    buyable: true,
    share_url: SHARE,
    images: [IMG],
  };

  it("makes the product NAME the link and drops the duplicate bare share URL", async () => {
    installFetch([[/\/v1\/listings\/catalog/, { query: { environment: "live" }, count: 1, listings: [listing], has_more: false }]]);
    const out = text(await captureTools().firestarter_catalog_search({ query: "wallet" }));

    expect(out).toContain(`**[Leather Wallet](${SHARE})**`);
    // The URL appears exactly once — as the link target, not also as loose text.
    expect(out.split(SHARE).length - 1).toBe(1);
    // The id stays machine-readable for firestarter_execute.
    expect(out).toContain("id: `lst_abc`");
  });

  it("keeps the product IMAGE url bare so clients still unfurl it", async () => {
    installFetch([[/\/v1\/listings\/catalog/, { query: { environment: "live" }, count: 1, listings: [listing], has_more: false }]]);
    const out = text(await captureTools().firestarter_catalog_search({ query: "wallet" }));

    expect(out).toContain(`\n  ${IMG}`);
    expect(out).not.toContain(`](${IMG})`);
  });

  it("falls back to plain text when a sandbox listing has no share link", async () => {
    installFetch([[/\/v1\/listings\/catalog/, {
      query: { environment: "test" }, count: 1, has_more: false,
      listings: [{ ...listing, share_url: null }],
    }]]);
    const out = text(await captureTools().firestarter_catalog_search({ query: "wallet" }));

    expect(out).toContain("**Leather Wallet**");
    expect(out).toContain("sandbox-only, no public link yet");
    expect(out).not.toContain("](null)");
  });

  // A listing name is seller-controlled. Without escaping, "Mug](https://evil…"
  // closes the link text and retargets the click.
  it("cannot be retargeted by a product name containing link syntax", async () => {
    installFetch([[/\/v1\/listings\/catalog/, {
      query: { environment: "live" }, count: 1, has_more: false,
      listings: [{ ...listing, product_name: "Mug](https://evil.example) x" }],
    }]]);
    const out = text(await captureTools().firestarter_catalog_search({ query: "mug" }));

    // The property that matters: the click still goes to OUR share page. The
    // attacker's text may survive as inert label characters (brackets are
    // stripped, so it can never close the label and open a new target).
    expect(out).not.toContain("](https://evil.example)");
    expect(out).toContain(`](${SHARE})`);
    expect(out).not.toMatch(/\]\((?!https:\/\/firestarter\.network)/);
  });
});

describe("action links", () => {
  it("payment_method links the card-setup page and the dashboard", async () => {
    installFetch([
      [/\/v1\/payments\/methods/, { payment_methods: [] }],
      [/\/v1\/billing\/setup-payment/, { url: "https://billing.stripe.com/session/xyz" }],
    ]);
    const out = text(await captureTools().firestarter_payment_method({}));

    expect(out).toContain("](https://billing.stripe.com/session/xyz)");
    expect(out).toContain("dashboard settings](https://firestarter.network/dashboard?tab=settings)");
  });

  it("track_order links carrier tracking, labelled with the carrier", async () => {
    installFetch([[/\/tracking/, {
      tracking_number: "1Z999", carrier: "UPS", status: "in_transit",
      tracking_url: "https://ups.com/track?num=1Z999",
    }]]);
    const out = text(await captureTools().firestarter_track_order({ execution_id: "exec_1" }));

    expect(out).toContain("[Track with UPS](https://ups.com/track?num=1Z999)");
  });
});

describe("link density", () => {
  it("a 10-row catalogue emits one link per row, not two", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ...{ id: `lst_${i}`, product_name: `Item ${i}`, current_price: 5, currency: "USD", buyable: true },
      share_url: `https://firestarter.network/l/lst_${i}`,
      images: [IMG],
    }));
    installFetch([[/\/v1\/listings\/catalog/, { query: { environment: "live" }, count: 10, listings: rows, has_more: false }]]);
    const out = text(await captureTools().firestarter_catalog_search({ query: "item" }));

    // Exactly 10 markdown links for 10 rows; the images add none.
    expect((out.match(/\]\(https:\/\//g) || []).length).toBe(10);
  });
});
