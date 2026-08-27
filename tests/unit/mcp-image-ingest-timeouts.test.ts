/**
 * commerce#849 — "image upload to listing times out on the marketplace
 * connector", and the seller burned their Claude quota retrying.
 *
 * The client gave up before the server was allowed to finish. Every tool that
 * makes the API ingest an image server-side inherits the plain 12s API budget,
 * while the API's own documented worst case for that same work is far longer:
 *
 *   apps/api/src/services/image-store.ts
 *     MAX_IMAGE_FETCH_REDIRECTS = 3   → up to 4 hops
 *     IMAGE_FETCH_TIMEOUT_MS    = 10_000  per hop   → 40s for ONE image
 *     INGEST_BUDGET_MS          = 20_000  whole listing, up to 12 photos
 *
 * This repository already learned the lesson once, on the dispute path:
 * ATTACHMENT_TIMEOUT_MS is 60s because "a 25s client timeout gave up while the
 * server was still succeeding — reported as a failed attach while the blob was
 * stored and referenced by nothing". firestarter_upload_image and the listing
 * writes do the identical server-side ingest and were never given the same
 * headroom.
 *
 * These pin the relationship rather than the numbers: whatever the budgets
 * become, a client must not abandon a request the server is still entitled to
 * be working on. Getting this wrong does not merely fail — it fails while the
 * work SUCCEEDS, so the seller sees an error over a listing that did change.
 */
import { describe, it, expect } from "vitest";
import {
  API_REQUEST_TIMEOUT_MS,
  UPLOAD_IMAGE_TIMEOUT_MS,
  LISTING_WRITE_TIMEOUT_MS,
  ATTACHMENT_TIMEOUT_MS,
  SERVER_SINGLE_IMAGE_INGEST_WORST_CASE_MS,
  SERVER_LISTING_INGEST_BUDGET_MS,
} from "../../src/mcp/tools.js";

describe("image-ingest client timeouts (commerce#849)", () => {
  it("upload_image outlasts the server's worst case for one image ingest", () => {
    // 4 redirect hops x 10s. Anything less abandons a request still running.
    expect(SERVER_SINGLE_IMAGE_INGEST_WORST_CASE_MS).toBe(40_000);
    expect(UPLOAD_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      SERVER_SINGLE_IMAGE_INGEST_WORST_CASE_MS,
    );
  });

  it("a listing write outlasts the server's whole-listing ingest budget", () => {
    // The listing write also does prohibited-item checks and activation gates
    // after the photos land, so it needs headroom ABOVE the ingest budget.
    expect(LISTING_WRITE_TIMEOUT_MS).toBeGreaterThan(SERVER_LISTING_INGEST_BUDGET_MS);
  });

  it("neither is left on the plain API budget — that is the #849 defect exactly", () => {
    expect(UPLOAD_IMAGE_TIMEOUT_MS).toBeGreaterThan(API_REQUEST_TIMEOUT_MS);
    expect(LISTING_WRITE_TIMEOUT_MS).toBeGreaterThan(API_REQUEST_TIMEOUT_MS);
  });

  it("upload_image gets at least what the dispute path already learned to need", () => {
    // Same server-side operation — one remote image, ingested. A tighter budget
    // here than on disputes would be the same bug wearing a different number.
    expect(UPLOAD_IMAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(ATTACHMENT_TIMEOUT_MS);
  });
});

/**
 * The other half of #849: what the agent is TOLD when an upload times out.
 *
 * toErrorMessage answers every timeout with "Firestarter API timed out. Please
 * retry in a few seconds." For an image upload that is the worst possible
 * advice — it is an instruction to repeat a request that will fail the same
 * way, and the reporter followed it until their Claude quota ran out. It is
 * also not necessarily true that nothing happened: this repo already documents
 * the server finishing an ingest after the client gave up.
 */
import { vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;
function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  const fakeServer = { tool: (name: string, ...rest: any[]) => { tools[name] = rest[rest.length - 1] as ToolHandler; } };
  registerTools(fakeServer as any, "fs_test_timeouts", "http://api.test");
  return tools;
}
function text(res: any): string {
  return (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("upload_image timeout guidance (commerce#849)", () => {
  function stubTimeout() {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }));
  }

  it("does not tell the agent to simply retry the same upload", async () => {
    stubTimeout();
    const t = text(await captureTools().firestarter_upload_image({
      image_base64: "data:image/jpeg;base64,/9j/4AAQ",
    }));
    expect(t).not.toMatch(/retry in a few seconds/i);
  });

  it("points a base64 upload at image_url, the form that does not time out", async () => {
    stubTimeout();
    const t = text(await captureTools().firestarter_upload_image({
      image_base64: "data:image/jpeg;base64,/9j/4AAQ",
    }));
    expect(t).toMatch(/image_url/);
  });

  it("warns that the upload may have completed server-side", async () => {
    stubTimeout();
    const t = text(await captureTools().firestarter_upload_image({
      image_url: "https://files.example/a.jpg",
    }));
    expect(t).toMatch(/may have|already/i);
  });
});
