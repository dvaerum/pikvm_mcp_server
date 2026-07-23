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
import { makeStaticAuthorizer } from '../auth.js';
import { makeKvmdAuthorizer } from '../kvmd-auth.js';

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

describe('startHttpServer auth (--security yes)', () => {
  const AUTH = { username: 'operator', password: 'hunter2' };
  const authorize = makeStaticAuthorizer(AUTH);
  const basic = (u: string, p: string) =>
    'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');

  it('leaves /health open even when auth is enabled', async () => {
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0, authorize });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).secured).toBe(true);
  });

  it('rejects initialize without credentials (401 + WWW-Authenticate)', async () => {
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0, authorize });
    const r = await fetch(handle.url, { method: 'POST', headers: HEADERS, body: JSON.stringify(INIT) });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/Basic/);
    await r.text();
  });

  it('rejects wrong credentials', async () => {
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0, authorize });
    const r = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, authorization: basic('operator', 'wrong') },
      body: JSON.stringify(INIT),
    });
    expect(r.status).toBe(401);
    await r.text();
  });

  it('a validated initialize authorizes the session for later requests without a header', async () => {
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0, authorize });

    // initialize WITH a valid header -> 200 + session id
    const r1 = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, authorization: basic('operator', 'hunter2') },
      body: JSON.stringify(INIT),
    });
    expect(r1.status).toBe(200);
    const sid = r1.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    await readRpc(r1);

    // subsequent request on the session, NO header -> allowed (session is authorized)
    const r2 = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, 'mcp-session-id': sid! },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(r2.status).toBe(202);
    await r2.text();
  });
});

describe('startHttpServer in-band login (--allow-tool-login)', () => {
  const AUTH = { username: 'operator', password: 'hunter2' };
  const authorize = makeStaticAuthorizer(AUTH);
  const basic = (u: string, p: string) =>
    'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');

  it('admits a header-less initialize (opens a pre-auth session) when tool-login is on', async () => {
    handle = await startHttpServer(fakeCreateServer, {
      host: '127.0.0.1',
      port: 0,
      authorize,
      allowToolLogin: true,
    });

    const r = await fetch(handle.url, { method: 'POST', headers: HEADERS, body: JSON.stringify(INIT) });
    expect(r.status).toBe(200); // header-less initialize allowed under tool-login
    expect(r.headers.get('mcp-session-id')).toBeTruthy();
    await readRpc(r);
  });

  it('still rejects a header-less NON-initialize POST (only login-gated initialize is admitted)', async () => {
    handle = await startHttpServer(fakeCreateServer, {
      host: '127.0.0.1',
      port: 0,
      authorize,
      allowToolLogin: true,
    });

    const r = await fetch(handle.url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(401);
    await r.text();
  });

  it('rejects a PRESENT-but-invalid header with 401 even under tool-login (no silent downgrade)', async () => {
    handle = await startHttpServer(fakeCreateServer, {
      host: '127.0.0.1',
      port: 0,
      authorize,
      allowToolLogin: true,
    });

    // Wrong creds on an initialize: the client attempted auth and failed → 401,
    // NOT a pre-auth session. Pre-auth 200 is reserved for the no-header case.
    const r = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, authorization: basic('operator', 'wrongpw') },
      body: JSON.stringify(INIT),
    });
    expect(r.status).toBe(401);
    await r.text();
  });

  it('a valid header still authorizes at connect even with tool-login on', async () => {
    handle = await startHttpServer(fakeCreateServer, {
      host: '127.0.0.1',
      port: 0,
      authorize,
      allowToolLogin: true,
    });

    const r = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, authorization: basic('operator', 'hunter2') },
      body: JSON.stringify(INIT),
    });
    expect(r.status).toBe(200);
    await readRpc(r);
  });

  it('is inert without an authorizer (--security no): header-less non-initialize still open, no gating', async () => {
    handle = await startHttpServer(fakeCreateServer, {
      host: '127.0.0.1',
      port: 0,
      allowToolLogin: true, // no authorize -> tool-login is a no-op
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect((await res.json()).secured).toBe(false);
  });
});

describe('startHttpServer auth (--security kvmd)', () => {
  const basic = (u: string, p: string) =>
    'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');

  // Stub kvmd's GET /api/auth/check: only pikvm-admin/pikvm-pass is valid.
  const calls: Array<{ username: string; password: string }> = [];
  const check = async (username: string, password: string): Promise<boolean> => {
    calls.push({ username, password });
    return username === 'pikvm-admin' && password === 'pikvm-pass';
  };

  it('authorizes /mcp using PiKVM (kvmd) credentials and caches the positive result', async () => {
    calls.length = 0;
    const authorize = makeKvmdAuthorizer(
      { host: 'https://pikvm.invalid', verifySsl: false },
      { check },
    );
    handle = await startHttpServer(fakeCreateServer, { host: '127.0.0.1', port: 0, authorize });

    // wrong PiKVM creds -> 401, kvmd consulted
    const bad = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, authorization: basic('pikvm-admin', 'nope') },
      body: JSON.stringify(INIT),
    });
    expect(bad.status).toBe(401);
    await bad.text();

    // correct PiKVM creds -> 200 + session id
    const ok = await fetch(handle.url, {
      method: 'POST',
      headers: { ...HEADERS, authorization: basic('pikvm-admin', 'pikvm-pass') },
      body: JSON.stringify(INIT),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('mcp-session-id')).toBeTruthy();
    await readRpc(ok);

    // kvmd was consulted for each header-bearing initialize (no session reuse across them).
    expect(calls).toEqual([
      { username: 'pikvm-admin', password: 'nope' },
      { username: 'pikvm-admin', password: 'pikvm-pass' },
    ]);
  });
});
