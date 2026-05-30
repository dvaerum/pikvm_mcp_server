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
}

export interface CursorEvent extends CursorPos {
  phase: 'moved' | 'entered' | 'exited';
}

export interface SceneSpec {
  /** Catalog kind: image asset, procedural pattern, or video. */
  kind: 'image' | 'procedural' | 'video';
  /** Free-form per-kind parameters; see scene-renderers spec. */
  params: Record<string, unknown>;
}

export interface EffectSpec {
  blur?: number;       // 0–30 (px); 0 = no blur
  brightness?: number; // -1 … 1; 0 = unchanged
  colorMul?: [number, number, number];  // RGB multipliers; [1,1,1] = unchanged
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

  async subscribeCursor(): Promise<void> {
    await this.request('subscribe-cursor', {});
  }

  async unsubscribeCursor(): Promise<void> {
    await this.request('unsubscribe-cursor', {});
  }

  async setEffect(effect: EffectSpec): Promise<void> {
    await this.request('set-effect', effect);
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
