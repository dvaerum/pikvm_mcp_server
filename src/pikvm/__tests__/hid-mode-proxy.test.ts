/**
 * Proves makeHttpHidModeEndpoint routes its outbound requests through the
 * configured proxy (undici ProxyAgent) when `proxyUrl` is set, and goes direct
 * otherwise — the hid-mode.ts mirror of client-proxy.test.ts.
 *
 * This is the unit-level guard for the off-box front-door design: on the iPad
 * node's Mac, macOS TCC blocks the server (spawned under tmux) from the LAN
 * entirely — a plain `Agent` request THROWS "fetch failed" outright, while
 * `curl` (a TCC-exempt system binary) succeeds on the identical request via a
 * loopback CONNECT proxy running in a granted context. If a refactor ever
 * dropped this ProxyAgent wiring, the /hidmode fetch would silently stop
 * tunnelling in exactly that environment — and because a fetch failure makes
 * the resolver fail CLOSED (moverAllowed:false), the mover would go dark, not
 * just "fail to derive". Caught here.
 *
 * Everything is loopback (a local HTTP origin + a local CONNECT proxy), so the
 * test is deterministic and needs no appliance, no network, and no TLS cert
 * (undici ProxyAgent CONNECT-tunnels even plain-HTTP origins) — same technique
 * as client-proxy.test.ts. Deliberately does NOT inject deps.get/deps.post:
 * those bypass dispatcher construction entirely, so they cannot exercise (or
 * catch a regression in) the proxy-vs-direct choice under test here.
 */
import http from 'node:http';
import net from 'node:net';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeHttpHidModeEndpoint } from '../hid-mode.js';

let origin: http.Server;
let proxy: http.Server;
let originPort: number;
let proxyPort: number;
/** CONNECT targets the proxy tunnelled, e.g. "127.0.0.1:<originPort>". */
let connectTargets: string[];

beforeAll(async () => {
  // Origin stands in for the appliance's /hidmode endpoint: answers GET with a
  // valid reading. Real HTTP, no auth needed for this proxy-routing concern.
  origin = http.createServer((req, res) => {
    if (req.url === '/hidmode') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ mode: 'ipad', requested: 'ipad', settled: true }));
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

describe('makeHttpHidModeEndpoint proxy routing', () => {
  it('routes the GET /hidmode fetch through the proxy when proxyUrl is set', async () => {
    const ep = makeHttpHidModeEndpoint({
      url: `http://127.0.0.1:${originPort}/hidmode`,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    });
    await expect(ep.read()).resolves.toEqual({ mode: 'ipad', requested: 'ipad', settled: true });
    expect(connectTargets).toContain(`127.0.0.1:${originPort}`);
  });

  it('connects directly (no proxy) when proxyUrl is unset', async () => {
    const ep = makeHttpHidModeEndpoint({ url: `http://127.0.0.1:${originPort}/hidmode` });
    await expect(ep.read()).resolves.toEqual({ mode: 'ipad', requested: 'ipad', settled: true });
    expect(connectTargets).toEqual([]);
  });
});
