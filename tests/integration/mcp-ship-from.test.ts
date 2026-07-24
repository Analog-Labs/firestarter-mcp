/**
 * MCP ship-from location tools (firestarter_ship_from_locations /
 * firestarter_save_ship_from / firestarter_delete_ship_from) — the missing-tools
 * audit gap: the primary fulfillment location is the origin every shipping
 * quote is rated from, but sellers had no MCP surface to see or fix it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

type ToolHandler = (args: any) => Promise<any>;

function captureTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerTools({
    tool: (name: string, ...args: any[]) => {
      tools[name] = args[args.length - 1] as ToolHandler;
    },
  } as any, "fs_live_shipfrom", "http://api.test");
  return tools;
}

function response(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function textOf(result: any): string {
  return result.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("firestarter_ship_from_locations", () => {
  it("lists locations and flags the primary as the rate-quote origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      locations: [
        { id: "floc_a", is_primary: true, label: "BKK warehouse", street1: "1 Sukhumvit Rd", city: "Bangkok", country: "TH" },
        { id: "floc_b", is_primary: false, city: "Chiang Mai", country: "TH" },
      ],
    })));
    const text = textOf(await captureTools().firestarter_ship_from_locations({}));
    expect(text).toContain("floc_a");
    expect(text).toContain("primary — quotes ship from here");
    expect(text).toContain("BKK warehouse");
    expect(text).toContain("floc_b");
  });

  it("explains the platform-origin fallback when no locations exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ locations: [] })));
    const text = textOf(await captureTools().firestarter_ship_from_locations({}));
    expect(text).toContain("No ship-from locations yet");
    expect(text).toContain("firestarter_save_ship_from");
  });
});

describe("firestarter_save_ship_from", () => {
  it("creates a location and confirms the quote origin when primary", async () => {
    const fetchMock = vi.fn(async () => response({
      location: { id: "floc_new", is_primary: true, street1: "1 Sukhumvit Rd", city: "Bangkok", country: "TH" },
    }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const text = textOf(await captureTools().firestarter_save_ship_from({
      street1: "1 Sukhumvit Rd", city: "Bangkok", country: "TH", is_primary: true,
    }));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/sellers/locations");
    expect((fetchMock.mock.calls[0][1] as any).method).toBe("POST");
    expect(text).toContain("added");
    expect(text).toContain("Shipping quotes now rate from this origin.");
  });

  it("promote-only form (location_id + is_primary, no address) hits the /primary endpoint", async () => {
    const fetchMock = vi.fn(async () => response({ location: { id: "floc_b", is_primary: true, city: "Chiang Mai", country: "TH" } }));
    vi.stubGlobal("fetch", fetchMock);
    const text = textOf(await captureTools().firestarter_save_ship_from({ location_id: "floc_b", is_primary: true }));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/sellers/locations/floc_b/primary");
    expect(text).toContain("updated");
  });

  it("rejects a no-op call (location_id, no address, no is_primary) without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await captureTools().firestarter_save_ship_from({ location_id: "floc_b" });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns when the saved location is NOT the primary (quotes unchanged)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ location: { id: "floc_c", is_primary: false, city: "Phuket", country: "TH" } }, 201)));
    const text = textOf(await captureTools().firestarter_save_ship_from({ street1: "9 Beach Rd", city: "Phuket", country: "TH" }));
    expect(text).toContain("not the primary");
  });
});

describe("firestarter_delete_ship_from", () => {
  it("deletes by id and reminds about the primary origin", async () => {
    const fetchMock = vi.fn(async () => response({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const text = textOf(await captureTools().firestarter_delete_ship_from({ location_id: "floc_a" }));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/sellers/locations/floc_a");
    expect((fetchMock.mock.calls[0][1] as any).method).toBe("DELETE");
    expect(text).toContain("Deleted");
    expect(text).toContain("primary");
  });

  it("relays an API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Location not found" }, 404)));
    const result = await captureTools().firestarter_delete_ship_from({ location_id: "floc_missing" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Location not found");
  });
});
