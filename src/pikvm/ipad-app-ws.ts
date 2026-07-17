/**
 * WebSocket server + protocol library for the iPad collector app.
 *
 * Used by both `bench-collect-synthetic.ts` (request/response per-frame
 * cursor labels) and `bench-collect-trajectory.ts` (streaming cursor
 * events for pointer-acceleration data).
 *
 * Protocol summary (full schema in
 * docs/troubleshooting/2026-05-30-ipad-collector-design.md if/when we
 * write it). Each frame is a single JSON object on the socket:
 *
 *   app → collector  : hello, ack, cursor, cursor-event, time-pong, error
 *   collector → app  : hello-ack, show-scene, get-cursor, subscribe-cursor,
 *                      unsubscribe-cursor, set-effect, time-ping, ping
 *
 * Message IDs are used only for request/response correlation; streaming
 * `cursor-event` messages don't carry an id.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface AppHello {
  logicalW: number;
  logicalH: number;
  model: string;
}

export interface CursorPos {
  x: number;
  y: number;
  /** App-side wall-clock (ms since epoch). */
  t_ipad: number;
  /** True when PointerTracker has fired ≥1 hover; false = x/y are 0/0
   *  sentinels. `undefined` on pre-2026-06-18 clients — callers should
   *  use IpadSession.getTrackedCursor() which absorbs the legacy fallback. */
  tracked?: boolean;
}

export interface CursorEvent extends CursorPos {
  phase: 'moved' | 'entered' | 'exited';
}

/**
 * The app fires a `tap-event` whenever a click on the SceneRendererView
 * is recognised. Coordinates are iPad logical pixels — same space as
 * `CursorPos`. The bench uses this to verify "did our mouseClick
 * actually register inside the app, and at what coordinate?" without
 * relying on real iPad UI state.
 */
export interface TapEvent {
  x: number;
  y: number;
  /** App-side wall-clock (ms since epoch). */
  t_ipad: number;
}

/**
 * SwiftUI scene-phase transition reported by the app. Phases:
 *   - "active": foreground + receiving events (normal operation)
 *   - "inactive": foreground but not receiving events (system overlay,
 *     mid-transition, control centre etc.)
 *   - "background": app suspended; no HID/hover events fire, ANY
 *     pending RPC will see stale state — bench must abort.
 *
 * Motivated by the 2026-06-03 bench-collect-on-icon corpus run that
 * silently failed at row 112 after iPadCollector backgrounded. Without
 * this signal, getCursor RPCs return stale data until something times
 * out; with it the bench can abort cleanly and name the last good row.
 */
export interface LifecycleEvent {
  state: 'active' | 'inactive' | 'background' | 'unknown';
  /** App-side wall-clock (ms since epoch). */
  t_ipad: number;
}

export interface SceneSpec {
  /** Catalog kind: image asset, procedural pattern, or video. */
  kind: 'image' | 'procedural' | 'video' | 'blackHoldingPattern';
  /** For kind=image: base64-encoded JPEG/PNG bytes. */
  image?: string;
  /** For kind=procedural: which renderer (solid, gradient, checker, noise). */
  proc_kind?: string;
  /** For kind=procedural: numeric parameters consumed by the renderer
   *  (e.g. r/g/b for solid, cell for checker). iPad parses as Doubles. */
  params?: Record<string, number>;
  /** For kind=video: URL the app fetches and loops. */
  url?: string;
}

export interface EffectSpec {
  blur?: number;       // 0–30 (px); 0 = no blur
  brightness?: number; // -1 … 1; 0 = unchanged
  colorMul?: [number, number, number];  // RGB multipliers; [1,1,1] = unchanged
}

/**
 * Overlay rendered on TOP of the current scene. Each kind triggers a
 * different iPadOS pointer-style morph: a TextField shows an I-beam over
 * its area; a Button morphs into a highlighted button shape; "none"
 * leaves the system arrow alone. The morph is what we actually want in
 * the screenshot — the detector must learn that an I-beam over a text
 * field is still the cursor, with the hot-spot in its middle.
 *
 * `x`, `y`, `w`, `h` are in iPad logical coordinates (the same space as
 * cursor positions from `getCursor()` / cursor-event). The bench
 * positions the cursor inside the overlay rect to capture a morphed
 * frame, then sets `kind: 'none'` for the next non-morphed frame.
 */
export interface OverlaySpec {
  kind: 'none' | 'text-field';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 5000;

/**
 * One connected iPad app session. Wraps the WebSocket with typed RPC
 * methods + a cursor-event stream callback. The collector creates the
 * server, then for each accepted connection the IpadSession object is
 * what it interacts with.
 */
export class IpadSession {
  readonly id = randomUUID();
  hello: AppHello | null = null;
  /** NTP-style offset: `t_collector = t_ipad + clockOffsetMs`. Set by `syncClock()`. */
  clockOffsetMs = 0;
  /** Set by the user when streaming is on; called for every incoming cursor-event. */
  onCursorEvent: ((ev: CursorEvent) => void) | null = null;
  /** Set by the user; called for every tap inside the app's scene view.
   *  The app fires these always when a tap is recognised — no explicit
   *  subscribe message; the bench just sets the callback when it cares. */
  onTapEvent: ((ev: TapEvent) => void) | null = null;
  /** Set by the user; called for every scene-phase transition.
   *  Always-fire; bench may or may not register a handler. */
  onLifecycle: ((ev: LifecycleEvent) => void) | null = null;
  /** Latest reported scene phase, or null until the app sends its first
   *  lifecycle event. SwiftUI fires `.active` on launch so a connected
   *  session normally pins this to "active" within a few hundred ms. */
  currentLifecycle: LifecycleEvent['state'] | null = null;

  private readonly ws: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private closeReason: string | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: RawData) => this.onMessage(raw));
    ws.on('close', (_code: number, reason: Buffer) => {
      this.closeReason = reason.toString() || 'closed';
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`WebSocket closed: ${this.closeReason}`));
      }
      this.pending.clear();
    });
    ws.on('error', (err: Error) => {
      this.closeReason = err.message;
    });
  }

  get connected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private send(obj: unknown): void {
    if (!this.connected) throw new Error('IpadSession.send: not connected');
    this.ws.send(JSON.stringify(obj));
  }

  private request<T>(type: string, payload: unknown): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.send({ type, id, payload });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private onMessage(raw: RawData): void {
    let msg: { type: string; id?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        this.hello = msg.payload as AppHello;
        this.send({ type: 'hello-ack', payload: { sessionId: this.id } });
        break;
      }
      case 'ack':
      case 'cursor':
      case 'time-pong': {
        // Correlated responses to outstanding requests.
        const ref =
          msg.type === 'ack' ? (msg.payload as { ref?: string }).ref :
          msg.id;
        if (ref) {
          const p = this.pending.get(ref);
          if (p) {
            this.pending.delete(ref);
            clearTimeout(p.timer);
            p.resolve(msg.payload);
          }
        }
        break;
      }
      case 'cursor-event': {
        if (this.onCursorEvent) {
          this.onCursorEvent(msg.payload as CursorEvent);
        }
        break;
      }
      case 'tap-event': {
        if (this.onTapEvent) {
          this.onTapEvent(msg.payload as TapEvent);
        }
        break;
      }
      case 'lifecycle': {
        const ev = msg.payload as LifecycleEvent;
        this.currentLifecycle = ev.state;
        if (this.onLifecycle) {
          this.onLifecycle(ev);
        }
        break;
      }
      case 'error': {
        const p = (msg.payload as { ref?: string; reason?: string });
        if (p.ref) {
          const req = this.pending.get(p.ref);
          if (req) {
            this.pending.delete(p.ref);
            clearTimeout(req.timer);
            req.reject(new Error(p.reason ?? 'unknown app error'));
          }
        }
        break;
      }
      // ping: just keepalive, ignore
    }
  }

  // ---- typed RPCs ----

  async showScene(scene: SceneSpec): Promise<void> {
    await this.request('show-scene', scene);
  }

  async getCursor(): Promise<CursorPos> {
    return await this.request<CursorPos>('get-cursor', {});
  }

  /**
   * getCursor + "is this reading real" decision folded into one call.
   * Returns null when the app reports `tracked: false` (post-2026-06-18
   * builds), or when a legacy binary returns the (0,0) sentinel. Every
   * bench that needs iPadCollector ground truth should call this
   * instead of re-deriving the legacy-vs-modern rule.
   */
  async getTrackedCursor(): Promise<CursorPos | null> {
    const cur = await this.getCursor();
    if (cur.tracked === false) return null;
    if (cur.tracked === undefined && cur.x === 0 && cur.y === 0) return null;
    return cur;
  }

  /**
   * Wait for iPadCollector's PointerTracker to see a hover event.
   * Fresh app launches don't fire `.onContinuousHover` until the
   * cursor first enters the SceneRendererView; benches that need
   * a live ground-truth pointer must nudge until getTrackedCursor()
   * returns non-null. Returns true on success, false after attempts
   * exhausted.
   *
   * `nudge` receives the attempt index (0..attempts-1) and is
   * responsible for the HID emit + settle delay for that wake pass.
   * Kept as a callback so the caller owns the PiKVM client + timing
   * heuristics without this module having to import client.ts.
   */
  async awaitPointerAlive(
    nudge: (attempt: number) => Promise<void>,
    attempts = 8,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await nudge(attempt);
      try {
        const cur = await this.getTrackedCursor();
        if (cur !== null) return true;
      } catch { /* keep trying */ }
    }
    return false;
  }

  async subscribeCursor(): Promise<void> {
    await this.request('subscribe-cursor', {});
  }

  async unsubscribeCursor(): Promise<void> {
    await this.request('unsubscribe-cursor', {});
  }

  async setEffect(effect: EffectSpec): Promise<void> {
    await this.request('set-effect', effect);
  }

  async setOverlay(overlay: OverlaySpec): Promise<void> {
    await this.request('set-overlay', overlay);
  }

  /**
   * NTP-style clock sync: send a few time-pings, measure RTT and one-way
   * offset, take the median offset. Call once after `hello`, and again
   * periodically during long sessions.
   */
  async syncClock(samples = 5): Promise<{ offsetMs: number; rttMs: number }> {
    const offsets: number[] = [];
    const rtts: number[] = [];
    for (let i = 0; i < samples; i++) {
      const t_out = Date.now();
      const pong = await this.request<{
        t_collector_in: number;
        t_ipad_at_receive: number;
        t_ipad_at_send: number;
      }>('time-ping', { t_collector_out: t_out });
      const t_in = Date.now();
      const rtt = t_in - t_out;
      // offset such that t_collector = t_ipad + offset
      // (t_ipad_at_receive - t_collector_out) and (t_collector_in - t_ipad_at_send)
      // are roughly opposite signs of the actual offset minus RTT/2.
      const ipadMid = (pong.t_ipad_at_receive + pong.t_ipad_at_send) / 2;
      const collMid = (t_out + t_in) / 2;
      offsets.push(collMid - ipadMid);
      rtts.push(rtt);
    }
    offsets.sort((a, b) => a - b);
    rtts.sort((a, b) => a - b);
    const medOff = offsets[Math.floor(offsets.length / 2)];
    const medRtt = rtts[Math.floor(rtts.length / 2)];
    this.clockOffsetMs = medOff;
    return { offsetMs: medOff, rttMs: medRtt };
  }

  /** Convert an iPad-side timestamp to collector wall-clock. */
  ipadToCollectorMs(t_ipad: number): number {
    return t_ipad + this.clockOffsetMs;
  }

  close(): void {
    if (this.connected) this.ws.close();
  }
}

export interface IpadAppServerOptions {
  port: number;
  /** Called for each new app connection. Returns when the session is set up. */
  onSession(sess: IpadSession): Promise<void>;
}

/**
 * Bind a WebSocket server and dispatch each new connection to the user's
 * handler. Resolves with a `close()` function that shuts the server down.
 */
/**
 * SIGKILL any process holding the given local TCP port. Recurring bug:
 * when a previous bench dies but leaves a TCP socket open, the iPad app
 * is still talking to that dead-process socket — the next bench binds
 * the port fresh but never sees a hello, then times out. Call this at
 * the top of any bench's main(), before startIpadAppServer.
 *
 * No-op on platforms without `lsof` (e.g. Linux without it installed)
 * or when nothing holds the port.
 */
export function killOrphansOnPort(port: number, tag = 'ipad-app-ws'): void {
  let out: string;
  try {
    out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  } catch {
    return;
  }
  const pids = out
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      console.log(`[${tag}] killed orphan PID ${pid} holding port ${port}`);
    } catch (e) {
      console.error(`[${tag}] failed to kill PID ${pid}: ${(e as Error).message}`);
    }
  }
}

export function startIpadAppServer(opts: IpadAppServerOptions): { close(): Promise<void> } {
  const wss = new WebSocketServer({ port: opts.port, host: '0.0.0.0' });
  wss.on('connection', (ws: WebSocket) => {
    const sess = new IpadSession(ws);
    // Wait for the hello message (set inside onMessage) before handing off,
    // up to 10 s. If no hello arrives, drop the connection.
    const startedAt = Date.now();
    const handoff = setInterval(() => {
      if (sess.hello) {
        clearInterval(handoff);
        opts.onSession(sess).catch((err) => {
          console.error(`[ipad-app-ws] session ${sess.id} handler error:`, err);
          sess.close();
        });
      } else if (Date.now() - startedAt > 10_000) {
        clearInterval(handoff);
        console.error(`[ipad-app-ws] session ${sess.id} never sent hello — closing`);
        sess.close();
      }
    }, 50);
  });
  return {
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}
