/**
 * Unit tests for StreamerKeepalive, injecting a lightweight fake socket
 * (via the constructor's `createSocket` factory) instead of touching the
 * real `ws` package or a network — same DI approach client-proxy.test.ts
 * uses for undici's dispatcher, applied to the WS transport instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamerKeepalive, type MinimalWebSocket, type WebSocketFactory } from '../streamer-keepalive.js';

type Listener = (...args: unknown[]) => void;

/** A fake socket whose lifecycle the test drives directly (fire 'open',
 *  'error', 'close' on demand) instead of a real connection. */
class FakeSocket implements MinimalWebSocket {
  readyState = 0; // CONNECTING
  listeners = new Map<string, Listener[]>();
  closed = false;

  once(event: 'open' | 'error' | 'close', listener: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.fire('close');
  }

  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  open(): void {
    this.readyState = 1; // OPEN
    this.fire('open');
  }
}

function makeConfig() {
  return { host: 'https://192.168.1.50', username: 'admin', password: 'pw', verifySsl: false };
}

describe('StreamerKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects to /api/ws with the same X-KVMD-User/Passwd headers as the REST client', async () => {
    const sockets: FakeSocket[] = [];
    let capturedUrl = '';
    let capturedOpts: unknown = null;
    const factory: WebSocketFactory = (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    const p = ka.ensureStarted();
    sockets[0].open();
    await p;

    expect(capturedUrl).toBe('wss://192.168.1.50/api/ws');
    expect(capturedOpts).toEqual({
      headers: { 'X-KVMD-User': 'admin', 'X-KVMD-Passwd': 'pw' },
      rejectUnauthorized: false,
    });
    expect(ka.connected).toBe(true);
  });

  it('maps http:// host to ws:// (not wss://)', async () => {
    let capturedUrl = '';
    const factory: WebSocketFactory = (url) => {
      capturedUrl = url;
      const s = new FakeSocket();
      queueMicrotask(() => s.open());
      return s;
    };
    const ka = new StreamerKeepalive({ ...makeConfig(), host: 'http://192.168.1.50' }, factory);
    await ka.ensureStarted();
    expect(capturedUrl).toBe('ws://192.168.1.50/api/ws');
  });

  it('is idempotent: a second ensureStarted() while connected is a true no-op (no new socket)', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    const p1 = ka.ensureStarted();
    sockets[0].open();
    await p1;
    await ka.ensureStarted();
    await ka.ensureStarted();
    expect(sockets).toHaveLength(1);
  });

  it('concurrent ensureStarted() calls during a cold connect share ONE in-flight attempt', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    const [p1, p2, p3] = [ka.ensureStarted(), ka.ensureStarted(), ka.ensureStarted()];
    expect(sockets).toHaveLength(1); // only one real connection attempt made
    sockets[0].open();
    await Promise.all([p1, p2, p3]);
    expect(ka.connected).toBe(true);
  });

  it('reconnects with backoff after an unexpected close, and resets backoff on the next successful open', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    const p1 = ka.ensureStarted();
    sockets[0].open();
    await p1;
    expect(ka.connected).toBe(true);

    // Unexpected drop.
    sockets[0].readyState = 3;
    sockets[0].fire('close');
    expect(ka.connected).toBe(false);
    expect(sockets).toHaveLength(1); // reconnect not attempted yet — waiting out the backoff

    await vi.advanceTimersByTimeAsync(1000); // RECONNECT_BASE_MS
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await Promise.resolve(); // let the 'open' handler's microtask settle
    expect(ka.connected).toBe(true);

    // A second unexpected drop reconnects at the BASE delay again (backoff
    // reset by the successful open above), not a compounded delay.
    sockets[1].readyState = 3;
    sockets[1].fire('close');
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2); // not yet — one ms short of the base delay
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
  });

  it('backs off exponentially across repeated failures, capped at RECONNECT_MAX_MS', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    ka.ensureStarted();
    expect(sockets).toHaveLength(1);

    // Fail immediately (never opens) — each failure schedules the next
    // attempt at 2x the prior delay: 1000, 2000, 4000, ...
    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]; // caps at 30_000
    for (const delay of expectedDelays) {
      const before = sockets.length;
      sockets[sockets.length - 1].readyState = 3;
      sockets[sockets.length - 1].fire('close');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(before); // not yet
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(before + 1);
    }
  });

  it('a synchronous construction throw is absorbed — ensureStarted() never rejects', async () => {
    const factory: WebSocketFactory = () => {
      throw new Error('bad URL or similar');
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    await expect(ka.ensureStarted()).resolves.toBeUndefined();
    expect(ka.connected).toBe(false);
  });

  it('an error event resolves ensureStarted() without throwing (best-effort contract)', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    const p = ka.ensureStarted();
    sockets[0].fire('error', new Error('ECONNREFUSED'));
    await expect(p).resolves.toBeUndefined();
  });

  it('stop() closes the socket and prevents further reconnect attempts', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    const p = ka.ensureStarted();
    sockets[0].open();
    await p;

    ka.stop();
    expect(sockets[0].closed).toBe(true);
    expect(ka.connected).toBe(false);

    // No reconnect fires even after a long wait — stop() is terminal.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('ensureStarted() after stop() is a no-op (does not resurrect the connection)', async () => {
    const sockets: FakeSocket[] = [];
    const factory: WebSocketFactory = () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const ka = new StreamerKeepalive(makeConfig(), factory);
    ka.stop();
    await ka.ensureStarted();
    expect(sockets).toHaveLength(0);
  });
});
