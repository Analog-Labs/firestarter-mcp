/**
 * #256: buyer-facing purchase-confirmation contract.
 *
 * The message a buyer reads in chat when Firestarter presents options for
 * approval was a debug dump (lead with "Execution exec_… / Status / Request",
 * a terse "$total from supplier" line, a raw "URL:" label, and an inline
 * markdown/base64 image that never rendered across channels). This pins the
 * redesigned contract that formatExecution + the firestarter_execute prompt now
 * produce:
 *
 *   R1  approval confirmations DROP the internal "Execution/Status/Request"
 *       header so the product leads;
 *   R2  every other state (a post-purchase status check) KEEPS that header as
 *       the track/dispute reference;
 *   R3  each option leads with a bold "$X all-in" total, then the item+shipping
 *       split, and ALWAYS states tax status ("no tax" when there is none);
 *   R5  the share link is the API's product_url verbatim (lst_ prefix intact so
 *       /l/:id resolves) as a BARE url - no markdown link, no "URL:" label;
 *   R6  the action prompt invites reply "confirm" (not "approve"); all-external
 *       and no-confident-match results never invite confirm;
 *   R7  the tools return text blocks only - no inline image block, no "![" .
 *
 * Harness mirrors mcp-margin-disclosure / mcp-execute-attribution: drive the
 * REAL registered tool handlers (captured via a fake McpServer) against a
 * mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools(
    { tool: (n: string, ...rest: any[]) => { tools[n] = rest[rest.length - 1] as ToolHandler; } } as any,
    "fsk_test",
    "http://api.test"
  );
  return tools;
}

// firestarter_status: a single GET returns the execution verbatim.
function installStatusFetch(exec: any) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(exec), { status: 200, headers: { "Content-Type": "application/json" } })
  ));
}

// firestarter_execute: POST /v1/executions -> {finding}, then GET -> exec.
function installExecuteFetch(exec: any) {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    if (method === "POST" && String(url).endsWith("/v1/executions")) {
      return new Response(JSON.stringify({ id: exec.id, status: "finding" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "GET" && String(url).includes("/v1/executions/")) {
      return new Response(JSON.stringify(exec), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
}

function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

// A real /l/ share link with the lst_ prefix intact (stripping it 404s).
const SHARE_URL = "https://firestarter.network/l/lst_qLcYasBq";

// Internal, purchasable option: real share link, carries a photo, no tax.
// match_score clears the relevance floor (>= 40) so the execute prompt reaches
// the "confirm" suffix rather than the "no confident match" branch.
const INTERNAL_OPT = {
  product_title: "Anker 7-in-1 USB-C Hub",
  supplier: "Matrix Store",
  subtotal: "34.99",
  shipping: "9.99",
  tax: null,
  total: "44.98",
  quantity: 1,
  purchasable: true,
  match_score: 88,
  product_url: SHARE_URL,
  metadata: { image: "https://cdn.example.com/hub.jpg" },
  agent_reasoning: "Closest match to a 7-in-1 hub under $50.",
};

// External marketplace option: browse-only, not checkout-able.
const EXTERNAL_OPT = {
  product_title: "Generic USB-C Hub",
  supplier: "eBay",
  total: "39.00",
  purchasable: false,
  match_score: 60,
  product_url: "https://ebay.com/itm/123456",
};

// A Firestarter store that simply hasn't enabled checkout yet (seeded/unclaimed
// catalog or a seller without Stripe). browse-only, but NOT external - it's in
// our catalog with an owner we can activate. source = firestarter_seller and the
// product_url is a real /l/ share link.
const UNCONNECTED_STORE_OPT = {
  product_title: "Anker 7-in-1 USB-C Hub",
  supplier: "Gadget Town",
  total: "41.00",
  purchasable: false,
  match_score: 82,
  product_url: SHARE_URL,
  metadata: { source: "firestarter_seller", seller_stripe_connected: false },
};

// The buyer's own listing (#334): surfaced so they see how it appears, but never
// offered for purchase and never labeled "external".
const OWN_OPT = {
  product_title: "My Listed USB-C Hub",
  supplier: "Your Store",
  total: "40.00",
  purchasable: false,
  own_listing: true,
  match_score: 90,
  product_url: SHARE_URL,
  metadata: { source: "firestarter_seller" },
};

const approvalExec = (options: any[]) => ({
  id: "exec_conf1",
  status: "awaiting_approval",
  request_text: "usb-c hub under $50",
  options,
});

describe("#256 buyer confirmation - rendering (firestarter_status)", () => {
  it("R1: drops the internal Execution/Status/Request header on approval", async () => {
    installStatusFetch(approvalExec([INTERNAL_OPT]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).not.toContain("**Execution exec_conf1**");
    expect(text).not.toContain("Status:");
    expect(text).not.toContain("Request:");
    expect(text).toContain("Options found:");
  });

  it("R3: leads with the bold all-in total and states 'no tax' when there is none", async () => {
    installStatusFetch(approvalExec([INTERNAL_OPT]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("**$44.98 all-in** - $34.99 item + $9.99 shipping, no tax");
  });

  it("R3: shows the tax amount (not 'no tax') when tax is charged", async () => {
    installStatusFetch(approvalExec([{ ...INTERNAL_OPT, tax: "3.60", total: "48.58" }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("$3.60 tax");
    expect(text).not.toContain("no tax");
  });

  it("R3: subtracts a voucher/drop discount in the item line so the parts sum to the all-in total", async () => {
    // Regression: subtotal/shipping are GROSS (the discount is only baked into
    // `total`), so a discounted option used to render "$20 item + $52.19
    // shipping" (= $72.19) next to a correct "$67.19 all-in" - the itemization
    // silently failed to account for the $5 discount.
    installStatusFetch(approvalExec([{
      ...INTERNAL_OPT,
      subtotal: "20.00",
      shipping: "52.19",
      discount: "5.00",
      total: "67.19",
    }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("**$67.19 all-in** - $20.00 item - $5.00 discount + $52.19 shipping, no tax");
  });

  it("R3: names the voucher that applied", async () => {
    // Regression: the quote step stamps voucher_code/voucher_discount_cents on
    // the option's metadata, but nothing ever read it back — a buyer saw the
    // correct discounted total with no idea a voucher was involved.
    installStatusFetch(approvalExec([{
      ...INTERNAL_OPT,
      subtotal: "20.00",
      shipping: "52.19",
      discount: "5.00",
      total: "67.19",
      metadata: { image: "https://cdn.example.com/hub.jpg", voucher_code: "SAVE5", voucher_discount_cents: 500 },
    }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("Voucher SAVE5 applied: -$5.00");
  });

  it("R3: explains why an explicit voucher_code didn't apply, per the tool's own doc promise", async () => {
    // Regression: firestarter_execute's voucher_code param docs promise "the
    // response explains why it didn't apply" — voucher_rejected was stamped on
    // the option by the quote step but never rendered anywhere.
    installStatusFetch(approvalExec([{
      ...INTERNAL_OPT,
      metadata: {
        image: "https://cdn.example.com/hub.jpg",
        voucher_rejected: { code: "EXPIRED10", reason: "EXPIRED", message: "That code has expired." },
      },
    }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain('Voucher code "EXPIRED10" didn\'t apply: That code has expired.');
  });

  it("R3: shows both the rejected explicit code and the voucher auto-apply fell back to", async () => {
    installStatusFetch(approvalExec([{
      ...INTERNAL_OPT,
      subtotal: "20.00",
      shipping: "52.19",
      discount: "2.00",
      total: "70.19",
      metadata: {
        image: "https://cdn.example.com/hub.jpg",
        voucher_rejected: { code: "EXPIRED10", reason: "EXPIRED", message: "That code has expired." },
        voucher_code: "SAVE2",
        voucher_discount_cents: 200,
      },
    }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    const rejectedIdx = text.indexOf('Voucher code "EXPIRED10" didn\'t apply');
    const appliedIdx = text.indexOf("Voucher SAVE2 applied");
    expect(rejectedIdx).toBeGreaterThan(-1);
    expect(appliedIdx).toBeGreaterThan(rejectedIdx);
  });

  it("R3: pluralizes the item line when quantity > 1", async () => {
    installStatusFetch(approvalExec([{ ...INTERNAL_OPT, quantity: 2 }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("$34.99 items x2");
  });

  it("R2/R4: leads with condition + included/missing, and surfaces a delivery estimate", async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    installStatusFetch(approvalExec([{
      ...INTERNAL_OPT,
      delivery_estimate: future,
      metadata: { image: "https://cdn.example.com/hub.jpg", condition: "refurbished", included: "USB-C cable", missing: "original box" },
    }]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("(refurbished)"); // condition in the lead, in bold with the title
    expect(text).toContain("Includes: USB-C cable");
    expect(text).toContain("Not included: original box");
    expect(text).toContain("Arrives in"); // delivery estimate rendered
  });

  it("R2/R4: omits condition/included/delivery lines when the option has none", async () => {
    installStatusFetch(approvalExec([INTERNAL_OPT])); // no condition/delivery in fixture
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).not.toContain("Includes:");
    expect(text).not.toContain("Not included:");
    expect(text).not.toContain("Arrives in");
  });

  it("R5: emits the share link verbatim (lst_ prefix intact), bare - no markdown, no 'URL:'", async () => {
    installStatusFetch(approvalExec([INTERNAL_OPT]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("View listing: https://firestarter.network/l/lst_qLcYasBq");
    expect(text).toContain("/l/lst_qLcYasBq"); // prefix preserved -> /l/:id resolves
    expect(text).not.toContain("]("); // not a markdown link (breaks in WhatsApp/Telegram)
    expect(text).not.toContain("URL:");
  });

  it("R7: returns image blocks for options with product images", async () => {
    installStatusFetch(approvalExec([INTERNAL_OPT]));
    const res = await captureTools().firestarter_status({ execution_id: "exec_conf1" });
    // Image blocks are included for options with image URLs
    const imageBlocks = res.content.filter((b: any) => b.type === "image");
    const textBlocks = res.content.filter((b: any) => b.type === "text");
    expect(textBlocks.length).toBeGreaterThan(0);
    // No markdown images in text (images are separate blocks)
    expect(textOf(res)).not.toContain("![");
  });

  it("browse-only option: labeled, links to the source site, says buy-direct", async () => {
    installStatusFetch(approvalExec([EXTERNAL_OPT]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("browse-only (external)");
    expect(text).toContain("**$39.00 all-in** - no tax");
    expect(text).toContain("View on eBay: https://ebay.com/itm/123456");
    expect(text).toContain("Firestarter cannot purchase it");
    expect(text).toContain("share the link");
    expect(text).not.toContain("Total with app margin");
    // A genuine external result must NOT be dressed up as a Firestarter store.
    expect(text).not.toContain("Firestarter store");
  });

  it("browse-only Firestarter store (not Stripe-connected): honest 'checkout not enabled', NOT 'external'", async () => {
    installStatusFetch(approvalExec([UNCONNECTED_STORE_OPT]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("Firestarter store (checkout not enabled yet)");
    expect(text).toContain("hasn't enabled checkout yet");
    expect(text).toContain(`View on Firestarter: ${SHARE_URL}`);
    // It is browse-only but it is NOT external, and we don't tell the buyer to
    // "buy it directly elsewhere" - there is no elsewhere, it's our seller.
    expect(text).not.toContain("external");
    expect(text).not.toContain("Firestarter cannot purchase it");
    expect(text).not.toContain("purchase directly");
    expect(text).not.toContain("Total with app margin");
  });

  it("the buyer's own listing (#334): labeled 'your listing', never 'external'", async () => {
    installStatusFetch(approvalExec([OWN_OPT]));
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_conf1" }));
    expect(text).toContain("- your listing");
    expect(text).toContain("This is your own listing");
    expect(text).toContain(`View your listing: ${SHARE_URL}`);
    expect(text).not.toContain("external");
    expect(text).not.toContain("Firestarter store (checkout not enabled yet)");
    expect(text).not.toContain("Firestarter cannot purchase it");
  });

  it("all-browse-only aggregate note: Firestarter stores read as 'haven't enabled checkout', not 'external marketplace'", async () => {
    installExecuteFetch(approvalExec([UNCONNECTED_STORE_OPT, { ...UNCONNECTED_STORE_OPT, supplier: "Cable Hut" }]));
    const text = textOf(await captureTools().firestarter_execute({ request: "usb-c hub under $50" }));
    expect(text).toContain("Firestarter stores that haven't enabled checkout yet");
    expect(text).not.toContain("external marketplace listing");
  });

  it("R2: a non-approval status (paid) keeps the Execution/Status header, even with options", async () => {
    installStatusFetch({ id: "exec_paid1", status: "paid", request_text: "usb-c hub", options: [INTERNAL_OPT] });
    const text = textOf(await captureTools().firestarter_status({ execution_id: "exec_paid1" }));
    expect(text).toContain("**Execution exec_paid1**");
    expect(text).toContain("Status: paid");
  });
});

describe("#256 buyer confirmation - action prompt (firestarter_execute)", () => {
  it("R6: a purchasable match invites reply \"confirm\" (not \"approve\"), header still suppressed", async () => {
    installExecuteFetch(approvalExec([INTERNAL_OPT]));
    const text = textOf(await captureTools().firestarter_execute({ request: "usb-c hub under $50" }));
    expect(text).toContain('reply "confirm"');
    expect(text).toContain("place the order");
    expect(text).not.toContain('reply "approve"');
    expect(text).not.toContain("**Execution exec_conf1**");
  });

  it("R6: all-external results do NOT invite confirm - buy-direct guidance instead", async () => {
    installExecuteFetch(approvalExec([EXTERNAL_OPT]));
    const text = textOf(await captureTools().firestarter_execute({ request: "usb-c hub under $50" }));
    expect(text).not.toContain('reply "confirm"');
    expect(text).toContain("browse-only");
    expect(text).toContain("share the URLs");
  });

  it("R6: no confident match (all scores under the floor) does NOT invite confirm", async () => {
    installExecuteFetch(approvalExec([
      { ...INTERNAL_OPT, match_score: 10 },
      { ...EXTERNAL_OPT, match_score: 5 },
    ]));
    const text = textOf(await captureTools().firestarter_execute({ request: "usb-c hub under $50" }));
    // #525: a no-confident-match now surfaces the closest options to browse
    // instead of flatly declining - but still must NOT invite a confirm/approve.
    expect(text).toContain("No exact match");
    expect(text).toContain("closest");
    expect(text).not.toContain('reply "confirm"');
  });
});
