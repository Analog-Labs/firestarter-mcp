/**
 * How this server presents itself to a connecting client.
 *
 * The `initialize` handshake carries more than a name and a version: MCP's
 * Implementation schema also takes `icons`, `websiteUrl` and `description`, and
 * a client that has none of them has nothing to render but a string. That is
 * why the ChatGPT connector showed no Firestarter icon — we sent only
 * { name, version }.
 *
 * Kept in ONE place because this server is constructed twice — buildMcpServer()
 * for the HTTP and WebSocket transports, and server.ts for stdio. Those two
 * have already drifted once: the remote server reported 1.1.0 while the
 * installed extension reported 2.1.0, because only one of them was updated.
 *
 * `version` deliberately stays out of here: scripts/sync-version.mjs rewrites it
 * in each file by pattern on every release, and moving it would silently break
 * that.
 */

/**
 * Absolute, publicly fetchable icon URLs.
 *
 * They must be absolute: a client renders them from its own origin, so a
 * relative path resolves against ChatGPT, not against us. Both are served by
 * the marketing site and are already CDN-fronted.
 *
 * The SVG is listed first as the preferred form — it scales to whatever size a
 * client asks for, where the PNG is fixed at 98x98 and blurs when scaled up.
 */
/** Matches the SDK's Implementation icon shape (mutable — the SDK's type is not readonly). */
export interface ServerIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export const SERVER_ICONS: ServerIcon[] = [
  {
    src: "https://firestarter.network/favicon.svg",
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
  {
    src: "https://firestarter.network/flame-logo.png",
    mimeType: "image/png",
    sizes: ["98x98"],
  },
];

/** Identity fields shared by every transport. Spread alongside name and version. */
export const SERVER_IDENTITY: {
  websiteUrl: string;
  description: string;
  icons: ServerIcon[];
} = {
  websiteUrl: "https://firestarter.network",
  description:
    "AI-native commerce: search products, buy with approval, track orders, manage listings, and connect stores.",
  icons: SERVER_ICONS,
};
