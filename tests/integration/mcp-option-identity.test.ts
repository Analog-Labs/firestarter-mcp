/**
 * The agent must always be able to name the thing it is buying.
 *
 * Two gaps made that impossible, and both dead-ended the buyer flow:
 *
 *   G1  firestarter_preview closes with "call firestarter_execute (or pass a
 *       listing_id)" but never printed an id. It lived only in
 *       structuredContent, which many hosts never surface to the model — and a
 *       BUYABLE option printed no url either (that line is browse-only). So the
 *       agent was told to pass an id it had never been given, and fell back to
 *       re-running the whole natural-language search, which can rank a different
 *       seller's listing first: the buyer picks option 1 and gets option 4.
 *
 *   G2  firestarter_approve documents option_id as the exact way to choose, but
 *       formatExecution never rendered opt.id anywhere. A text-only agent had no
 *       source for one, so it was forced onto selected_option — a POSITIONAL
 *       index that approve resolves against a RE-FETCH sorted on mutable keys
 *       (selected, then purchasable, then match_score). If the list re-quotes
 *       between display and approval, that index resolves to a different
 *       product and charges for it silently.
 *
 * Also pinned: browse-only options do NOT get an option_id (they cannot be
 * approved, and showing one only invites the attempt), and approve echoes the
 * product it actually resolved so a mis-resolution is visible.
 *
 * Harness mirrors mcp-buyer-confirmation: drive the REAL registered handlers
 * against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const server: any = {
    tool: (n: string, ...rest: any[]) => { tools[n] = rest[rest.length - 1] as ToolHandler; },
    registerTool: (n: string, _cfg: any, handler: ToolHandler) => { tools[n] = handler; },
  };
  registerTools(server, "fs_test_key", "http://api.test");
  return tools;
}

function textOf(res: any): string {
  return res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("firestarter_preview surfaces a chainable listing id (G1)", () => {
  const previewBody = {
    query: "polo shirt",
    options: [
      {
        id: "lst_buyable1", title: "Classic Polo", price: 18, currency: "USD",
        seller: "Acme", source: "firestarter_seller", url: "https://firestarter.network/l/lst_buyable1",
        in_stock: true, purchasable: true, eligible: true, shipping: { known: true, amount_usd: 0 },
      },
      {
        id: "ext_web9", title: "Polo From The Web", price: 22, currency: "USD",
        seller: "SomeShop", source: "google_shopping", url: "https://shop.example/polo",
        in_stock: true, purchasable: false, eligible: false, shipping: { known: false, amount_usd: null },
      },
    ],
  };

  it("prints the listing_id in the TEXT, not only in structuredContent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(previewBody)));
    const res = await captureTools().firestarter_preview({ query: "polo shirt" });
    const text = textOf(res);

    // The regression: the id existed in structuredContent but never in text, so
    // hosts that render only `content` left the model with nothing to pass.
    expect(text).toContain("lst_buyable1");
    expect(text).toMatch(/listing_id: `lst_buyable1`/);
  });

  it("does not offer an id for a browse-only option", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(previewBody)));
    const text = textOf(await captureTools().firestarter_preview({ query: "polo shirt" }));
    expect(text).not.toMatch(/listing_id: `ext_web9`/);
  });

  it("still populates structuredContent, so typed clients are unaffected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(previewBody)));
    const res: any = await captureTools().firestarter_preview({ query: "polo shirt" });
    expect(res.structuredContent.options[0].id).toBe("lst_buyable1");
  });
});

describe("formatExecution surfaces option_id for approval (G2)", () => {
  const exec = {
    id: "exec_abc",
    status: "awaiting_approval",
    request_text: "polo shirt",
    options: [
      {
        id: "opt_real1", product_title: "Classic Polo", supplier: "Acme",
        total: 20, subtotal: 18, shipping: 2, tax: 0, purchasable: true,
        product_url: "https://firestarter.network/l/lst_1",
      },
      {
        id: "opt_browse2", product_title: "Web Polo", supplier: "SomeShop",
        total: 22, subtotal: 22, shipping: 0, tax: 0, purchasable: false,
        metadata: { source: "google_shopping" },
        product_url: "https://shop.example/polo",
      },
    ],
  };

  function installExecuteFetch() {
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      if (method === "POST" && String(url).endsWith("/v1/executions")) {
        return json({ id: exec.id, status: "finding" }, 201);
      }
      if (String(url).includes("/poll")) return json({ status: "awaiting_approval", has_options: true });
      if (method === "GET" && String(url).includes("/v1/executions/")) return json(exec);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));
  }

  it("prints option_id for the purchasable option", async () => {
    installExecuteFetch();
    const text = textOf(await captureTools().firestarter_execute({ request: "polo shirt" }));
    expect(text).toMatch(/option_id: `opt_real1`/);
    expect(text).toContain("firestarter_approve");
  });

  it("does NOT print option_id for a browse-only option", async () => {
    installExecuteFetch();
    const text = textOf(await captureTools().firestarter_execute({ request: "polo shirt" }));
    // Approving one is rejected upstream anyway; offering the handle just
    // invites the agent to try and produces a confusing failure.
    expect(text).not.toMatch(/option_id: `opt_browse2`/);
  });

  it("keeps the product leading — the id never heads the option block (#256)", async () => {
    installExecuteFetch();
    const text = textOf(await captureTools().firestarter_execute({ request: "polo shirt" }));
    expect(text.indexOf("Classic Polo")).toBeLessThan(text.indexOf("opt_real1"));
  });
});

describe("firestarter_approve names what it actually bought", () => {
  it("echoes the resolved product title so a mis-resolution is visible", async () => {
    const approved = {
      id: "exec_abc",
      status: "awaiting_payment_method",
      request_text: "polo shirt",
      setup_url: "https://pay.test/setup",
      selected_option: { product_title: "Classic Polo", total_cents: 2000 },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      if (method === "POST" && String(url).includes("/approve")) return json({ total_cents: 2000 });
      if (String(url).includes("/poll")) return json({ status: "awaiting_payment_method" });
      if (method === "GET" && String(url).includes("/v1/executions/")) return json(approved);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));

    const text = textOf(await captureTools().firestarter_approve({ execution_id: "exec_abc" }));
    // Approval resolves an option through three different paths and none of them
    // used to say which product won.
    expect(text).toContain("Item: Classic Polo");
    expect(text).toContain("Order approved.");
  });
});
