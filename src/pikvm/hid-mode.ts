/**
 * Stateless HID-mode derivation (pikvm-nixos #51). See
 * docs/adr/0002-mcp-derives-hid-mode-from-appliance-endpoint.md.
 *
 * The appliance owns the HID mode (desktop = absolute/dual, ipad = relative/single)
 * and exposes it over a loopback token endpoint. The MCP READS it and flips its own
 * absolute/relative behaviour, holding no second copy. Two source shapes:
 *
 *  - DECLARED  (`--target ipad|desktop`, no endpoint) — the permanent, first-class
 *    config for stock-Arch pikvm01: fixed mode, always reachable, never settling.
 *  - ENDPOINT  (`PIKVM_HIDMODE_URL` set) — the appliance: derive from GET /hidmode,
 *    short-TTL cached, FAIL-CLOSED when unreachable (mover ops refuse rather than
 *    guess), with a settling gate over the post-switch USB re-enumeration window.
 *
 * `mouseAbsoluteMode` is derived from the resolved mode via {@link modeIsAbsolute}.
 */
import { Agent, fetch as undiciFetch } from 'undici';

export type HidMode = 'ipad' | 'desktop';

/** desktop ⇒ absolute mouse (dual gadget); ipad ⇒ relative mouse (single). */
export const modeIsAbsolute = (mode: HidMode): boolean => mode === 'desktop';

/** MCP end of the /hidmode contract. `read()` returns the mode, or **null** when
 *  the route is unconfigured / unreachable / non-200 (unknown ≠ a guessed mode). */
export interface HidModeEndpoint {
  readonly configured: boolean;
  read(): Promise<HidMode | null>;
  write(mode: HidMode): Promise<{ ok: boolean; message: string }>;
}

export interface HidModeStatus {
  /** the resolved mode, or **null** = UNKNOWN (endpoint fail-closed / not yet read). */
  mode: HidMode | null;
  source: 'declared' | 'endpoint';
  reachable: boolean;
  settling: boolean;
  lastReadAt: number | null;
  moverAllowed: boolean;
  moverBlockReason: string | null;
}

export interface HidModeResolverOpts {
  /** Exactly one of `declared` / `endpoint` (enforced by the caller at startup). */
  declared?: HidMode;
  endpoint?: HidModeEndpoint;
  /** Endpoint cache lifetime; a read within this window is reused, not re-fetched. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5000;

/**
 * Resolves the HID mode the mover should use. Declared sources are trivial and
 * always allow moving. Endpoint sources cache the last good read for a short TTL,
 * fail closed when the endpoint can't be read (mover ops REFUSE), and gate the
 * mover during the re-enumeration window after a detected switch.
 */
export class HidModeResolver {
  private readonly declared?: HidMode;
  private readonly endpoint?: HidModeEndpoint;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private lastGoodMode: HidMode | null = null; // last SUCCESSFUL read (persists across failures for change-detection)
  private lastOkAt: number | null = null;      // when lastGoodMode was read (TTL anchor)
  private reachable: boolean;                   // was the most recent resolve readable / cache-fresh
  private settling = false;                     // re-enumeration in progress → refuse mover ops

  constructor(opts: HidModeResolverOpts) {
    this.declared = opts.declared;
    this.endpoint = opts.endpoint;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    // Declared is known + reachable from the start; endpoint is UNKNOWN until read.
    this.reachable = this.declared !== undefined;
    if (this.declared !== undefined) this.lastGoodMode = this.declared;
  }

  /** True when this resolver derives from an endpoint (vs a declared target). */
  get isEndpoint(): boolean { return this.endpoint !== undefined; }

  /**
   * Resolve the current mode. Declared → the fixed value. Endpoint → the cached
   * value when fresh, else a re-read; a failed read yields **null** (fail-closed)
   * and is never cached (so recovery is immediate). A read that returns a mode
   * DIFFERENT from the last good one begins settling (a switch happened elsewhere).
   */
  async resolve(): Promise<HidMode | null> {
    if (this.declared !== undefined) return this.declared;
    const ep = this.endpoint!;
    const t = this.now();
    if (this.lastOkAt !== null && t - this.lastOkAt < this.ttlMs) {
      this.reachable = true;
      return this.lastGoodMode; // fresh cache — no I/O
    }
    const m = await ep.read();
    if (m === null) {
      this.reachable = false; // FAIL-CLOSED; do not cache the failure
      return null;
    }
    if (this.lastGoodMode !== null && m !== this.lastGoodMode) this.settling = true;
    this.lastGoodMode = m;
    this.lastOkAt = t;
    this.reachable = true;
    return m;
  }

  /** The mode as of the last resolve(), fail-closed to null when unreachable. */
  private resolvedMode(): HidMode | null {
    if (this.declared !== undefined) return this.declared;
    return this.reachable ? this.lastGoodMode : null;
  }

  /** Whether a mover op may proceed, and why not. */
  moverGate(): { allowed: boolean; reason: string | null } {
    const mode = this.resolvedMode();
    if (mode === null) {
      return {
        allowed: false,
        reason: 'HID mode unknown — the appliance /hidmode endpoint is unreachable; refusing to move rather than guess the mode',
      };
    }
    if (this.settling) {
      return {
        allowed: false,
        reason: 'HID re-enumerating after a mode switch — the target USB is not back online yet; retry once it reconnects',
      };
    }
    return { allowed: true, reason: null };
  }

  status(): HidModeStatus {
    const gate = this.moverGate();
    return {
      mode: this.resolvedMode(),
      source: this.declared !== undefined ? 'declared' : 'endpoint',
      reachable: this.reachable,
      settling: this.settling,
      lastReadAt: this.lastOkAt,
      moverAllowed: gate.allowed,
      moverBlockReason: gate.reason,
    };
  }

  /** Force the next resolve() to re-read (a switch drops the session; on reconnect
   *  we must not trust the cache). Keeps lastGoodMode for change-detection. */
  markReconnect(): void {
    this.lastOkAt = null;
  }

  beginSettling(): void { this.settling = true; }

  /** Clear the settling gate — the integration calls this once the target HID is
   *  confirmed ONLINE (UDC ground truth; the kvmd flags lie). */
  clearSettling(): void { this.settling = false; }

  /**
   * Switch the appliance mode (POST /hidmode). Begins settling and forces a
   * re-read on reconnect. The returned message is HONEST: the switch is requested,
   * the session WILL drop, and the new mode is NOT live yet. Declared resolvers
   * cannot switch (there is no endpoint to POST).
   */
  async set(mode: HidMode): Promise<{ ok: boolean; message: string }> {
    if (!this.endpoint) {
      return { ok: false, message: 'HID mode is fixed (declared target); there is no /hidmode endpoint to switch' };
    }
    const r = await this.endpoint.write(mode);
    this.beginSettling();
    this.markReconnect();
    return {
      ok: r.ok,
      message:
        `mode switch to "${mode}" requested (${r.message}). The session WILL drop and the new mode is ` +
        `NOT live yet — reconnect and re-read /hidmode before driving input.`,
    };
  }
}

export interface HidModeHttpDeps {
  get?: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;
  post?: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: unknown }>;
}

/**
 * HTTP client for the appliance /hidmode endpoint. Mirrors the recovery-endpoint
 * idiom (bearer token, TLS-verify default off for the loopback self-signed cert).
 * `read()` degrades to null on any non-200 / error so the resolver fails closed.
 */
export function makeHttpHidModeEndpoint(
  cfg: { url?: string; token?: string; verifySsl?: boolean; timeoutMs?: number },
  deps: HidModeHttpDeps = {},
): HidModeEndpoint {
  // PIKVM_HIDMODE_URL is the FULL endpoint (e.g. http://127.0.0.1:8083/hidmode),
  // per the appliance module author's contract — used AS-IS, no route appended
  // (unlike PIKVM_HID_RECOVERY_URL, which is a base). GET and POST both target it.
  const url = cfg.url?.trim() ?? '';
  const configured = Boolean(url);
  const timeoutMs = cfg.timeoutMs ?? 2000; // a hung /hidmode must not stall the mover gate / startup
  const authHeaders = (): Record<string, string> =>
    cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};

  const get =
    deps.get ??
    (async (u: string, headers: Record<string, string>) => {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.verifySsl ?? false } });
      const res = await undiciFetch(u, { method: 'GET', headers, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
      let body: unknown;
      try { body = await res.json(); } catch { /* non-JSON / empty */ }
      return { status: res.status, body };
    });
  const post =
    deps.post ??
    (async (u: string, headers: Record<string, string>, b: string) => {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.verifySsl ?? false } });
      const res = await undiciFetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: b,
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body: unknown;
      try { body = await res.json(); } catch { /* non-JSON / empty */ }
      return { status: res.status, body };
    });

  return {
    configured,
    async read(): Promise<HidMode | null> {
      if (!url) return null;
      try {
        const { status, body } = await get(url, authHeaders());
        if (status !== 200) return null;
        const m = (body as { mode?: unknown })?.mode;
        return m === 'ipad' || m === 'desktop' ? m : null;
      } catch {
        return null;
      }
    },
    async write(mode: HidMode): Promise<{ ok: boolean; message: string }> {
      if (!url) return { ok: false, message: '/hidmode endpoint not configured' };
      try {
        const { status, body } = await post(url, authHeaders(), JSON.stringify({ mode }));
        const ok = status >= 200 && status < 300;
        const message = (body as { message?: string })?.message ?? `POST /hidmode: HTTP ${status}`;
        return { ok, message };
      } catch (err) {
        return { ok: false, message: `POST /hidmode failed: ${(err as Error).message}` };
      }
    },
  };
}
