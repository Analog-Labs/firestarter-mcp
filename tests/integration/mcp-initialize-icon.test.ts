/**
 * The icon reaches the wire, not just the constant.
 *
 * ChatGPT renders a connector from what `initialize` returns. This drives the
 * real HTTP route so a regression in how the identity is passed to McpServer —
 * not just a change to the constant — fails the build.
 */
import { describe, it, expect } from "vitest";
// The advertised version must track the release, not a literal — a hardcoded
// string here broke on the first bump after this test landed (2.4.0 → 2.5.1).
import { version as pkgVersion } from "../../package.json";

const { default: app } = await import("../../src/mcp/route.js");

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  },
};

async function initialize() {
  const res = await app.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer fs_test_icon_probe",
    },
    body: JSON.stringify(INIT),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe("initialize advertises the server icon", () => {
  it("I5: the handshake carries an absolute icon URL", async () => {
    const body = await initialize();
    expect(body, "a client with no icon renders a bare string").toContain(
      "https://firestarter.network/favicon.svg",
    );
  });

  it("I6: and the website, so the connector can link back", async () => {
    expect(await initialize()).toContain("https://firestarter.network");
  });

  it("I7: name and version still travel — identity is added, not replaced", async () => {
    const body = await initialize();
    expect(body).toContain("firestarter");
    expect(body).toContain(pkgVersion);
  });
});
