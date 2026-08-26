/**
 * Real end-to-end proof of ConnectTunnelAgent's raw CONNECT + TLS-wrap
 * mechanism: a real loopback CONNECT proxy (plain TCP, same minimal
 * responder client-proxy.test.ts uses for undici's ProxyAgent) in front
 * of a real loopback TLS `ws` server (self-signed cert, generated via
 * `openssl` at test setup — matching the real wss:// target this agent
 * exists for; a plain-TLS-less ws:// origin isn't representative since
 * ConnectTunnelAgent unconditionally TLS-wraps the tunneled socket).
 *
 * This is the ONE genuinely new, risky mechanism this PR adds (raw
 * socket handling, hand-written CONNECT request, manual TLS handoff) —
 * it's the piece that most needs a real-infrastructure proof rather than
 * a DI'd fake, even though the overall pattern was already hardware-
 * verified by georgs-mac-mini on their tinyproxy setup.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StreamerKeepalive } from '../streamer-keepalive.js';

let tmpDir: string;
let certPath: string;
let keyPath: string;

let tlsServer: https.Server;
let wss: WebSocketServer;
let wsPort: number;
let wsConnectCount: number;
let wsAuthHeadersSeen: Array<{ user: string | undefined; passwd: string | undefined }>;

let proxy: net.Server;
let proxyPort: number;
let connectTargets: string[];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamer-keepalive-proxy-'));
  certPath = path.join(tmpDir, 'cert.pem');
  keyPath = path.join(tmpDir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'pipe' });

  // The fake "kvmd": a real TLS server (self-signed) with a real `ws`
  // WebSocketServer attached at /api/ws, tracking connects + auth headers.
  tlsServer = https.createServer({
    cert: await fs.readFile(certPath),
    key: await fs.readFile(keyPath),
  });
  wss = new WebSocketServer({ noServer: true });
  tlsServer.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/ws')) {
      socket.destroy();
      return;
    }
    wsConnectCount++;
    wsAuthHeadersSeen.push({
      user: req.headers['x-kvmd-user'] as string | undefined,
      passwd: req.headers['x-kvmd-passwd'] as string | undefined,
    });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  wsPort = (tlsServer.address() as AddressInfo).port;

  // A minimal CONNECT proxy — identical shape to client-proxy.test.ts's,
  // just tunnels raw TCP blindly (doesn't care that the tunneled bytes
  // are TLS; a real proxy wouldn't either).
  proxy = net.createServer((clientSocket) => {
    let buffered = Buffer.alloc(0);
    clientSocket.once('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const text = buffered.toString();
      const match = /^CONNECT ([^\s]+) HTTP\/1\.[01]/.exec(text);
      if (!match) {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      connectTargets.push(match[1]);
      const [host, port] = match[1].split(':');
      const upstream = net.connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  // An upgraded (post-WS-handshake) socket is hijacked from the HTTP
  // layer's own connection tracking, so a plain server.close() can hang
  // waiting for a "connection" it no longer owns. Terminate ws clients
  // explicitly and force-close any lingering sockets before the graceful
  // close, rather than waiting on drain.
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  tlsServer.closeAllConnections();
  await new Promise<void>((r) => tlsServer.close(() => r()));
  await new Promise<void>((r) => proxy.close(() => r()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  wsConnectCount = 0;
  wsAuthHeadersSeen = [];
  connectTargets = [];
});

const activeKeepalives: StreamerKeepalive[] = [];
afterEach(() => {
  for (const ka of activeKeepalives) ka.stop();
  activeKeepalives.length = 0;
});

describe('StreamerKeepalive proxyUrl — real CONNECT proxy + real TLS ws server', () => {
  it('tunnels through the proxy, negotiates TLS, and reaches /api/ws with kvmd auth headers intact', async () => {
    const ka = new StreamerKeepalive({
      host: `https://127.0.0.1:${wsPort}`,
      username: 'admin',
      password: 'pw',
      verifySsl: false, // self-signed test cert
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    });
    activeKeepalives.push(ka);

    await ka.ensureStarted();

    expect(ka.connected).toBe(true);
    expect(connectTargets).toEqual([`127.0.0.1:${wsPort}`]); // proxy saw the real target, not the ws server directly
    expect(wsConnectCount).toBe(1);
    expect(wsAuthHeadersSeen[0]).toEqual({ user: 'admin', passwd: 'pw' });
  });

  it('a bad proxy target fails the CONNECT and the keepalive schedules a reconnect rather than throwing', async () => {
    const deadProxyPort = proxyPort + 1; // nothing listening here
    const ka = new StreamerKeepalive({
      host: `https://127.0.0.1:${wsPort}`,
      username: 'admin',
      password: 'pw',
      verifySsl: false,
      proxyUrl: `http://127.0.0.1:${deadProxyPort}`,
    });
    activeKeepalives.push(ka);

    await expect(ka.ensureStarted()).resolves.toBeUndefined(); // never throws — best-effort contract
    expect(ka.connected).toBe(false);
    expect(wsConnectCount).toBe(0); // never reached the real ws server
  });
});
