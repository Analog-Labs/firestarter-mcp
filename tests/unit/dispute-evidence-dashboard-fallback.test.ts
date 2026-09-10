/**
 * commerce#1148: "Failed to upload image to the dispute message from Claude."
 *
 * A buyer attached a photo in chat, the agent called firestarter_upload_image
 * to put it on the dispute thread, and the call errored. Whatever the immediate
 * cause, what the agent was handed next mattered: the only non-widget path this
 * tool named for a dispute was "take a public photo URL from them" — which is
 * exactly the dead end commerce#1007 was filed about. A photo attached in chat
 * has no URL, and asking a buyer to go host one is what made evidence
 * unattachable in the first place.
 *
 * The LISTING drop zone has always had a real fallback ("send them to the
 * dashboard uploader") because a host that renders no widget leaves the user
 * with nothing else. The dispute path never got one, even though both
 * dashboards accept `?dispute=<id>` and open a thread with a genuine
 * `<input type="file">` — apps/web Dashboard.tsx (uploadDisputeImage) and
 * SellerDashboard.tsx (uploadSellerDisputeImage). The path existed; it was
 * never named.
 *
 * These tests pin that it is named, on the drop zone and on the error paths —
 * the error path being the moment the reporter actually hit.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { registerTools } from "../../src/mcp/tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureTool(name: string, bearer = "fs_test_disputefallback"): (args: any) => Promise<any> {
  let handler: ((args: any) => Promise<any>) | null = null;
  const stub = {
    tool: (toolName: string, _desc: string, _schema: any, _ann: any, cb: any) => {
      if (toolName === name) handler = cb;
    },
  } as any;
  registerTools(stub, bearer, "http://api.local");
  if (!handler) throw new Error(`tool ${name} was not registered`);
  return handler;
}

const text = (res: any) => res.content.map((b: any) => b.text ?? "").join("\n");

/** Every request fails — the reporter's case, whatever the underlying cause. */
function stubFailingApi() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false, status: 400, json: async () => ({ error: "image data was truncated", code: "INVALID_IMAGE" }),
  })));
}

describe("dispute evidence names the dashboard, not a hosted-URL dead end (#1148)", () => {
  it("the dispute drop zone points at the buyer's dispute thread", async () => {
    const res = await captureTool("firestarter_upload_image")({ dispute_id: "disp_abc123" });
    const out = text(res);

    expect(out).toContain("https://firestarter.network/dashboard?dispute=disp_abc123");
    // The file picker is the point — say what they will find there.
    expect(out).toMatch(/file picker/i);
  });

  it("sends a SELLER to the seller dashboard, not the buyer one", async () => {
    const out = text(await captureTool("firestarter_upload_image")({
      dispute_id: "disp_seller1", dispute_side: "seller",
    }));

    expect(out).toContain("https://firestarter.network/seller?dispute=disp_seller1");
    expect(out).not.toContain("/dashboard?dispute=");
  });

  it("names the dashboard when the upload itself fails", async () => {
    // THE regression test. This is the moment in #1148: the tool errored and
    // the agent needed somewhere to go that was not "send me a hosted link".
    stubFailingApi();

    const res = await captureTool("firestarter_upload_image")({
      dispute_id: "disp_fail1",
      image_base64: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==",
    });
    const out = text(res);

    expect(res.isError).toBe(true);
    expect(out).toContain("https://firestarter.network/dashboard?dispute=disp_fail1");
  });

  it("stays quiet about the dashboard when no dispute is involved", async () => {
    // A listing upload failure has its own fallbacks; a dispute link there
    // would be noise pointing at an unrelated screen.
    stubFailingApi();

    const out = text(await captureTool("firestarter_upload_image")({
      listing_id: "lst_1",
      image_base64: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==",
    }));

    expect(out).not.toContain("?dispute=");
  });

  it("still tells the agent never to rebuild the photo as base64", async () => {
    // The dashboard is the fallback for a human to use, not a licence to go
    // back to the path that truncates.
    const out = text(await captureTool("firestarter_upload_image")({ dispute_id: "disp_abc123" }));
    expect(out).toMatch(/never re-encode a chat-attached photo as base64/i);
  });
});
