/**
 * Optional platform adapters.
 *
 * The MCP server runs in two places: standalone (the desktop extension over
 * stdio, and anyone who installs this package), and embedded inside the
 * Firestarter API. Embedded, it can read listing image blobs straight from
 * Postgres instead of fetching them back over HTTP — a real optimization that
 * only exists when a database is actually in the process.
 *
 * Rather than let the standalone build carry a database driver it can never
 * use, the host injects what it has. Nothing here is required: every consumer
 * of these adapters treats absence as "optimization unavailable" and falls
 * back to the HTTP path, which is exactly how the stdio server behaves.
 */

export interface PlatformPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PlatformImageStore {
  /** Cached thumbnail for a stored blob id, or null when there isn't one. */
  getOrCreateThumb(id: string): Promise<{ contentType: string; bytes: Buffer } | null>;
}

export interface PlatformAdapters {
  pool?: PlatformPool;
  imageStore?: PlatformImageStore;
}

let adapters: PlatformAdapters = {};

/**
 * Register host capabilities. Call once at boot, before serving traffic.
 * Merges, so a host can register adapters independently.
 */
export function setPlatformAdapters(next: PlatformAdapters): void {
  adapters = { ...adapters, ...next };
}

/** What the host registered. Empty when running standalone. */
export function getPlatformAdapters(): PlatformAdapters {
  return adapters;
}

/** Test seam — drop every registered adapter. */
export function resetPlatformAdapters(): void {
  adapters = {};
}
