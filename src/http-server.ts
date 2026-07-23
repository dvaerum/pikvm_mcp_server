/**
 * Streamable HTTP transport for the MCP server — the modern, spec-current
 * transport that superseded the old HTTP+SSE transport.
 *
 * Stateful by design: each MCP session gets its own StreamableHTTPServerTransport
 * and its own Server (minted via the injected factory), keyed by the
 * Mcp-Session-Id header. Concurrent clients therefore never collide on JSON-RPC
 * request ids. A session is created by an `initialize` POST (which mints the id)
 * and torn down when its transport closes or the client sends DELETE /mcp.
 *
 * Authentication (opts.authorize, from `--security yes|kvmd`): when set, every
 * /mcp request must be authorized — either it carries a valid HTTP Basic header
 * (checked by the injected authorizer: static creds for `yes`, a kvmd round-trip
 * for `kvmd`), or it carries the Mcp-Session-Id of a session opened with a valid
 * header (a validated `initialize` authorizes its session). Without an authorizer
 * (`--security no`) the endpoint is open. /health is always unauthenticated.
 *
 * Endpoints:
 *   POST   /mcp   client->server messages (initialize starts a session)
 *   GET    /mcp   server->client SSE stream for an existing session
 *   DELETE /mcp   terminate a session
 *   GET    /health   liveness + active session count
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type HeaderAuthorizer } from './auth.js';

export interface HttpServerHandle {
  /** The actual bound port (resolves the real port when started on port 0). */
  port: number;
  /** The MCP endpoint URL. */
  url: string;
  /** Stop accepting connections and close all active sessions. */
  close: () => Promise<void>;
}

/**
 * Start the Streamable HTTP server. `createServer` is called once per new MCP
 * session to mint a fresh Server wired to the same underlying device. When
 * `opts.authorize` is set, /mcp requires authentication.
 */
export function startHttpServer(
  createServer: () => Server,
  opts: { host: string; port: number; authorize?: HeaderAuthorizer },
): Promise<HttpServerHandle> {
  const app = express();
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const authorize = opts.authorize;

  // Gate every /mcp request when auth is enabled. A request passes if it has a
  // valid Basic header (per the configured authorizer — static creds or kvmd),
  // OR an Mcp-Session-Id for an already-authorized session (a session only exists
  // because its initialize carried a valid header). The header check is async so
  // the kvmd backend can round-trip; it's awaited only when there's no session.
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!authorize) {
      next();
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      next();
      return;
    }
    const reject = (): void => {
      res.setHeader('WWW-Authenticate', 'Basic realm="pikvm-mcp", charset="UTF-8"');
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: valid credentials required' },
        id: null,
      });
    };
    authorize(req.headers.authorization).then(
      (ok) => (ok ? next() : reject()),
      () => reject(), // an authorizer error is a failed auth, never a crash
    );
  };
  app.use('/mcp', requireAuth);

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        // Only an initialize request (with no prior session id) may open a session.
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message:
                'Bad Request: provide a valid Mcp-Session-Id, or send an initialize request to start a session.',
            },
            id: null,
          });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport!);
          },
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transports.delete(sid);
        };
        await createServer().connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal server error: ${(err as Error).message}` },
          id: null,
        });
      }
    }
  });

  // GET (open the SSE stream) and DELETE (terminate) both act on an existing session.
  const handleExisting = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing Mcp-Session-Id');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', handleExisting);
  app.delete('/mcp', handleExisting);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      sessions: transports.size,
      secured: Boolean(authorize),
    });
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(opts.port, opts.host, () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        url: `http://${opts.host}:${port}/mcp`,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const t of transports.values()) void t.close();
            transports.clear();
            httpServer.close(() => resolveClose());
          }),
      });
    });
  });
}
