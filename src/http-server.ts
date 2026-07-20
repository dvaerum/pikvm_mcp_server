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
 * Endpoints:
 *   POST   /mcp   client->server messages (initialize starts a session)
 *   GET    /mcp   server->client SSE stream for an existing session
 *   DELETE /mcp   terminate a session
 *   GET    /health   liveness + active session count
 */
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

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
 * session to mint a fresh Server wired to the same underlying device.
 */
export function startHttpServer(
  createServer: () => Server,
  opts: { host: string; port: number },
): Promise<HttpServerHandle> {
  const app = express();
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();

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
    res.json({ status: 'ok', transport: 'streamable-http', sessions: transports.size });
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
