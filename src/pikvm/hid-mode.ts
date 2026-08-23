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
import { basicAuthHeader } from '../session-auth.js';

export type HidMode = 'ipad' | 'desktop';

/** desktop ⇒ absolute mouse (dual gadget); ipad ⇒ relative mouse (single). */
export const modeIsAbsolute = (mode: HidMode): boolean => mode === 'desktop';

/** MCP end of the /hidmode contract. `read()` returns the mode, or **null** when
 *  the route is unconfigured / unreachable / non-200 (unknown ≠ a guessed mode). */
/** One parse of GET /hidmode. The endpoint reports the ASSEMBLED gadget, so `mode`
 *  is the OBSERVED gadget (authoritative for driving); `null` = unrecognisable /
 *  mid-reassembly (unsettled). `requested` is the marker's INTENT and `settled` is
 *  "gadget recognisable" (NOT "the switch succeeded"): `settled && requested !==
 *  mode` is a next-boot-pending divergence (drift) — the config (requested) will
 *  assemble on the next reboot but differs from the current gadget. See ADR 0002. */
export interface HidModeReading {
  mode: HidMode | null;
  requested?: HidMode | null;
  settled?: boolean;
}

export interface HidModeEndpoint {
  readonly configured: boolean;
  /** null = unreachable / non-200; else the parsed reading (mode may be null = unsettled). */
  read(): Promise<HidModeReading | null>;
  write(mode: HidMode): Promise<{ ok: boolean; message: string }>;
}

export interface HidModeStatus {
  /** the resolved mode (observed gadget), or **null** = UNKNOWN (unreachable / unsettled / not yet read). */
  mode: HidMode | null;
  source: 'declared' | 'endpoint';
  reachable: boolean;
  settling: boolean;
  lastReadAt: number | null;
  /** the marker's intent from the last read (null for declared / not read). */
  requestedMode: HidMode | null;
  /** the assembled gadget ≠ the requested (next-boot) mode while recognisable ⇒ a
   *  next-boot-pending divergence (the requested mode assembles on the next reboot). */
  driftDetected: boolean;
  moverAllowed: boolean;
  moverBlockReason: string | null;
  warnings: string[];
}

export interface HidModeResolverOpts {
  /** Exactly one of `declared` / `endpoint` (enforced by the caller at startup). */
  declared?: HidMode;
  endpoint?: HidModeEndpoint;
  /** Endpoint cache lifetime; a read within this window is reused, not re-fetched. */
  ttlMs?: number;
  /** Max time the settling gate stays closed after a switch before it AUTO-EXPIRES
   *  (the backstop that makes the gate un-latchable — see {@link HidModeResolver}). */
  settleWindowMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 5000;
// Backstop for the settling gate. clearSettling() (health_check on UDC-online) is the
// fast path; this bounds the MAX time the mover stays gated when that path doesn't run,
// so a missed clear can't dead-latch the mover (the #51 bug: settling was a one-way flag
// cleared ONLY by health_check, so polling status left it stuck until an MCP restart).
// 15s comfortably covers a real post-switch USB re-enumeration (a few seconds).
const DEFAULT_SETTLE_WINDOW_MS = 15000;

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
  private readonly settleWindowMs: number;
  private readonly now: () => number;

  private lastGoodMode: HidMode | null = null; // last VALID observed mode (persists across failures for change-detection)
  private lastOkAt: number | null = null;      // when lastGoodMode was read (TTL anchor)
  private currentMode: HidMode | null = null;  // mode as of the last resolve: null when unreachable OR unsettled
  private lastReading: HidModeReading | null = null; // last endpoint parse, for the drift diagnostic
  private reachable: boolean;                   // did the endpoint answer on the most recent resolve / cache-fresh
  private settleUntil: number | null = null;    // re-enum window deadline; settling === now() < settleUntil (re-derived, never latches)

  constructor(opts: HidModeResolverOpts) {
    this.declared = opts.declared;
    this.endpoint = opts.endpoint;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.settleWindowMs = opts.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    // Declared is known + reachable from the start; endpoint is UNKNOWN until read.
    this.reachable = this.declared !== undefined;
    if (this.declared !== undefined) { this.lastGoodMode = this.declared; this.currentMode = this.declared; }
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
      this.currentMode = this.lastGoodMode; // fresh cache — no I/O
      return this.lastGoodMode;
    }
    const reading = await ep.read();
    this.lastReading = reading;
    if (reading === null) {
      this.reachable = false; // UNREACHABLE → FAIL-CLOSED; never cached, so recovery is immediate
      this.currentMode = null;
      return null;
    }
    this.reachable = true;
    const m = reading.mode;
    if (m === null) {
      this.currentMode = null; // reachable but UNSETTLED (gadget mid-reassembly) → fail-closed; not cached
      return null;
    }
    // The endpoint reports the OBSERVED gadget, so a changed observed mode means the
    // gadget re-assembled elsewhere — begin settling. (A drift, where the gadget did
    // NOT change, is surfaced separately in status; it is not a settling event.)
    if (this.lastGoodMode !== null && m !== this.lastGoodMode) this.settleUntil = t + this.settleWindowMs;
    this.lastGoodMode = m;
    this.lastOkAt = t;
    this.currentMode = m;
    return m;
  }

  /** The mode as of the last resolve(): declared value, or the observed gadget mode,
   *  fail-closed to null when unreachable OR unsettled. */
  private resolvedMode(): HidMode | null {
    if (this.declared !== undefined) return this.declared;
    return this.currentMode;
  }

  /** Settling is RE-DERIVED from the clock, never a latched flag: true only while the
   *  bounded re-enum window is still open. It auto-expires (so a missed clearSettling()
   *  can't dead-latch the mover) and clearSettling() clears it early on confirmed UDC-online. */
  private isSettling(): boolean {
    return this.settleUntil !== null && this.now() < this.settleUntil;
  }

  /** requested(next-boot)≠observed while the gadget is recognisable ⇒ a next-boot-pending divergence. */
  private drift(): boolean {
    const r = this.lastReading;
    return !!(this.declared === undefined && r && r.settled && r.requested && r.mode && r.requested !== r.mode);
  }

  /** Whether a mover op may proceed, and why not. */
  moverGate(): { allowed: boolean; reason: string | null } {
    const mode = this.resolvedMode();
    if (mode === null) {
      const reason = this.declared === undefined && this.reachable
        ? 'HID gadget not recognisable — it is mid-reassembly (unsettled); refusing to move until it settles'
        : 'HID mode unknown — the appliance /hidmode endpoint is unreachable; refusing to move rather than guess the mode';
      return { allowed: false, reason };
    }
    if (this.isSettling()) {
      return {
        allowed: false,
        reason: 'HID re-enumerating after a mode switch — the target USB is not back online yet; retry once it reconnects',
      };
    }
    return { allowed: true, reason: null };
  }

  status(): HidModeStatus {
    const gate = this.moverGate();
    const r = this.lastReading;
    const driftDetected = this.drift();
    const warnings: string[] = [];
    if (driftDetected) {
      warnings.push(
        `NEXT-BOOT PENDING: the appliance will boot into "${r!.requested}" but the gadget is currently assembled as ` +
        `"${r!.mode}" — the mover is correctly driving the current gadget "${r!.mode}" (no wrong-mode risk); the ` +
        `requested mode takes effect on the next reboot.`,
      );
    }
    return {
      mode: this.resolvedMode(),
      source: this.declared !== undefined ? 'declared' : 'endpoint',
      reachable: this.reachable,
      settling: this.isSettling(),
      lastReadAt: this.lastOkAt,
      requestedMode: this.declared !== undefined ? null : (r?.requested ?? null),
      driftDetected,
      moverAllowed: gate.allowed,
      moverBlockReason: gate.reason,
      warnings,
    };
  }

  /** Force the next resolve() to re-read (a switch drops the session; on reconnect
   *  we must not trust the cache). Keeps lastGoodMode for change-detection. */
  markReconnect(): void {
    this.lastOkAt = null;
  }

  /** Open a bounded settling window from now (a switch we initiated). Auto-expires
   *  after settleWindowMs; clearSettling() ends it early on confirmed UDC-online. */
  beginSettling(): void { this.settleUntil = this.now() + this.settleWindowMs; }

  /** Clear the settling gate early — the integration calls this once the target HID is
   *  confirmed ONLINE (UDC ground truth; the kvmd flags lie). The window ALSO auto-expires
   *  without this, so a missed call can't dead-latch the mover (the #51 bug). */
  clearSettling(): void { this.settleUntil = null; }

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
 * HTTP client for the appliance /hidmode endpoint. Two auth shapes, tried in order:
 *   1. Bearer token (PIKVM_HIDMODE_TOKEN) — the ORIGINAL on-box loopback deployment
 *      (the standalone `pikvm-hidmode-endpoint` daemon at 127.0.0.1:8083). Unchanged.
 *   2. HTTP Basic, using the SAME kvmd credentials the MCP already sends for every
 *      other appliance call (`client.ts`) — the off-box front-door deployment
 *      (nginx `auth_request`-gated dashboard auth; pikvm-nixos@georgs-mac-mini's design), which
 *      REJECTS a bearer token (401). A single instance only ever points
 *      PIKVM_HIDMODE_URL at ONE endpoint, so either/or precedence is sufficient —
 *      no need to send both simultaneously.
 * TLS-verify defaults off for the loopback self-signed cert either way.
 * `read()` degrades to null on any non-200 / error so the resolver fails closed.
 */
export function makeHttpHidModeEndpoint(
  cfg: { url?: string; token?: string; username?: string; password?: string; verifySsl?: boolean; timeoutMs?: number },
  deps: HidModeHttpDeps = {},
): HidModeEndpoint {
  // PIKVM_HIDMODE_URL is the FULL endpoint (e.g. http://127.0.0.1:8083/hidmode),
  // per the appliance module author's contract — used AS-IS, no route appended
  // (unlike PIKVM_HID_RECOVERY_URL, which is a base). GET and POST both target it.
  const url = cfg.url?.trim() ?? '';
  const configured = Boolean(url);
  const timeoutMs = cfg.timeoutMs ?? 2000; // a hung /hidmode must not stall the mover gate / startup
  const authHeaders = (): Record<string, string> => {
    if (cfg.token) return { authorization: `Bearer ${cfg.token}` };
    if (cfg.username && cfg.password) return { authorization: basicAuthHeader(cfg.username, cfg.password) };
    return {};
  };

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
    async read(): Promise<HidModeReading | null> {
      if (!url) return null;
      try {
        const { status, body } = await get(url, authHeaders());
        if (status !== 200) return null; // unreachable / auth / error → unknown (fail-closed upstream)
        const b = body as { mode?: unknown; requested?: unknown; settled?: unknown };
        const coerce = (v: unknown): HidMode | null => (v === 'ipad' || v === 'desktop' ? v : null);
        // `mode` = the OBSERVED assembled gadget (authoritative); requested/settled for drift.
        return { mode: coerce(b?.mode), requested: coerce(b?.requested), settled: b?.settled === true };
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
