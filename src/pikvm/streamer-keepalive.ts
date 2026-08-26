/**
 * Streamer idle-stop workaround.
 *
 * kvmd (PiKVM's daemon) lazily starts ustreamer: it spawns the process
 * when a video WS client connects (`GET /api/ws` — the `stream` query
 * param defaults to `true`, so a bare connection counts) and stops it
 * ~10s after the last one disconnects (kvmd's own `shutdown_delay`,
 * default 10.0 — confirmed by reading kvmd's
 * apps/kvmd/streamer/runner.py directly). The MCP server calls
 * `/streamer/snapshot` over plain REST without ever being a stream
 * client itself, so any screenshot request arriving more than ~10s after
 * the previous one races a dead unix socket
 * (`/run/kvmd/ustreamer.sock`) and 503s. HID is unaffected — this is
 * video-only. In normal (human-driven) use this is masked because the
 * PiKVM web UI holds its own `/api/ws` session open; headless
 * Claude-Code-driven usage has no such client. See the task this closes
 * for the full root-cause writeup and georg's original repro.
 *
 * StreamerKeepalive holds ONE persistent `/api/ws` connection open for
 * the life of the MCP server process, so kvmd's own stream-client count
 * never drops back to zero and ustreamer never idle-stops after the
 * first screenshot of a session. This does NOT fully close the race on
 * its own: kvmd's stream-client count going 0→1 still has to propagate
 * through its own `__stream_controller` poll loop and then actually
 * fork+exec+bind ustreamer before `/streamer/snapshot` can succeed, so
 * the very first snapshot of a cold session can still hit the dead
 * socket once. client.ts's retry-once-on-503 covers that remaining
 * window; this module's job is narrower — make sure that after the
 * first successful connect, ustreamer never idle-stops again for the
 * rest of the session.
 *
 * Best-effort by design: nothing here ever throws out of
 * `ensureStarted()`. A connection failure just means the caller falls
 * through to the retry-once safety net, same as if this module didn't
 * exist — capture must never become LESS reliable than the pre-fix
 * baseline, only more.
 *
 * Scope note: does NOT support `PiKVMConfig.proxyUrl` (the macOS
 * loopback-CONNECT-proxy workaround, see client.ts's PiKVMConfig doc).
 * `ws`'s ClientOptions takes a classic Node `http(s).Agent`, not
 * undici's `Dispatcher` — proxying it would mean a second proxy-agent
 * implementation (e.g. a new `https-proxy-agent` dependency) for a
 * narrow, already-separately-workaround-able deployment. Out of scope
 * for this fix; the retry-once-on-503 mechanic still applies on that
 * path. Tracked in FUTURE-WORK.md if the proxied deployment ever hits
 * this in practice.
 */
import { WebSocket } from 'ws';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface StreamerKeepaliveConfig {
  /** Origin, e.g. "https://192.168.1.50" — same shape as PiKVMConfig.host. */
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
}

/** The minimal `ws`-shaped surface this module drives — structural so
 *  tests can inject a lightweight fake instead of a real socket. */
export interface MinimalWebSocket {
  readyState: number;
  once(event: 'open' | 'error' | 'close', listener: (...args: unknown[]) => void): void;
  close(): void;
}

export type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string>; rejectUnauthorized: boolean },
) => MinimalWebSocket;

const defaultFactory: WebSocketFactory = (url, options) =>
  new WebSocket(url, options) as unknown as MinimalWebSocket;

export class StreamerKeepalive {
  private ws: MinimalWebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: StreamerKeepaliveConfig,
    private readonly createSocket: WebSocketFactory = defaultFactory,
  ) {}

  private wsUrl(): string {
    const u = new URL('/api/ws', this.config.host);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  /** OPEN = 1 in both the browser WebSocket spec and the `ws` package —
   *  hardcoded so MinimalWebSocket doesn't need to import the real class
   *  just for a constant. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  /**
   * Idempotent: a no-op if already connected, and returns the SAME
   * promise to every caller while a connection attempt is in flight (so
   * concurrent screenshot calls during a cold start don't each open their
   * own socket). Resolves once the WS is OPEN, or after a connection
   * FAILURE — never rejects, per this module's best-effort contract.
   */
  async ensureStarted(): Promise<void> {
    if (this.stopped || this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      let ws: MinimalWebSocket;
      try {
        ws = this.createSocket(this.wsUrl(), {
          headers: {
            'X-KVMD-User': this.config.username,
            'X-KVMD-Passwd': this.config.password,
          },
          rejectUnauthorized: this.config.verifySsl,
        });
      } catch {
        // Synchronous construction failure (bad URL etc.) — best-effort,
        // fall through to a scheduled retry rather than propagating.
        settle();
        this.scheduleReconnect();
        return;
      }

      this.ws = ws;
      ws.once('open', () => {
        this.reconnectDelayMs = RECONNECT_BASE_MS; // reset backoff on success
        settle();
      });
      ws.once('error', () => {
        // 'close' always follows 'error' for `ws` sockets — the actual
        // cleanup + reconnect scheduling happens there, not here.
        settle();
      });
      ws.once('close', () => {
        if (this.ws === ws) this.ws = null;
        settle();
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureStarted().catch(() => {
        // ensureStarted() never rejects (documented above) — this catch
        // exists only to satisfy the no-floating-promise lint, not
        // because a rejection is ever expected here.
      });
    }, delay);
  }

  /** Explicit teardown — closes the held socket and cancels any pending
   *  reconnect. Mainly for tests; a real MCP server process holds this
   *  for its full lifetime and never calls stop(). */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
