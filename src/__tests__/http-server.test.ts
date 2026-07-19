/**
 * Tests the custom routing/error logic in the Streamable-HTTP transport
 * (src/http-server.ts) — the parts we own, not the MCP SDK internals:
 *   - /health liveness endpoint
 *   - 404 for non-MCP paths
 *   - 400 for a non-initialize POST without a session
 *   - 400 (not 500) for a malformed JSON body
 *   - the initialize happy-path returns a session id (factory + connect wiring)
 *   - close() tears the listener down
 *
 * A minimal real MCP Server is used as the factory so the transport's
 * server.connect() path is exercised without the PiKVM dependency. All
 * loopback; no network.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../http-server.js';

function makeMcpServer(): Server {
  const server = new Server(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (close) await close();
  close = undefined;
});

async function start(): Promise<string> {
  // Port 0 → OS-assigned free port, so parallel test files never collide.
  const handle = await startHttpServer(
    makeMcpServer,
    { host: '127.0.0.1', port: 0, mcpPath: '/mcp' },
    () => {}, // silence logs
  );
  close = handle.close;
  return handle.baseUrl;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});
const MCP_ACCEPT = 'application/json, text/event-stream';

describe('startHttpServer routing', () => {
  it('serves /health', async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('404s a non-MCP path', async () => {
    const base = await start();
    const res = await fetch(`${base}/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('400s a non-initialize POST with no session', async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('400s (not 500s) a malformed JSON body', async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });

  it('initialize returns a session id', async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      body: INIT_BODY,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});
