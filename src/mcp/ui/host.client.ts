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
 * would leave the widget rendering nothing at all. It implements the same three
 * verbs and is otherwise invisible to the rest of the code.
 *
 * Excluded from the Node build (`*.client.ts`) — it touches DOM and host
 * globals. Everything it decides lives in the pure modules it imports.
 */
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { reportsOwnSize, sheetBottomInset } from "./safe-area.js";
import { WIDGET_SURFACE_KEY, WIDGET_SURFACE } from "./widget-call.js";

/** What the view needs from whichever host it woke up inside. */
export interface Host {
  /** Navigate OUT of the sandbox. A bare <a target="_blank"> is blocked on any
   *  host that omits allow-popups, which turns every card into a dead link. */
  openLink(url: string): void;
  /** Call one of our own tools and hand back its structuredContent, or null if
   *  the host refuses, the call fails, or it returns nothing usable. Never
   *  throws: everything it feeds is optional enrichment. */
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Ask for the whole surface (the detail view) or give it back (the grid).
   *  Advisory — a host may decline, and the view stays usable either way. */
  setDisplayMode(mode: "fullscreen" | "inline"): void;
}

interface OpenAiBridge {
  toolOutput?: unknown;
  theme?: unknown;
  displayMode?: unknown;
  safeArea?: unknown;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  openExternal?: (params: { href: string }) => void;
  requestDisplayMode?: (params: { mode: string }) => void;
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
 * display mode we are in.
 *
 * The composer bug came from having neither. The detail view reserved 20px at
 * the bottom of a surface the host was drawing a message box over, so its last
 * section was unreachable — and inline, where nothing is covered, the same
 * reserve would just be dead space. One attribute and one variable let the CSS
 * get both cases right.
 */
function applyHostChrome(context: unknown, mode?: string): void {
  const el = document.documentElement;
  el.style.setProperty("--fs-safe-bottom", `${sheetBottomInset(context)}px`);
  const dm = mode ?? (context as { displayMode?: unknown } | undefined)?.displayMode;
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
    return {
      openLink: (url) => { void app.openLink({ url }).catch(() => { /* grid stays usable */ }); },
      callTool: async (name, args) => {
        try {
          const res = await app.callServerTool({
            name,
            arguments: args,
            // Tells the server this is the widget topping itself up, so it can
            // skip inlining base64 photos the modal never renders. Optional by
            // construction — a host that strips _meta only costs us bytes.
            _meta: { [WIDGET_SURFACE_KEY]: WIDGET_SURFACE },
          });
          return res?.isError ? null : structuredOf(res);
        } catch {
          return null;
        }
      },
      setDisplayMode: (mode) => {
        // Stamped optimistically: a host that grants the request may never send
        // a context change, and the reserve has to be in place before the view
        // paints, not a frame later. Then corrected from the host's ANSWER — a
        // denied fullscreen must not leave an inline frame reserving 160px of
        // dead space for chrome that is not there.
        applyHostChrome(app.getHostContext(), mode);
        // Silenced BEFORE the request, not after: the detail view repaints in
        // the same tick, and a resize notification racing the host's decision
        // about the panel is the whole failure being fixed here.
        syncSizeReporting(mode);
        void app.requestDisplayMode({ mode })
          .then((res) => {
            const granted = res?.mode ?? mode;
            applyHostChrome(app.getHostContext(), granted);
            syncSizeReporting(granted);
          })
          .catch(() => {
            applyHostChrome(app.getHostContext(), "inline");
            syncSizeReporting("inline");
          });
      },
    };
  } catch (err) {
    const bridge = openAiBridge();
    if (!bridge) {
      handlers.onError(err instanceof Error ? err.message : String(err));
      throw err;
    }
    // ChatGPT surface without the standard bridge. Same three verbs.
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
      setDisplayMode: (mode) => {
        applyHostChrome(openAiBridge(), mode);
        bridge.requestDisplayMode?.({ mode });
      },
    };
  }
}
