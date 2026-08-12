/**
 * firestarter_listings (list view) — inline thumbnails.
 *
 * #611 embedded photos in the DETAIL path only, so a seller asking "show my
 * products" got text and no pictures. This pins that the list view embeds them
 * too, and that the cap holds: inlineImageBlocks tops out at MAX_EMBED_IMAGES,
 * which is what keeps a long catalog from blowing the 1MB tool-result cap.
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

// Smallest bytes that pass the server-side magic-byte check for a JPEG.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function listingsPayload(count: number) {
  return {
    listings: Array.from({ length: count }, (_, i) => ({
      id: `lst_${i}`,
      product_name: `Product ${i}`,
      status: "active",
      current_price: 10 + i,
      images: [`https://img.test/${i}.jpg`],
    })),
  };
}

function installFetch(count: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      if (/^https:\/\/img\.test\//.test(u)) {
        return new Response(JPEG, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(JPEG.length) },
        });
      }
      return new Response(JSON.stringify(listingsPayload(count)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_listings — list view thumbnails", () => {
  it("embeds the first photo of each listing as an image block", async () => {
    installFetch(2);
    const tools = captureTools();
    const res = await tools.firestarter_listings({});
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Your listings (2)");
    const images = res.content.filter((c: any) => c.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0].mimeType).toBe("image/jpeg");
  });

  it("caps the embedded images so a long catalog can't blow the result size cap", async () => {
    installFetch(12);
    const tools = captureTools();
    const res = await tools.firestarter_listings({});
    const images = res.content.filter((c: any) => c.type === "image");
    expect(images.length).toBeLessThanOrEqual(3); // MAX_EMBED_IMAGES
    // The text still lists every product; only the pictures are capped.
    expect(res.content[0].text).toContain("Your listings (12)");
  });

  it("returns text alone when no listing has a photo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ listings: [{ id: "lst_0", product_name: "P", status: "active", current_price: 5, images: [] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const tools = captureTools();
    const res = await tools.firestarter_listings({});
    expect(res.content.filter((c: any) => c.type === "image")).toHaveLength(0);
  });
});
