/**
 * MCP WebSocket transport (US-10.1).
 *
 * Complements the stdio (server.ts) and Streamable-HTTP (route.ts) transports
 * with a WebSocket one, so an MCP client can connect over `ws(s)://…/mcp`.
 * Each WebSocket text frame carries exactly one JSON-RPC message.
 *
 * Auth mirrors the HTTP transport: the caller supplies their Firestarter API
 * key (`Authorization: Bearer <key>`, or an `?apiKey=`/`?api_key=` query param
 * for browser clients that cannot set headers). The key is passed straight
 * through to the upstream API, which authenticates every tool call.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer, mcpApiBase } from "./route.js";
import { logger } from "../lib/logger.js";

/** 1 MB per frame — matches the API's global body limit. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Paths that accept an MCP WebSocket upgrade. */
export function isMcpWebSocketPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/mcp/ws";
}

/**
 * An MCP `Transport` backed by a single `ws` WebSocket connection. One JSON-RPC
 * message per text frame; binary frames and oversized frames are rejected.
 */
export class WebSocketMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId: string;

  private readonly ws: WebSocket;
  private started = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.sessionId = crypto.randomUUID();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        if (isBinary) throw new Error("binary WebSocket frames are not supported");
        // `ws` may deliver a Buffer, an ArrayBuffer, or an array of Buffer
        // fragments depending on how the frame arrived. Normalize to a single
        // Buffer first so the size check counts bytes (not array length) and the
        // decode never stringifies an array. For fragmented frames, sum the byte
        // lengths BEFORE concatenating so a flood of fragments can't force a large
        // allocation ahead of the size guard.
        if (Array.isArray(data)) {
          let total = 0;
          for (const part of data) total += part.length;
          if (total > MAX_MESSAGE_BYTES) throw new Error("MCP message exceeds 1 MB");
        }
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        if (buf.length > MAX_MESSAGE_BYTES) throw new Error("MCP message exceeds 1 MB");
        const msg = JSON.parse(buf.toString("utf8")) as JSONRPCMessage;
        this.onmessage?.(msg);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.ws.on("close", () => this.onclose?.());
    this.ws.on("error", (err: Error) => this.onerror?.(err));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.send(JSON.stringify(message), (err?: Error) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

/** Bearer header, or an `?apiKey=`/`?api_key=` query param for browser clients. */
export function extractWsApiKey(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const parts = auth.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer" && parts[1]) return parts[1];
  }
  const q = url.searchParams.get("apiKey") || url.searchParams.get("api_key");
  return q && q.length > 0 ? q : null;
}

/** Dedicated WS server for MCP upgrades (kept separate from the exec-stream one). */
export const mcpWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

/**
 * Authenticate an MCP WebSocket upgrade, then wire the socket to a fresh
 * McpServer instance. Rejects (401) when no API key is presented.
 */
export function handleMcpWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer = mcpWebSocketServer,
): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const apiKey = extractWsApiKey(req, url);
  if (!apiKey) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const transport = new WebSocketMcpTransport(ws);
    const server = buildMcpServer(apiKey, mcpApiBase());
    server.connect(transport).catch((err) => {
      logger.error("MCP WebSocket connect failed", { error: (err as Error).message });
      ws.close();
    });
    logger.info("MCP WebSocket connected", { sessionId: transport.sessionId });
  });
}
