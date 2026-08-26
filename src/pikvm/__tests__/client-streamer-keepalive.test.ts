/**
 * End-to-end integration test of PiKVMClient.screenshot()'s streamer
 * idle-stop fix: a real loopback HTTP server standing in for kvmd
 * (serving /api/streamer/snapshot + /api/streamer) plus a real loopback
 * `ws` WebSocket server standing in for kvmd's /api/ws — same
 * real-loopback-servers idiom client-proxy.test.ts uses for the proxy
 * path, applied here to the streamer-keepalive path. No PiKVM, no
 * network, no mocking of undici/fetch or the `ws` package itself.
 *
 * The fake server tracks a `streamerUp` flag that flips true only after
 * an artificial delay following a WS connect — modeling kvmd's own
 * stream-controller poll loop + ustreamer's fork+exec+bind latency, the
 * exact race client.ts's retry-once exists to absorb.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PiKVMClient, StreamerUnavailableError } from '../client.js';

// Generous tolerance so the "no retry cost" assertion below stays robust
// on a loaded CI host — the real claim is "didn't pay the ~1500ms grace
// window", not a tight timing bound.
const STREAMER_RESTART_GRACE_TOLERANCE_MS = 800;

let server: http.Server;
let wss: WebSocketServer;
let port: number;
let jpeg: Buffer;

let streamerUp: boolean;
let streamerStartDelayMs: number | null; // null = WS connect never brings it up
let wsConnectCount: number;
let wsAuthHeadersSeen: Array<{ user: string | undefined; passwd: string | undefined }>;

function unavailableBody(): string {
  return JSON.stringify({ ok: false, result: { error: 'UnavailableError', error_msg: 'Service Unavailable' } });
}

beforeAll(async () => {
  jpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();

  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/streamer/snapshot')) {
      if (!streamerUp) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(unavailableBody());
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
      return;
    }
    if (req.url === '/api/streamer') {
      const body = streamerUp
        ? { ok: true, result: { streamer: { source: { online: true, resolution: { width: 4, height: 4 } } } } }
        : { ok: true, result: { streamer: null } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });

  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/ws')) {
      socket.destroy();
      return;
    }
    wsConnectCount++;
    wsAuthHeadersSeen.push({
      user: req.headers['x-kvmd-user'] as string | undefined,
      passwd: req.headers['x-kvmd-passwd'] as string | undefined,
    });
    wss.handleUpgrade(req, socket, head, () => {
      if (streamerStartDelayMs !== null) {
        setTimeout(() => {
          streamerUp = true;
        }, streamerStartDelayMs);
      }
      // streamerStartDelayMs === null models "the stream client connected
      // fine, but ustreamer itself never comes up" — the genuine-failure
      // negative control.
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  streamerUp = false;
  streamerStartDelayMs = 0;
  wsConnectCount = 0;
  wsAuthHeadersSeen = [];
});

const activeClients: PiKVMClient[] = [];
afterEach(() => {
  for (const c of activeClients) c.close();
  activeClients.length = 0;
});

function makeClient(): PiKVMClient {
  const c = new PiKVMClient({
    host: `http://127.0.0.1:${port}`,
    username: 'admin',
    password: 'pw',
    verifySsl: false,
  });
  activeClients.push(c);
  return c;
}

describe('PiKVMClient screenshot() — streamer idle-stop fix (integration)', () => {
  it('connects the keepalive WS with the same auth headers as REST requests', async () => {
    const client = makeClient();
    await client.screenshot();
    expect(wsConnectCount).toBe(1);
    expect(wsAuthHeadersSeen[0]).toEqual({ user: 'admin', passwd: 'pw' });
  });

  it('POSITIVE CONTROL: recovers via the retry-once when the first snapshot races ustreamer\'s own startup', async () => {
    // WS connects instantly, but "ustreamer" only finishes starting
    // 300ms later — well inside the 1500ms retry grace window, so the
    // first /streamer/snapshot 503s and the retry succeeds.
    streamerStartDelayMs = 300;
    const client = makeClient();
    const result = await client.screenshot();
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(wsConnectCount).toBe(1); // exactly one WS connection, no retry-storm
  });

  it('a SECOND screenshot in the same session pays zero retry cost (keepalive already up)', async () => {
    streamerStartDelayMs = 300;
    const client = makeClient();
    await client.screenshot(); // pays the race once
    streamerUp = true; // steady state — as it would be with a real held WS
    const t0 = Date.now();
    await client.screenshot();
    const elapsedMs = Date.now() - t0;
    // No retry needed this time — should be fast, nowhere near the grace window.
    expect(elapsedMs).toBeLessThan(STREAMER_RESTART_GRACE_TOLERANCE_MS);
    expect(wsConnectCount).toBe(1); // still just the one held connection
  });

  it('NEGATIVE CONTROL: a genuine failure (stream client connects, ustreamer never comes up) throws StreamerUnavailableError, not a bare 503', async () => {
    streamerStartDelayMs = null; // ustreamer never starts, no matter how long we wait
    const client = makeClient();
    await expect(client.screenshot()).rejects.toThrow(StreamerUnavailableError);
    await expect(client.screenshot()).rejects.toThrow(/held \/api\/ws stream client and one retry/);
    // The named error still carries the original 503/UnavailableError text
    // so operator-hints.ts's existing pattern match still fires on it.
    await expect(client.screenshot()).rejects.toThrow(/UnavailableError/);
  });

  it('getResolution() recovers via the same retry (no bare-503-shaped throw)', async () => {
    // Fresh client per assertion: once a client's keepalive WS is
    // connected it legitimately STAYS connected (that's the fix working
    // correctly), so there's no way to force a second race on the same
    // client — each scenario needs its own cold-start client.
    streamerStartDelayMs = 300;
    const client = makeClient();
    const resolution = await client.getResolution(true);
    expect(resolution).toEqual({ width: 4, height: 4 });
  });

  it('getStreamerStatus() recovers via the same retry (no bare-503-shaped throw)', async () => {
    streamerStartDelayMs = 300;
    const client = makeClient();
    const status = await client.getStreamerStatus();
    expect(status.sourceOnline).toBe(true);
  });
});
