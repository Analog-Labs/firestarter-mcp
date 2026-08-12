/**
 * "Still working" is not "nothing found".
 *
 * An execution in `finding`/`quoting` has no options yet, so it fell into
 * firestarter_execute's empty-options branch and was reported to the buyer as a
 * bolded "**No matches — do you know where the buyer is?**", while the line
 * above it said `Status: finding`. Models follow the bold, action-shaped line,
 * so the agent told the buyer nothing was found while the search was live and
 * about to produce options. The buyer walks; the execution completes into the
 * void. That is the worst possible failure on the most important buyer moment.
 *
 * Two things put an execution in front of the agent while it is still running:
 * the 45s poll cap expiring on a slow cold search (prod server-side preview
 * latency already peaks near 27s BEFORE the agent -> MCP -> gateway -> API
 * hops), and pollExecution giving up on errors. Both land on the same branch,
 * which is what R1/R4 pin.
 *
 * pollExecution's `catch { break }` also used to fire on ANY error. Its comment
 * scoped it to "if /poll 404s (old API version)", but it caught everything — so
 * ONE transient 500 or timeout on the FIRST tick abandoned the whole wait (R2).
 * The 404 fallback it existed for still short-circuits (R3).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// pollExecution reads its interval from the environment at MODULE LOAD, so this
// must be set before the import is evaluated — hence the dynamic import. Keeps
// the retry tests at milliseconds instead of seconds.
process.env.FIRESTARTER_MCP_POLL_INTERVAL_MS = "1";
const { registerTools } = await import("../../src/mcp/tools.js");

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

const textOf = (res: any): string =>
  res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const STILL_FINDING = { id: "exec_slow", status: "finding", request_text: "espresso beans", options: [] };
const FOUND = {
  id: "exec_slow", status: "awaiting_approval", request_text: "espresso beans",
  options: [{
    id: "opt_1", product_title: "Single Origin", supplier: "Roaster",
    total: 19, subtotal: 17, shipping: 2, tax: 0, purchasable: true,
  }],
};

/** Wire POST /v1/executions + /poll + the full GET. `poll` decides each tick. */
function installFetch(poll: () => Response, full: any) {
  const mock = vi.fn(async (url: any, init?: any) => {
    const method = init?.method || "GET";
    if (method === "POST" && String(url).endsWith("/v1/executions")) {
      return json({ id: "exec_slow", status: "finding" }, 201);
    }
    if (String(url).includes("/poll")) return poll();
    if (method === "GET" && String(url).includes("/v1/executions/")) return json(full);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The two forms of the regression, both bolded or leading a sentence. */
const CLAIMS_NO_RESULTS = /\*\*No matches|No matches yet/i;

function expectStillSearching(text: string) {
  expect(text).toMatch(/Still searching/i);
  // The exact regression: never present a live search as an empty result.
  expect(text).not.toMatch(CLAIMS_NO_RESULTS);
}

describe("firestarter_execute distinguishes 'still running' from 'no results'", () => {
  it("R1: an execution handed back while still `finding` reads as still searching", () => {
    // Reached whenever polling stops before the work does — the 45s cap, or the
    // give-up paths below.
    installFetch(() => json({ error: "gone" }, 404), STILL_FINDING);
    return captureTools().firestarter_execute({ request: "espresso beans" }).then((res) => {
      const text = textOf(res);
      expectStillSearching(text);
      expect(text).toContain("firestarter_status");
      expect(text).toContain("exec_slow");
    });
  });

  it("R2: one transient /poll error no longer abandons the search", async () => {
    let polls = 0;
    installFetch(() => {
      polls++;
      // First tick blips (a 500, a DNS hiccup, a 12s timeout). This used to
      // break the loop outright on the very first attempt.
      if (polls === 1) return json({ error: "upstream boom" }, 500);
      return json({ status: "awaiting_approval", has_options: true });
    }, FOUND);

    const text = textOf(await captureTools().firestarter_execute({ request: "espresso beans" }));
    expect(polls).toBeGreaterThan(1);
    // It recovered and returned the real result rather than a false negative.
    expect(text).toContain("Single Origin");
    expect(text).not.toMatch(CLAIMS_NO_RESULTS);
    expect(text).not.toMatch(/Still searching/i);
  });

  it("R3: a genuine 404 from /poll stops immediately (the old-API fallback)", async () => {
    let polls = 0;
    installFetch(() => { polls++; return json({ error: "not found" }, 404); }, FOUND);

    const text = textOf(await captureTools().firestarter_execute({ request: "espresso beans" }));
    // Retrying a route that does not exist is pointless.
    expect(polls).toBe(1);
    expect(text).toContain("Single Origin");
  });

  it("R4: persistent /poll errors give up bounded, and report still-searching", async () => {
    let polls = 0;
    installFetch(() => { polls++; return json({ error: "upstream down" }, 503); }, STILL_FINDING);

    const text = textOf(await captureTools().firestarter_execute({ request: "espresso beans" }));
    // Bounded by POLL_MAX_CONSECUTIVE_ERRORS rather than hammering for 45s...
    expect(polls).toBe(3);
    // ...and the buyer is told the truth about what happened.
    expectStillSearching(text);
  });

  it("a genuinely empty terminal result STILL says no matches", async () => {
    installFetch(
      () => json({ status: "failed", has_options: false }),
      { id: "exec_slow", status: "failed", request_text: "unobtainium", options: [] },
    );

    const text = textOf(await captureTools().firestarter_execute({ request: "unobtainium" }));
    // The fix must not swallow the real empty state.
    expect(text).toMatch(CLAIMS_NO_RESULTS);
    expect(text).not.toMatch(/Still searching/i);
  });
});
