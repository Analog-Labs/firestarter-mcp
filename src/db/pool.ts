/**
 * Database pool — not available in the standalone package.
 *
 * The MCP server reads listing image blobs straight from Postgres as an
 * optimization when it runs inside the Firestarter API. That import is
 * DYNAMIC and its failure is caught, so the standalone server simply fetches
 * images over HTTP instead. See readBlobDirect in src/mcp/tools.ts.
 */
export const pool = {
  async query(_sql: string, _params?: unknown[]): Promise<{ rows: any[] }> {
    throw new Error("direct database access is only available when running inside the Firestarter API");
  },
};
