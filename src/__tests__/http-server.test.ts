/**
 * TDD for the Streamable HTTP transport (src/http-server.ts). Boots a real
 * server on an ephemeral port with a stub MCP Server, then drives the modern
 * transport end-to-end: initialize handshake issues an Mcp-Session-Id, the
 * session serves tools/list, and a non-initialize POST without a session id is
 * rejected. Uses a fake server factory so no PiKVM device is needed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer, type HttpServerHandle } from '../http-server.js';

function fakeCreateServer(): Server {
  const s = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', description: 'test tool', inputSchema: { type: 'object' } }],
  }));
  return s;
}

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

/** Parse a JSON-RPC response whether the transport replied with JSON or SSE. */
async function readRpc(r: Response): Promise<any> {
  const text = await r.text();
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

let handle: HttpServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('startHttpServer (Streamable HTTP transport)', () => {
  it('serves /health', async () => {
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('initialize -> session id -> tools/list; unknown session rejected', async () => {
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0 });

    // 1) initialize (no session id) -> 200 + Mcp-Session-Id
    const r1 = await fetch(handle.url, { method: 'POST', headers: HEADERS, body: JSON.stringify(INIT) });
    expect(r1.status).toBe(200);
    const sid = r1.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    const init = await readRpc(r1);
    expect(init.result.protocolVersion).toBeTruthy();

    // 2) complete the handshake with the initialized notification (202, no body)
    const notif = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, 'mcp-session-id': sid! },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notif.status).toBe(202);
    await notif.text();

    // 3) tools/list on the session returns our stub tool
    const r2 = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, 'mcp-session-id': sid! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(r2.status).toBe(200);
    const list = await readRpc(r2);
    expect(list.result.tools.map((t: any) => t.name)).toContain('ping');

    // 4) a non-initialize POST without a session id is a 400
    const r3 = await fetch(handle.url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(r3.status).toBe(400);
    await r3.text();
  });
});
