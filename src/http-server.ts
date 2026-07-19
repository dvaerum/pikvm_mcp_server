/**
 * HTTP (Streamable HTTP) transport for the PiKVM MCP server.
 *
 * WHY this exists — macOS Local Network privacy (Tahoe / macOS 26) gates LAN
 * access per *binary identity*. A nix-built node has no app-bundle identity to
 * attribute a grant to, so any connect() to the PiKVM's LAN IP is refused with
 * an instant EHOSTUNREACH when the server is spawned under tmux OR a bare
 * launchd agent. Loopback (127.0.0.1) is NOT gated. So instead of Claude Code
 * spawning the server as a stdio child (inheriting its blocked network
 * context), the server runs once as a persistent process anchored to an
 * identity that DOES hold the LAN grant, and Claude connects to it over
 * loopback HTTP — which is always allowed. See docs/service/README.md.
 *
 * Transport: MCP Streamable HTTP, stateful. One MCP `Server` is created per
 * session (via the injected factory) so concurrent clients never collide on
 * request IDs; the heavy shared state (the PiKVMClient) lives in module globals
 * in index.ts and is safe to share across sessions.
 */
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpServerOptions {
  host: string;
  port: number;
  socketPath?: string;
  /** Path used for MCP requests. Default '/mcp'. */
  mcpPath?: string;
  /** Evict a session whose last request is older than this (ms). Guards against
   *  transports leaking when a client vanishes without a DELETE / onclose.
   *  Default 30 min; set 0 to disable the sweep. */
  idleTtlMs?: number;
}

/** Per-session transport registry, keyed by MCP session id. */
type SessionMap = Map<string, StreamableHTTPServerTransport>;

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/** Read and JSON-parse a request body. Returns undefined for an empty body
 *  (GET/DELETE) so the transport handles those without a parsed payload. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/**
 * Start the Streamable HTTP MCP server. Resolves once it is listening on all
 * requested endpoints (TCP, and the unix socket if configured).
 *
 * @param createMcpServer factory that returns a fresh, fully-wired MCP Server
 *                        (handlers registered) for a new session.
 * @param log             stderr logger (stdout is reserved on stdio; here it's
 *                        free, but we keep logging on stderr for consistency).
 */
export async function startHttpServer(
  createMcpServer: () => McpServer,
  opts: HttpServerOptions,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<{ close: () => Promise<void> }> {
  const mcpPath = opts.mcpPath ?? '/mcp';
  const transports: SessionMap = new Map();
  // Last-activity timestamp per session, so the sweep below can evict a
  // transport whose client disappeared without ever firing onclose.
  const lastSeen = new Map<string, number>();
  const idleTtlMs = opts.idleTtlMs ?? 30 * 60_000;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Lightweight liveness endpoint — lets a launcher / health check confirm
    // the server is up without speaking MCP.
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: transports.size }));
      return;
    }

    if (url.pathname !== mcpPath) {
      sendJsonError(res, 404, `Not found. MCP endpoint is ${mcpPath}.`);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Reuse an existing session's transport when the client supplies its id.
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        lastSeen.set(sessionId, Date.now());
        await transport.handleRequest(req, res, await readJsonBody(req));
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        // A POST without a known session must be an `initialize`. Anything
        // else is a client bug (stale session id, missing header).
        if (sessionId || !isInitializeRequest(body)) {
          sendJsonError(res, 400, 'Bad Request: no valid session id for a non-initialize request.');
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
            lastSeen.set(id, Date.now());
            log(`session initialized: ${id} (active=${transports.size})`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            lastSeen.delete(transport.sessionId);
            log(`session closed: ${transport.sessionId} (active=${transports.size})`);
          }
        };
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // GET (SSE stream) / DELETE (session teardown) require an existing session.
      sendJsonError(res, 400, 'Bad Request: unknown or missing mcp-session-id.');
    } catch (err) {
      log(`request error: ${(err as Error).message}`);
      if (!res.headersSent) {
        // A JSON.parse failure in readJsonBody is a malformed client body → 400,
        // not an internal server fault.
        const status = err instanceof SyntaxError ? 400 : 500;
        sendJsonError(res, status, status === 400 ? 'Bad Request: malformed JSON body.' : 'Internal server error.');
      }
    }
  };

  const httpServers: HttpServer[] = [];

  const listenOn = (server: HttpServer, target: { port: number; host: string } | { path: string }): Promise<void> =>
    new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      const cb = () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      };
      if ('path' in target) server.listen(target.path, cb);
      else server.listen(target.port, target.host, cb);
    });

  // TCP endpoint (loopback by default).
  const tcp = createHttpServer(handler);
  httpServers.push(tcp);
  await listenOn(tcp, { port: opts.port, host: opts.host });
  log(`Streamable HTTP MCP listening on http://${opts.host}:${opts.port}${mcpPath}`);

  // Optional unix-socket endpoint.
  if (opts.socketPath) {
    // A leftover socket file from an unclean shutdown blocks bind with EADDRINUSE.
    if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
    const unix = createHttpServer(handler);
    httpServers.push(unix);
    await listenOn(unix, { path: opts.socketPath });
    log(`Streamable HTTP MCP also listening on unix:${opts.socketPath}${mcpPath}`);
  }

  // Periodically evict idle sessions whose client vanished without a DELETE
  // (which would otherwise leak the transport for the life of the process).
  // unref() so this timer never keeps the process alive on its own.
  const sweep =
    idleTtlMs > 0
      ? setInterval(() => {
          const cutoff = Date.now() - idleTtlMs;
          for (const [id, transport] of transports) {
            if ((lastSeen.get(id) ?? 0) < cutoff) {
              log(`session evicted (idle > ${idleTtlMs}ms): ${id}`);
              transport.close().catch(() => {});
            }
          }
        }, Math.min(idleTtlMs, 60_000)).unref()
      : undefined;

  const close = async (): Promise<void> => {
    if (sweep) clearInterval(sweep);
    for (const transport of transports.values()) {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
    }
    await Promise.all(
      httpServers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    if (opts.socketPath && existsSync(opts.socketPath)) {
      try {
        unlinkSync(opts.socketPath);
      } catch {
        /* best-effort */
      }
    }
  };

  return { close };
}
