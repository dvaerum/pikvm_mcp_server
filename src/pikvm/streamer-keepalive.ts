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
 * PROXY: when `PiKVMConfig.proxyUrl` is set (the macOS Local Network
 * loopback-CONNECT-proxy workaround), this connects through it via
 * `ConnectTunnelAgent` below — a hand-rolled classic `http(s).Agent`
 * subclass, NOT undici's `ProxyAgent` (client.ts's REST dispatcher uses
 * that, but it implements undici's `Dispatcher` interface, which `ws`
 * cannot consume — `ws`'s `ClientOptions.agent` wants a classic Node
 * `Agent`). Originally scoped OUT of this module entirely; restored
 * after georgs-mac-mini's PR #90 hardware gate found the gap was live on
 * their node — the exact node that reported this bug in the first
 * place — not hypothetical. Pattern reused verbatim from their own
 * working `scratch/ws-holder.mjs` (tinyproxy-based) rather than
 * re-derived, per their PR #90 gate follow-up message: raw TCP connect
 * to the proxy, write a `CONNECT host:port HTTP/1.1` line by hand, wait
 * for the `200`, then hand the same socket to `tls.connect()` and give
 * `ws` the resulting TLS socket. `ws` treats a custom Agent exactly like
 * any other — it just calls `agent.createConnection()`.
 */
import { WebSocket } from 'ws';
import { Agent as HttpsAgent, type RequestOptions } from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface StreamerKeepaliveConfig {
  /** Origin, e.g. "https://192.168.1.50" — same shape as PiKVMConfig.host. */
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
  /** Same shape as PiKVMConfig.proxyUrl, e.g. "http://127.0.0.1:8888".
   *  Empty/undefined = connect directly, matching PiKVMConfig's own
   *  convention (empty string, not undefined, is this codebase's usual
   *  "off" sentinel after the `Required<PiKVMConfig>` merge in
   *  client.ts's constructor — both are treated as falsy here). */
  proxyUrl?: string;
}

/**
 * CONNECT-tunnels every connection through an HTTP(S) proxy before
 * handing `ws` a live TLS socket. See this file's header for the
 * provenance (georgs-mac-mini's ws-holder.mjs, hardware-verified).
 *
 * `rejectUnauthorized` is applied INSIDE the `tls.connect()` call here —
 * distinct from (and in addition to) the `rejectUnauthorized` passed at
 * the outer `ws` ClientOptions level in `connectOnce()` below. Both are
 * required: the outer one is a `ws`-level check, but the self-signed
 * cert is actually negotiated by the raw `tls.connect()` here, before
 * `ws` ever sees a socket — georgs-mac-mini's gate-follow-up message
 * called this out explicitly as a easy-to-miss gotcha.
 */
class ConnectTunnelAgent extends HttpsAgent {
  constructor(
    private readonly proxyHost: string,
    private readonly proxyPort: number,
    private readonly rejectUnauthorized: boolean,
  ) {
    super();
  }

  override createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, socket: Duplex) => void,
  ): undefined {
    const targetHost = (options.host ?? '') as string;
    const targetPort = options.port ? Number(options.port) : 443;
    const sock = net.connect(this.proxyPort, this.proxyHost, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    sock.once('data', (data: Buffer) => {
      if (!/^HTTP\/1\.[01] 200/.test(data.toString())) {
        callback?.(new Error(`ConnectTunnelAgent: CONNECT failed: ${data.toString().split('\r\n')[0]}`), sock);
        return;
      }
      const tlsSock = tls.connect(
        { socket: sock, servername: targetHost, rejectUnauthorized: this.rejectUnauthorized },
        () => callback?.(null, tlsSock),
      );
      tlsSock.once('error', (err: Error) => callback?.(err, tlsSock));
    });
    sock.once('error', (err: Error) => callback?.(err, sock));
  }
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
  options: { headers: Record<string, string>; rejectUnauthorized: boolean; agent?: HttpsAgent },
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
    // Explicit rather than relying on kvmd's own `stream` default (true)
    // — georgs-mac-mini's ws-holder.mjs does the same; harmless either
    // way, removes any doubt for a future reader.
    u.searchParams.set('stream', '1');
    return u.toString();
  }

  /** Builds the CONNECT-tunnel agent when proxyUrl is set, else undefined
   *  (direct connection — `ws` behaves normally with no `agent` option). */
  private buildProxyAgent(): ConnectTunnelAgent | undefined {
    if (!this.config.proxyUrl) return undefined;
    const u = new URL(this.config.proxyUrl);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return new ConnectTunnelAgent(u.hostname, port, this.config.verifySsl);
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
        const agent = this.buildProxyAgent();
        ws = this.createSocket(this.wsUrl(), {
          headers: {
            'X-KVMD-User': this.config.username,
            'X-KVMD-Passwd': this.config.password,
          },
          rejectUnauthorized: this.config.verifySsl,
          ...(agent ? { agent } : {}),
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
