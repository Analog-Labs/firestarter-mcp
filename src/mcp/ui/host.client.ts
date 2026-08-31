/**
 * The host bridge, behind one small interface.
 *
 * ChatGPT and Claude Desktop both implement the same MCP Apps standard — the
 * `ui://` resource, the `text/html;profile=mcp-app` mime type and the
 * postMessage bridge — so the ext-apps `App` client is the ONE path that serves
 * both, and there is no second build of this view.
 *
 * `window.openai` is kept only as a fallback for a ChatGPT surface that has not
 * finished adopting the standard bridge: without it, a failed handshake there
 * would leave the widget rendering nothing at all. It implements the same two
 * verbs and is otherwise invisible to the rest of the code.
 *
 * Excluded from the Node build (`*.client.ts`) — it touches DOM and host
 * globals. Everything it decides lives in the pure modules it imports.
 */
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { reportsOwnSize, sheetBottomInset } from "./safe-area.js";
import { WIDGET_SURFACE_KEY, WIDGET_SURFACE } from "./widget-call.js";

/**
 * What the view needs from whichever host it woke up inside.
 *
 * Deliberately no way to ask for a display mode. The detail view used to
 * request one on every card click (a docked panel where offered, fullscreen
 * otherwise), and on Claude Desktop that opened the product a second time as a
 * modal over the chat — the same view, framed as if it were a different page.
 * Everything renders in the inline frame now; if a host moves the widget
 * fullscreen through its own controls, the context change below still tells
 * the stylesheet.
 */
export interface Host {
  /** Navigate OUT of the sandbox. A bare <a target="_blank"> is blocked on any
   *  host that omits allow-popups, which turns every card into a dead link. */
  openLink(url: string): void;
  /** Call one of our own tools and hand back its structuredContent, or null if
   *  the host refuses, the call fails, or it returns nothing usable. Never
   *  throws: everything it feeds is optional enrichment. */
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /**
   * Call one of our own tools and keep the WHOLE outcome: success flag, the
   * text content, and structuredContent. The uploader needs all three — a
   * failed listing update carries its reason in the text (e.g. a verification
   * gate), and swallowing it into `null` would leave the seller staring at a
   * drop zone that silently did nothing. Returns null only when the bridge
   * itself is unavailable or threw (host refused the call). Never throws.
   */
  callToolFull(name: string, args: Record<string, unknown>): Promise<{
    ok: boolean;
    text: string;
    structured: Record<string, unknown> | null;
  } | null>;
  /**
   * Tell the MODEL what just happened inside the widget (an upload finishing,
   * an activation failing) without producing a user-visible message. The next
   * turn's context includes it, so the agent narrates reality instead of
   * guessing. Best-effort: a host without the verb loses the note and nothing
   * else — the uploader's own status line still shows the outcome.
   */
  tellModel(text: string): Promise<void>;
}

interface OpenAiBridge {
  toolOutput?: unknown;
  theme?: unknown;
  displayMode?: unknown;
  safeArea?: unknown;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  openExternal?: (params: { href: string }) => void;
}

function openAiBridge(): OpenAiBridge | null {
  const w = window as unknown as { openai?: OpenAiBridge };
  return w.openai && typeof w.openai === "object" ? w.openai : null;
}

/** Adopt the HOST's theme, not the OS's: a Desktop user can run the app dark on
 *  a light system. No theme from the host → no stamp → the stylesheet's
 *  prefers-color-scheme fallback keeps working. */
function adoptTheme(theme: unknown): void {
  if (theme === "dark" || theme === "light") applyDocumentTheme(theme);
}

/**
 * Publish what the host is doing to the document, for the stylesheet to react
 * to: how much of the bottom it is covering with its own chrome, and which
 * display mode it has put us in.
 *
 * The composer bug came from having neither. A fullscreen detail view reserved
 * 20px at the bottom of a surface the host was drawing a message box over, so
 * its last section was unreachable — and inline, where nothing is covered, the
 * same reserve would just be dead space. One attribute and one variable let
 * the CSS get both cases right. The widget never asks for a mode itself any
 * more, so this only ever reflects a change the host made on its own.
 */
function applyHostChrome(context: unknown): void {
  const el = document.documentElement;
  el.style.setProperty("--fs-safe-bottom", `${sheetBottomInset(context)}px`);
  const dm = (context as { displayMode?: unknown } | undefined)?.displayMode;
  if (dm === "fullscreen" || dm === "pip" || dm === "inline") el.setAttribute("data-display", String(dm));
}

/** structuredContent out of whatever shape a host returns a tool result in. */
function structuredOf(result: unknown): Record<string, unknown> | null {
  const sc = (result as { structuredContent?: unknown } | null)?.structuredContent;
  return sc && typeof sc === "object" ? (sc as Record<string, unknown>) : null;
}

export async function connectHost(handlers: {
  onResult: (structuredContent: Record<string, unknown>) => void;
  onError: (message: string) => void;
}): Promise<Host> {
  // autoResize OFF, and the size notifications driven by hand below. The
  // library's automatic version runs for the whole session, including in
  // fullscreen — where the host owns the surface and our height is noise.
  const app = new App({ name: "firestarter-shopping", version: "0.3.0" }, undefined, { autoResize: false });
  let stopSizeReports: (() => void) | null = null;

  /** Report our content height only while the host is sizing the frame to it. */
  const syncSizeReporting = (mode: string | undefined) => {
    if (reportsOwnSize(mode)) {
      if (!stopSizeReports) stopSizeReports = app.setupSizeChangedNotifications();
    } else if (stopSizeReports) {
      stopSizeReports();
      stopSizeReports = null;
    }
  };

  // Registered BEFORE connect: the host may send the tool result the moment the
  // handshake completes, and a handler attached afterwards misses it.
  app.ontoolresult = (params) => {
    const sc = (params?.structuredContent ?? {}) as Record<string, unknown>;
    handlers.onResult(sc);
  };
  app.addEventListener("hostcontextchanged", (ctx: any) => {
    adoptTheme(ctx?.theme);
    applyHostChrome(ctx);
    if (typeof ctx?.displayMode === "string") syncSizeReporting(ctx.displayMode);
  });

  try {
    await app.connect();
    const ctx = app.getHostContext() as any;
    adoptTheme(ctx?.theme);
    applyHostChrome(ctx);
    syncSizeReporting(ctx?.displayMode);
    const callServer = async (name: string, args: Record<string, unknown>) => {
      return app.callServerTool({
        name,
        arguments: args,
        // Tells the server this is the widget topping itself up, so it can
        // skip inlining base64 photos the view never renders. Optional by
        // construction — a host that strips _meta only costs us bytes.
        _meta: { [WIDGET_SURFACE_KEY]: WIDGET_SURFACE },
      });
    };
    return {
      openLink: (url) => { void app.openLink({ url }).catch(() => { /* grid stays usable */ }); },
      callTool: async (name, args) => {
        try {
          const res = await callServer(name, args);
          return res?.isError ? null : structuredOf(res);
        } catch {
          return null;
        }
      },
      callToolFull: async (name, args) => {
        try {
          const res = await callServer(name, args);
          const text = (Array.isArray(res?.content) ? res.content : [])
            .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
            .filter(Boolean)
            .join(" ");
          return { ok: !res?.isError, text, structured: structuredOf(res) };
        } catch {
          return null;
        }
      },
      tellModel: async (text) => {
        try {
          await app.updateModelContext({ content: [{ type: "text", text }] });
        } catch { /* a host without the verb just loses the note */ }
      },
    };
  } catch (err) {
    const bridge = openAiBridge();
    if (!bridge) {
      handlers.onError(err instanceof Error ? err.message : String(err));
      throw err;
    }
    // ChatGPT surface without the standard bridge. Same two verbs.
    adoptTheme(bridge.theme);
    applyHostChrome(bridge);
    window.addEventListener("openai:set_globals", () => {
      adoptTheme(openAiBridge()?.theme);
      applyHostChrome(openAiBridge());
      const out = openAiBridge()?.toolOutput;
      if (out && typeof out === "object") handlers.onResult(out as Record<string, unknown>);
    });
    if (bridge.toolOutput && typeof bridge.toolOutput === "object") {
      handlers.onResult(bridge.toolOutput as Record<string, unknown>);
    }
    return {
      openLink: (url) => bridge.openExternal?.({ href: url }),
      callTool: async (name, args) => {
        try {
          return structuredOf(await bridge.callTool?.(name, args));
        } catch {
          return null;
        }
      },
      callToolFull: async (name, args) => {
        if (typeof bridge.callTool !== "function") return null;
        try {
          const res = (await bridge.callTool(name, args)) as { isError?: boolean; content?: unknown } | null;
          const text = (Array.isArray(res?.content) ? res.content : [])
            .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
            .filter(Boolean)
            .join(" ");
          return { ok: !res?.isError, text, structured: structuredOf(res) };
        } catch {
          return null;
        }
      },
      // The legacy window.openai bridge has no model-context verb; the
      // uploader's status line is the seller's record there.
      tellModel: async () => { /* no-op on the fallback bridge */ },
    };
  }
}
