/**
 * firestarter_verify + verification-aware error rendering (A3: possession
 * verification in the Cole-chat funnel).
 *
 * Activation of a high-value/luxury draft 409s with a structured verification
 * payload (FS-XXXX code + instructions). These tests pin the MCP seam:
 *   - firestarter_update_listing renders that payload as relayable chat
 *     instructions instead of flattening it to an error string
 *   - firestarter_verify submits the seller's photo and renders each verdict
 *     (verified / flagged / pending) plus the issue-code and not-required 409s
 *   - firestarter_import surfaces the collision heads-up and the verify step
 *
 * Same harness as mcp-import.test.ts: drive the REAL registered tool handlers
 * (captured via a fake McpServer) against a mocked global fetch.
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

type RecordedCall = { method: string; url: string; body: any };

function installFetch(
  respond: (method: string, url: string, body: any) => { status: number; json: any }
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init?: any) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(url), body });
      const { status, json } = respond(method, String(url), body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(res: any): string {
  return res.content.map((b: any) => b.text).join("\n");
}

const LISTING_ID = "lst_vmcp1";
const VERIFY_URL = `http://api.test/v1/listings/${LISTING_ID}/verification`;
const PHOTO = "https://files.pocodot.ai/u/abc/evidence.jpg";

const REQUIRED_409 = (reason: string) => ({
  status: 409,
  json: {
    error: "This listing needs possession verification before it can go live.",
    code: "VERIFICATION_REQUIRED",
    status: 409,
    verification: {
      status: "required",
      reason,
      code: "FS-7K2M",
      instructions: `Write the code FS-7K2M by hand on a piece of paper, photograph it next to the item, and submit the photo URL via POST /v1/listings/${LISTING_ID}/verification with body {"photo_url": "..."}.`,
    },
  },
});

describe("firestarter_verify — evidence submission", () => {
  it("posts the photo URL and renders an auto-approved verdict with the activation step", async () => {
    const calls = installFetch(() => ({
      status: 200,
      json: {
        id: LISTING_ID,
        verification_status: "verified",
        checked: { item_match: true, code_match: true },
        next_step: "PATCH status to 'active' to go live.",
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: PHOTO });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: VERIFY_URL });
    expect(calls[0].body).toEqual({ photo_url: PHOTO });

    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("Verified.");
    expect(text).toContain("no human review");
    expect(text).toMatch(/firestarter_update_listing \(status "active"\)/);
  });

  it("renders the already-verified short-circuit distinctly", async () => {
    installFetch(() => ({
      status: 200,
      json: {
        id: LISTING_ID,
        verification_status: "verified",
        verified_at: "2026-06-12T00:00:00Z",
        message: "Listing is already verified.",
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: PHOTO });

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("already verified");
  });

  it("flagged: shows which check failed and invites a resubmission", async () => {
    installFetch(() => ({
      status: 200,
      json: {
        id: LISTING_ID,
        verification_status: "flagged",
        checked: { item_match: false, code_match: true },
        message: "The photo did not clearly match the listing and code.",
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: PHOTO });

    const text = textOf(res);
    expect(res.isError).toBeFalsy(); // a flagged verdict is an outcome, not a tool failure
    expect(text).toContain("Not verified");
    expect(text).toContain("Item match: no");
    expect(text).toContain("Code match: yes");
    expect(text).toContain("resubmit");
    expect(text).toContain("firestarter_verify");
  });

  it("pending (vision could not check): held for review, resubmit possible", async () => {
    installFetch(() => ({
      status: 200,
      json: {
        id: LISTING_ID,
        verification_status: "pending",
        message: "The photo was received but could not be auto-checked right now.",
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: PHOTO });

    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("not auto-checked");
    expect(text).toContain("resubmit");
  });

  it("409 VERIFICATION_REQUIRED (code just issued) relays the handwritten-code instructions", async () => {
    installFetch(() => REQUIRED_409("source_conflict"));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: PHOTO });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("FS-7K2M");
    expect(text).toContain("by hand");
    expect(text).toContain("source URL was already imported by another seller");
    expect(text).toContain("firestarter_verify");
  });

  it("409 VERIFICATION_NOT_REQUIRED points straight at activation", async () => {
    installFetch(() => ({
      status: 409,
      json: { error: "This listing does not require verification.", code: "VERIFICATION_NOT_REQUIRED", status: 409 },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: PHOTO });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not need possession verification/i);
    expect(textOf(res)).toContain("firestarter_update_listing");
  });

  it("400 INVALID_PHOTO_URL explains the public-URL bar", async () => {
    installFetch(() => ({
      status: 400,
      json: { error: "photo_url rejected: private or non-https URLs are not allowed", code: "INVALID_PHOTO_URL", status: 400 },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_verify({ listing_id: LISTING_ID, photo_url: "http://10.0.0.1/x.jpg" });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("photo_url rejected");
    expect(text).toContain("public https image URL");
  });
});

describe("firestarter_update_listing — verification-aware activation errors", () => {
  it("409 VERIFICATION_REQUIRED (high_value) renders the code + photo steps, not a flat error", async () => {
    installFetch(() => REQUIRED_409("high_value"));
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({ listing_id: LISTING_ID, status: "active" });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("FS-7K2M");
    expect(text).toContain("high-value item");
    expect(text).toContain("Write FS-7K2M by hand");
    expect(text).toContain("Send that photo here in chat");
    expect(text).toContain("firestarter_verify");
    expect(text).not.toContain("Error updating listing");
  });

  it("409 VERIFICATION_REQUIRED (luxury_category) names the luxury reason", async () => {
    installFetch(() => REQUIRED_409("luxury_category"));
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({ listing_id: LISTING_ID, status: "active" });

    expect(textOf(res)).toContain("luxury-category item");
  });

  it("409 VERIFICATION_PENDING explains the hold and the resubmit path", async () => {
    installFetch(() => ({
      status: 409,
      json: {
        error: "Verification evidence was received but could not be auto-checked yet.",
        code: "VERIFICATION_PENDING",
        status: 409,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({ listing_id: LISTING_ID, status: "active" });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("held for review");
    expect(text).toContain("firestarter_verify");
  });

  it("409 VERIFICATION_FLAGGED asks for a clearer photo via firestarter_verify", async () => {
    installFetch(() => ({
      status: 409,
      json: {
        error: "Submitted evidence did not match this listing and is queued for review.",
        code: "VERIFICATION_FLAGGED",
        status: 409,
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({ listing_id: LISTING_ID, status: "active" });

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("did not match");
    expect(text).toContain("firestarter_verify");
  });

  it("non-verification errors still flatten to the plain message", async () => {
    installFetch(() => ({
      status: 404,
      json: { error: "Listing not found", code: "NOT_FOUND", status: 404 },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_update_listing({ listing_id: LISTING_ID, status: "active" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Error updating listing: Listing not found");
  });
});

describe("firestarter_import — verification heads-up in the draft summary", () => {
  const DRAFT = {
    id: "lst_draft1",
    product_name: "Trek Marlin 7 Mountain Bike",
    base_price: "450.00",
    currency: "USD",
    status: "draft",
    images: [],
    needs_review: [],
  };

  it("renders the source-conflict heads-up when the API flags the draft", async () => {
    installFetch(() => ({
      status: 201,
      json: {
        ...DRAFT,
        verification: {
          status: "required",
          reason: "source_conflict",
          detail: "This source URL was already imported by another seller. Activation will require a possession-verification photo.",
        },
      },
    }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: "https://example.com/item/1" });

    const text = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("Heads-up: possession verification will be required at activation");
    expect(text).toContain("already imported by another seller");
    expect(text).toContain("FS-XXXX");
  });

  it("clean drafts skip the heads-up but the funnel still teaches the verify step", async () => {
    installFetch(() => ({ status: 201, json: DRAFT }));
    const tools = captureTools();

    const res = await tools.firestarter_import({ source_url: "https://example.com/item/2" });

    const text = textOf(res);
    expect(text).not.toContain("Heads-up: possession verification");
    // Step 3 of the funnel mentions the possession-photo possibility so the
    // agent sets expectations before flipping status to active.
    expect(text).toContain("possession photo");
    expect(text).toContain("firestarter_verify");
  });
});
