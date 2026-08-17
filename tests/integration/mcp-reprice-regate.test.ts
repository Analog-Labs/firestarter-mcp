/**
 * commerce#768: a reprice that trips possession verification must not read as
 * a plain success.
 *
 * The API used to gate possession verification only on draft -> active, so
 * repricing an active $499 listing to $305,000 walked past it. It now
 * re-evaluates the gate on any price/category change to a live listing: the new
 * values are saved, but the listing is pushed back to draft with a
 * verification_status of 'required'. That comes back as a 200 carrying a
 * `verification` block — NOT the 409 the activation path returns, which
 * verificationAskText already handles.
 *
 * Without this seam firestarter_reprice would print "Listing updated. Base
 * price: $305000" and the seller would never learn their listing went dark.
 *
 * Same harness as mcp-verify.test.ts: drive the REAL registered tool handlers
 * against a mocked global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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

function installFetch(json: any, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

const LISTING_ID = "lst_0odWKk5_";

/** The 200 the reprice route now returns when the gate re-fires. */
function regatedListing(over: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    base_price: 305000,
    current_price: 305000,
    status: "draft",
    dynamic_pricing: false,
    verification_status: "required",
    verification_code: "FS-T99X",
    verification: {
      status: "required",
      reason: "high_value",
      code: "FS-T99X",
      message: "Saved, but the new price/category needs possession verification — this listing has been moved back to draft and is no longer buyer-visible.",
      instructions: `Write the code FS-T99X by hand on a piece of paper, photograph it next to the item, and submit the photo URL via POST /v1/listings/${LISTING_ID}/verification with body {"photo_url": "..."}.`,
    },
    ...over,
  };
}

describe("firestarter_reprice — a re-gated reprice is not reported as a plain success", () => {
  it("says the listing is no longer buyer-visible and relays the code", async () => {
    installFetch(regatedListing());
    const tools = captureTools();

    const text = textOf(await tools.firestarter_reprice({ listing_id: LISTING_ID, base_price: 305000 }));

    expect(text).toContain("FS-T99X");
    expect(text).toMatch(/no longer buyer-visible|not buyer-visible|back to draft/i);
    expect(text).toContain("firestarter_verify");
  });

  it("names the trigger so the seller knows why", async () => {
    installFetch(regatedListing({ verification: { ...regatedListing().verification, reason: "luxury_category" } }));
    const tools = captureTools();

    const text = textOf(await tools.firestarter_reprice({ listing_id: LISTING_ID, base_price: 40 }));

    expect(text).toMatch(/luxury/i);
  });

  it("an ordinary reprice is untouched — no verification noise", async () => {
    installFetch({ id: LISTING_ID, base_price: 305, current_price: 305, status: "active", dynamic_pricing: false });
    const tools = captureTools();

    const text = textOf(await tools.firestarter_reprice({ listing_id: LISTING_ID, base_price: 305 }));

    expect(text).toContain("Base price: $305");
    expect(text).not.toMatch(/verification/i);
  });
});

describe("firestarter_update_listing — a re-gated category change is not reported as a plain success", () => {
  it("relays the code when recategorising a live listing trips the gate", async () => {
    installFetch(regatedListing({
      category: "Jewelry & Watches",
      verification: { ...regatedListing().verification, reason: "luxury_category" },
    }));
    const tools = captureTools();

    const text = textOf(await tools.firestarter_update_listing({ listing_id: LISTING_ID, category: "Jewelry & Watches" }));

    expect(text).toContain("FS-T99X");
    expect(text).toContain("firestarter_verify");
  });

  it("an ordinary detail edit is untouched", async () => {
    installFetch({ id: LISTING_ID, product_name: "Renamed", status: "active" });
    const tools = captureTools();

    const text = textOf(await tools.firestarter_update_listing({ listing_id: LISTING_ID, product_name: "Renamed" }));

    expect(text).toContain("Renamed");
    expect(text).not.toMatch(/verification/i);
  });
});
