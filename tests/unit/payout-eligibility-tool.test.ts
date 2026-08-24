/**
 * The pre-effort answer. A seller in Lagos should learn we cannot pay them
 * before they photograph a single item, not after they have accrued escrow.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerTools } from "../../src/mcp/tools.js";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/mcp/tools.ts", import.meta.url)),
  "utf8",
);

/**
 * Anchored on the quoted-name-with-trailing-comma form `server.tool("name",
 * ...)` always uses at a registration site, NOT the bare substring.
 *
 * The bare substring "firestarter_payout_eligibility" first appears earlier
 * in the file, inside firestarter_payouts' own (corrected) description,
 * which correctly points agents at this tool by name. `indexOf` on the bare
 * substring would grab THAT occurrence and inspect firestarter_payouts' own
 * annotations (readOnlyHint: false, destructiveHint: true) instead of this
 * tool's — a false pass/fail depending on how much text happens to fall in
 * the following 2500 characters.
 */
const REGISTRATION_MARKER = '"firestarter_payout_eligibility",';
const registrationIdx = SOURCE.indexOf(REGISTRATION_MARKER);
const BLOCK = registrationIdx === -1 ? "" : SOURCE.slice(registrationIdx, registrationIdx + 2500);

describe("firestarter_payout_eligibility (source)", () => {
  it("is registered", () => {
    expect(registrationIdx).toBeGreaterThan(-1);
  });

  it("is annotated read-only", () => {
    expect(BLOCK).toMatch(/readOnlyHint:\s*true/);
    expect(BLOCK).toMatch(/destructiveHint:\s*false/);
  });

  it("calls the eligibility endpoint", () => {
    expect(BLOCK).toContain("/v1/payouts/eligibility");
  });
});

// ─── Behavioural coverage ───────────────────────────────────────────────────
// The three checks above only prove the tool exists and is wired to the right
// endpoint and annotations — they restate the source rather than exercising
// it. What actually matters for #839 is the SENTENCE an agent gets back for
// an unsupported-vs-unknown corridor, so the handler is invoked for real
// below with a mocked fetch, the same pattern mcp-output-accuracy.test.ts uses.

type ToolHandler = (args: any) => Promise<any>;

function captureTools(key = "fs_live_k"): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, key, "http://api.test");
  return tools;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function textOf(res: any): string {
  return res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_payout_eligibility (behaviour)", () => {
  it("names a supported rail and does not claim inability, for a fully-supported country", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      country: "US",
      supported: true,
      waitlist_available: false,
      rails: [
        { provider: "stripe", supported: true, verdict: "supported", requirements: ["stripe_connect_onboarding"] },
        { provider: "paypal", supported: true, verdict: "supported", requirements: ["paypal_email"] },
      ],
    })));
    const out = textOf(await captureTools().firestarter_payout_eligibility({ country: "US" }));

    expect(out).toContain("We can pay sellers in");
    expect(out).toMatch(/STRIPE|PAYPAL/);
    expect(out).not.toMatch(/can't pay/i);
  });

  it("never asserts inability for a country while a rail is unknown (#839: PK — PayPal unsupported, Stripe unknown)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      country: "PK",
      supported: false,
      waitlist_available: true,
      rails: [
        { provider: "stripe", supported: false, verdict: "unknown", requirements: [] },
        { provider: "paypal", supported: false, verdict: "unsupported", requirements: [] },
      ],
    })));
    const out = textOf(await captureTools().firestarter_payout_eligibility({ country: "PK" }));

    // The exact false claim Correction 4 rules out: a blanket "we can't pay
    // this country" while Stripe's verdict is still "unknown".
    expect(out).not.toMatch(/we can't pay out to (pakistan|pk) yet\.?\s*$/im);
    // PayPal's verdict is authoritative — name it specifically.
    expect(out).toMatch(/PAYPAL.*can't pay/i);
    // Stripe's "unknown" must read as undetermined-and-worth-trying, not "no".
    expect(out).toMatch(/STRIPE.*(decides|decide).*connect/i);
    expect(out).toMatch(/worth trying/i);
    // Selling is not blocked either way.
    expect(out).toMatch(/still register, list, and sell/i);
    expect(out).toMatch(/escrow/i);
  });

  it("prefers the country name over the bare code when Intl can resolve it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      country: "PK",
      supported: false,
      waitlist_available: true,
      rails: [
        { provider: "stripe", supported: false, verdict: "unknown", requirements: [] },
        { provider: "paypal", supported: false, verdict: "unsupported", requirements: [] },
      ],
    })));
    const out = textOf(await captureTools().firestarter_payout_eligibility({ country: "PK" }));

    expect(out).toContain("Pakistan");
  });

  it("asserts definitive inability only once every rail is unsupported (no rail left unknown)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      country: "XX",
      supported: false,
      waitlist_available: true,
      rails: [
        { provider: "stripe", supported: false, verdict: "unsupported", requirements: [] },
        { provider: "paypal", supported: false, verdict: "unsupported", requirements: [] },
      ],
    })));
    const out = textOf(await captureTools().firestarter_payout_eligibility({ country: "XX" }));

    expect(out).toMatch(/can't pay out to/i);
    expect(out).not.toMatch(/worth trying/i);
  });

  it("mentions a still-unknown rail alongside a confirmed one, instead of dropping it (mixed: PayPal supported, Stripe unknown)", async () => {
    // The whole point of carrying "unknown" through the API, the tool
    // description and unpaidCountryHeadline is that an agent gets to relay
    // "this one might work too" — dropping it here, in the one branch where a
    // rail already came back confirmed, would silently flatten it right back.
    vi.stubGlobal("fetch", vi.fn(async () => json({
      country: "MY",
      supported: true,
      waitlist_available: false,
      rails: [
        { provider: "stripe", supported: false, verdict: "unknown", requirements: [] },
        { provider: "paypal", supported: true, verdict: "supported", requirements: ["paypal_email"] },
      ],
    })));
    const out = textOf(await captureTools().firestarter_payout_eligibility({ country: "MY" }));

    expect(out).toContain("We can pay sellers in");
    expect(out).toMatch(/PAYPAL/);
    // The unknown rail is named too, not silently omitted.
    expect(out).toMatch(/STRIPE/);
    expect(out).toMatch(/worth trying/i);
    // Never assert it's ruled OUT — that's the false claim on the other side.
    expect(out).not.toMatch(/STRIPE.*can't pay/i);
  });

  it("surfaces a friendly message on a malformed country code (INVALID_COUNTRY)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: "INVALID_COUNTRY", error: "country must be an ISO 3166-1 alpha-2 code" }, 400)));
    const res = await captureTools().firestarter_payout_eligibility({ country: "XX" });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/two-letter ISO country code/i);
  });
});
