/**
 * The Bearer of the HTTP request currently being served.
 *
 * MCP carries Authorization on EVERY request; the session id is a transport
 * handle and MUST NOT be used for auth. The tool and resource handlers, though,
 * are built once per session and close over the key the session was created
 * with. That is fine for a raw API key, which never changes, and wrong for an
 * OAuth access token, which is REPLACED on every refresh (hourly). This store
 * lets `makeApiRequest` send the Bearer the triggering request actually
 * presented: a refreshed token is what reaches the API, and a session id on
 * its own grants nothing to whoever presents it.
 *
 * Only the Streamable HTTP route enters the store. stdio has one key per
 * process and WebSocket one per connection; both fall through to the key the
 * server was built with.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const requestBearer = new AsyncLocalStorage<string>();

/** The Bearer to send upstream: the current request's, else the session's own. */
export function currentBearer(fallback: string): string {
  return requestBearer.getStore() ?? fallback;
}
