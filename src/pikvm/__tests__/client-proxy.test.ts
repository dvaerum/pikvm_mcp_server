/**
 * Proves PiKVMClient routes its outbound requests through the configured
 * proxy (undici ProxyAgent) when `proxyUrl` is set, and goes direct otherwise.
 *
 * This is the unit-level guard for the loopback-proxy workaround: on macOS the
 * server (spawned under tmux) is blocked from the PiKVM LAN, so it must reach
 * the device via a loopback CONNECT proxy running in a granted context. If a
 * refactor ever dropped the ProxyAgent wiring, device traffic would silently
 * stop tunnelling and break in exactly that environment — caught here.
 *
 * Everything is loopback (a local HTTP origin + a local CONNECT proxy), so the
 * test is deterministic and needs no PiKVM, no network, and no TLS cert
 * (undici ProxyAgent CONNECT-tunnels even plain-HTTP origins).
 */
import http from 'node:http';
import net from 'node:net';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PiKVMClient } from '../client.js';

let origin: http.Server;
let proxy: http.Server;
let originPort: number;
let proxyPort: number;
/** CONNECT targets the proxy tunnelled, e.g. "127.0.0.1:<originPort>". */
let connectTargets: string[];

beforeAll(async () => {
  // Origin stands in for the PiKVM: answers the /api/auth/check that
  // client.checkAuth() hits with 200.
  origin = http.createServer((req, res) => {
    if (req.url === '/api/auth/check') {
      res.writeHead(200).end('{}');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as AddressInfo).port;

  // Minimal HTTP CONNECT proxy: records the target and blindly tunnels TCP.
  proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, clientSocket, head) => {
    connectTargets.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => origin.close(() => r()));
  await new Promise<void>((r) => proxy.close(() => r()));
});

beforeEach(() => {
  connectTargets = [];
});

function makeClient(proxyUrl?: string): PiKVMClient {
  return new PiKVMClient({
    host: `http://127.0.0.1:${originPort}`,
    username: 'admin',
    password: 'pw',
    verifySsl: false,
    proxyUrl,
  });
}

describe('PiKVMClient proxy routing', () => {
  it('routes requests through the proxy when proxyUrl is set', async () => {
    const client = makeClient(`http://127.0.0.1:${proxyPort}`);
    await expect(client.checkAuth()).resolves.toBe(true);
    expect(connectTargets).toContain(`127.0.0.1:${originPort}`);
  });

  it('connects directly (no proxy) when proxyUrl is unset', async () => {
    const client = makeClient(undefined);
    await expect(client.checkAuth()).resolves.toBe(true);
    expect(connectTargets).toEqual([]);
  });
});
