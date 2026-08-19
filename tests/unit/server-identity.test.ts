/**
 * The initialize handshake must carry an icon.
 *
 * A client can only render what the server declares. Sending
 * { name, version } and nothing else is why the Firestarter icon was missing in
 * ChatGPT's connector list.
 */
import { describe, it, expect } from "vitest";
import { SERVER_IDENTITY, SERVER_ICONS } from "../../src/mcp/identity.js";

describe("server identity", () => {
  it("I1: every icon URL is absolute and https", () => {
    for (const icon of SERVER_ICONS) {
      expect(
        icon.src.startsWith("https://"),
        "a relative icon resolves against the CLIENT's origin, not ours",
      ).toBe(true);
      expect(() => new URL(icon.src)).not.toThrow();
    }
  });

  it("I2: each icon declares its mime type and sizes", () => {
    for (const icon of SERVER_ICONS) {
      expect(icon.mimeType, `${icon.src} needs a mimeType`).toBeTruthy();
      expect(icon.sizes.length).toBeGreaterThan(0);
    }
  });

  it("I3: a scalable icon is offered first", () => {
    expect(
      SERVER_ICONS[0].mimeType,
      "clients pick the first acceptable icon; a fixed-size raster blurs when scaled",
    ).toBe("image/svg+xml");
  });

  it("I4: the identity carries a website and description", () => {
    expect(SERVER_IDENTITY.websiteUrl).toMatch(/^https:\/\//);
    expect(SERVER_IDENTITY.description.length).toBeGreaterThan(20);
  });
});
