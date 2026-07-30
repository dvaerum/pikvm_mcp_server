/**
 * HID-recovery ladder — detection + escalation for when the emulated USB HID
 * gadget stops driving the target (mouse/keyboard dead while video is fine).
 *
 * Canonical runbook: docs/runbooks/hid-recovery.md.
 *
 * The ladder (firsthand-confirmed 2026-07-22/23), honestly ranked:
 *   R0  PRESENCE GATE — the target must be awake/present or NOTHING recovers
 *       (an asleep iPad won't enumerate USB). Behavioral: a screenshot returns
 *       an image. If it fails, wake/power the target first — no rung will work.
 *   R1  SOFT RESET — resetHid() (POST /hid/reset [+ set_connected toggle]). Cheap
 *       first try; LOW reliability (can't force host re-enumeration; set_connected
 *       is a no-op on our unit). MCP-native (also the pikvm_hid_reset tool).
 *   R2  SOFT_CONNECT — toggle the UDC's D+ pull-up: `echo disconnect >
 *       /sys/class/udc/<udc>/soft_connect; sleep; echo connect > …`. **VALIDATED
 *       2026-07-23**: recovered a real ~4h-idle HID drop in ~6s (UDC state
 *       not-attached→configured; mouse+keyboard back) after R1 failed — the
 *       primary no-reboot fix. A distinct kernel mechanism from R1's
 *       kvmd set_connected (which is a no-op here); bypasses the FileExistsError
 *       trap (doesn't touch the gadget tree). Privileged HOST op via the trigger.
 *   R3a UDC REBIND — configfs UDC unbind→bind / `systemctl restart kvmd-otg`.
 *       Still UNTESTED (soft_connect recovered first, didn't need to escalate);
 *       must be idempotent (FileExistsError trap). Privileged HOST op.
 *   R3b REBOOT — reboot the PiKVM host. DESTRUCTIVE (whole appliance ~30-90s),
 *       opt-in; now RARELY NEEDED given R2. Privileged HOST op via the trigger.
 *   R4  HUMAN — physical re-plug / power-on of the target. Now the last resort:
 *       the 07-22 "needed a physical re-plug" was because only R1 existed then,
 *       before soft_connect. Honest terminal state, not a remote action.
 *
 * VERIFY BEHAVIORALLY: the mouseOnline/keyboardOnline flags have lied, so after
 * each rung recovery is confirmed by emitting a mouse move and checking the
 * screen actually changed — not by the flags. `isHidBroken` on the flags stays
 * only as the CHEAP TRIGGER for whether to start the ladder at all.
 *
 * MCP-side scaffolding; the R2/R3a/R3b HOST mechanisms are provided by
 * pikvm-nixos against the {@link RecoveryTrigger} contract (see runbook). Until
 * wired, host rungs report unavailable.
 */
import { execFile } from 'node:child_process';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { decodeScreenshot } from './cursor-detect.js';
import { findCursorByV8FullFrame } from './cursor-ml-detect.js';

/** The subset of HID flag-state the cheap trigger reasons about. */
export interface HidOnlineState {
  online: boolean;
  mouseOnline: boolean;
  keyboardOnline: boolean;
}

/**
 * Cheap TRIGGER only: the flags say the HID isn't fully usable. NB the flags are
 * known to lie both ways — use {@link HidVerifier} for authoritative "recovered".
 */
export function isHidBroken(s: HidOnlineState): boolean {
  return !(s.mouseOnline && s.keyboardOnline);
}

/** Privileged HOST recovery actions (R2/R3a/R3b), performed via the trigger. */
export type HostRecoveryAction = 'soft_connect' | 'udc-rebind' | 'reboot';
/** Every ladder step that performs an action (R1 is MCP-native, the rest host). */
export type LadderAction = 'soft-reset' | HostRecoveryAction;

/** Ordered escalation. maxRung 1..4 slices this (1=soft-reset … 4=reboot). */
const LADDER: LadderAction[] = ['soft-reset', 'soft_connect', 'udc-rebind', 'reboot'];

/**
 * The MCP↔nixos trigger contract. The unprivileged MCP service can't toggle a
 * UDC or reboot the host, so it delegates to a privileged host helper
 * pikvm-nixos provides. `configured:false` ⇒ the orchestrator reports host rungs
 * unavailable instead of failing opaquely.
 */
export interface RecoveryTrigger {
  readonly configured: boolean;
  escalate(action: HostRecoveryAction): Promise<{ ok: boolean; message: string }>;
}

/** Client surface the ladder needs (satisfied by PiKVMClient). */
export interface HidRecoveryClient {
  getHidProfile(): Promise<HidOnlineState>;
  resetHid(opts: { reconnectUsb?: boolean; settleMs?: number }): Promise<HidOnlineState>;
  screenshot(): Promise<{ buffer: Buffer }>;
  mouseMoveRelative(dx: number, dy: number): Promise<void>;
}

/** Authoritative recovery check — behavioral, because the flags lie. */
export interface HidVerifier {
  verify(): Promise<{ healthy: boolean; detail: string }>;
}

export interface WaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * R0 — target presence. Behavioral: a screenshot must return a non-empty image.
 * A dead/asleep target (no HDMI) fails here, and NO rung can recover it.
 */
export async function checkTargetPresent(client: Pick<HidRecoveryClient, 'screenshot'>): Promise<boolean> {
  try {
    const shot = await client.screenshot();
    return Boolean(shot?.buffer && shot.buffer.length > 0);
  } catch {
    return false;
  }
}

/** Injectable cursor locator for {@link makeBehavioralVerifier}: returns the
 *  pointer's frame position, or null when it cannot be localized. Default wraps
 *  the same V8 detector the mover/click use. */
export type BehavioralLocator = (buffer: Buffer) => Promise<{ x: number; y: number } | null>;

/**
 * Default behavioral verifier: emit a mouse move and check the POINTER actually
 * responded — the cursor must be LOCALIZABLE and have MOVED with the emit.
 *
 * Fix-(c) 2026-07-30: the old check ("any screen change after the emit") false-
 * positived while HID was stone dead — a clock tick or app animation passed it,
 * so hid_recover reported "RECOVERED" and sent a field agent 45 min down the
 * wrong path. A moved, localizable cursor proves input actually reached the
 * target AND the pointer renders. This is the POINTER layer; a recovery
 * trigger's own UDC-`configured` check is the HID layer — the two compose, they
 * do not replace each other (a box can be `configured` yet have an
 * unlocalizable pointer). Injectable locate keeps it unit-testable.
 */
export function makeBehavioralVerifier(
  client: Pick<HidRecoveryClient, 'screenshot' | 'mouseMoveRelative'>,
  opts: { emitDx?: number; settleMs?: number; minMovePx?: number; minPresence?: number } = {},
  deps: WaitDeps & { locate?: BehavioralLocator } = {},
): HidVerifier {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emitDx = opts.emitDx ?? 40;
  const settleMs = opts.settleMs ?? 300;
  const minMovePx = opts.minMovePx ?? 8;
  const minPresence = opts.minPresence ?? 0.5;
  const locate: BehavioralLocator = deps.locate ?? (async (buffer) => {
    const dec = await decodeScreenshot(buffer);
    const hit = await findCursorByV8FullFrame(buffer, dec.width, dec.height, { minPresence });
    return hit ? { x: hit.x, y: hit.y } : null;
  });
  return {
    async verify() {
      try {
        const before = await locate((await client.screenshot()).buffer);
        // There-and-back emit: a working HID visibly moves the cursor without
        // permanently displacing it.
        await client.mouseMoveRelative(emitDx, 0);
        await sleep(settleMs);
        const after = await locate((await client.screenshot()).buffer);
        await client.mouseMoveRelative(-emitDx, 0);
        if (after === null) {
          return {
            healthy: false,
            detail:
              'mouse emit produced NO localizable cursor — the pointer is not rendering. ' +
              'HID is not driving input, OR HID is up but the pointer is faded/off-screen (not localizable).',
          };
        }
        if (before !== null) {
          const moved = Math.hypot(after.x - before.x, after.y - before.y);
          if (moved < minMovePx) {
            return {
              healthy: false,
              detail:
                `cursor is localizable but did NOT move on the mouse emit (${moved.toFixed(0)}px < ${minMovePx}px) — ` +
                'HID is not driving input (a bare screen change, e.g. a clock tick, would have FALSELY passed the old check).',
            };
          }
          return {
            healthy: true,
            detail: `mouse emit moved the cursor ${moved.toFixed(0)}px to a localizable position — HID is driving input.`,
          };
        }
        // Not localizable before, localizable after: the emit rendered a
        // previously-unfindable cursor — HID is driving input.
        return {
          healthy: true,
          detail: 'mouse emit produced a localizable cursor (not visible before) — HID is driving input.',
        };
      } catch (err) {
        return { healthy: false, detail: `behavioral verify failed: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * Poll a behavioral verifier until healthy or timeout (used for the reboot
 * wait-for-online, where the endpoint is down for a while). A thrown/failed
 * verify counts as "keep waiting". Injectable clock keeps it testable.
 */
export async function waitForRecovery(
  verifier: HidVerifier,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
  deps: WaitDeps = {},
): Promise<{ recovered: boolean; elapsedMs: number; polls: number }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const start = now();
  let polls = 0;
  for (;;) {
    polls += 1;
    let healthy = false;
    try {
      healthy = (await verifier.verify()).healthy;
    } catch {
      healthy = false;
    }
    if (healthy) return { recovered: true, elapsedMs: now() - start, polls };
    if (now() - start >= timeoutMs) return { recovered: false, elapsedMs: now() - start, polls };
    await sleep(intervalMs);
  }
}

export type RungLabel = 'R0' | 'R1' | 'R2' | 'R3a' | 'R3b';
export interface RungAttempt {
  rung: RungLabel;
  action: LadderAction;
  performed: boolean;
  recovered: boolean;
  detail: string;
}

export interface RecoverResult {
  /** R0: was the target present at all? When false, no rung is attempted. */
  targetPresent: boolean;
  /** Cheap-trigger read of the flags at entry. */
  initiallyBroken: boolean;
  recovered: boolean;
  attempts: RungAttempt[];
  /** Set when unrecovered: the R4 human escalation (physical re-plug / power). */
  humanActionRequired?: string;
}

const RUNG_OF: Record<LadderAction, RungLabel> = {
  'soft-reset': 'R1',
  'soft_connect': 'R2',
  'udc-rebind': 'R3a',
  reboot: 'R3b',
};

export interface RecoverOpts {
  /** How far to escalate: 1=soft-reset, 2=+soft_connect, 3=+udc-rebind, 4=+reboot. Default 3. */
  maxRung?: 1 | 2 | 3 | 4;
  /** R3b reboot is destructive (whole appliance ~30-90s) — must be opted in. */
  allowReboot?: boolean;
  softSettleMs?: number;
  /** Post-host-action recovery wait (ms). Default 15000 for R2/R3a. */
  hostWaitMs?: number;
  /** Post-reboot recovery wait (ms). Default 120000. */
  rebootWaitMs?: number;
  /**
   * Skip R1 (the kvmd soft-reset, a no-op on our unit) and start at R2
   * soft_connect. Used by pikvm_usb_reconnect — the validated field ladder is
   * soft_connect→udc-rebind, so the everyday tool doesn't waste a rung on the
   * kvmd reset. pikvm_hid_recover leaves this unset (keeps R1 for completeness).
   */
  skipSoftReset?: boolean;
}

/**
 * Detect (cheap flag trigger) → escalate the ladder → verify BEHAVIORALLY after
 * each rung. R0 presence-gates the whole thing; R4 (human re-plug) is the honest
 * terminal state when every allowed remote rung fails. Pure orchestration over
 * the injected client/trigger/verifier, so it is unit-testable with fakes.
 */
export async function recoverHid(
  client: HidRecoveryClient,
  trigger: RecoveryTrigger,
  verifier: HidVerifier,
  opts: RecoverOpts = {},
  deps: WaitDeps = {},
): Promise<RecoverResult> {
  const maxRung = opts.maxRung ?? 3;
  const attempts: RungAttempt[] = [];

  // R0 — presence gate. No rung recovers a target that isn't there.
  if (!(await checkTargetPresent(client))) {
    return {
      targetPresent: false,
      initiallyBroken: true,
      recovered: false,
      attempts,
      humanActionRequired: 'Target is not present (no screenshot / HDMI). Wake or power on the target first — no HID rung can recover an absent/asleep target.',
    };
  }

  const initiallyBroken = isHidBroken(await client.getHidProfile());
  // Cheap trigger says fine → confirm behaviorally (flags lie); if truly healthy, done.
  if (!initiallyBroken) {
    const v = await verifier.verify();
    if (v.healthy) {
      return { targetPresent: true, initiallyBroken: false, recovered: true, attempts };
    }
  }

  let steps = LADDER.slice(0, maxRung);
  if (opts.skipSoftReset) steps = steps.filter((a) => a !== 'soft-reset');
  for (const action of steps) {
    const rung = RUNG_OF[action];

    if (action === 'soft-reset') {
      await client.resetHid({ reconnectUsb: true, settleMs: opts.softSettleMs ?? 2000 });
    } else {
      // Host rungs (R2/R3a/R3b) go through the trigger.
      if (action === 'reboot' && !opts.allowReboot) {
        attempts.push({ rung, action, performed: false, recovered: false, detail: 'reboot skipped (allowReboot=false) — worked once but is destructive (~30-90s); re-run with allowReboot to use it' });
        continue;
      }
      if (!trigger.configured) {
        attempts.push({ rung, action, performed: false, recovered: false, detail: `${action} unavailable: the host recovery trigger is not configured (pikvm-nixos must provide it — see docs/runbooks/hid-recovery.md)` });
        continue;
      }
      const res = await trigger.escalate(action);
      if (!res.ok && action !== 'reboot') {
        attempts.push({ rung, action, performed: false, recovered: false, detail: res.message });
        continue;
      }
      // For reboot, the endpoint drops — wait a long window; else a short one.
      const wait = await waitForRecovery(verifier, { timeoutMs: action === 'reboot' ? (opts.rebootWaitMs ?? 120_000) : (opts.hostWaitMs ?? 15_000) }, deps);
      attempts.push({ rung, action, performed: res.ok, recovered: wait.recovered, detail: `${res.message} — ${wait.recovered ? 'behavioral verify healthy' : 'still not driving input (UNTESTED rung / may need next rung)'}` });
      if (wait.recovered) return { targetPresent: true, initiallyBroken, recovered: true, attempts };
      continue;
    }

    // Behavioral verify after the MCP-native soft reset.
    const v = await verifier.verify();
    attempts.push({ rung, action, performed: true, recovered: v.healthy, detail: v.healthy ? v.detail : `${v.detail} (soft reset rarely fixes a controller-level drop)` });
    if (v.healthy) return { targetPresent: true, initiallyBroken, recovered: true, attempts };
  }

  // R4 — every allowed remote rung failed. Honest terminal state.
  return {
    targetPresent: true,
    initiallyBroken,
    recovered: false,
    attempts,
    humanActionRequired: 'All allowed remote rungs failed. Physical intervention required: re-plug the target USB data cable (not charge-only) or power-cycle the target. Remote recovery cannot always fix a controller-level HID teardown (confirmed 2026-07-22).',
  };
}

/**
 * HTTP client for the host recovery trigger (R2/R3a/R3b). POSTs `{ action }` to
 * the pikvm-nixos localhost helper with a bearer token. MCP end of the
 * {@link RecoveryTrigger} contract; unset `url` ⇒ `configured:false`.
 */
export function makeHttpRecoveryTrigger(cfg: {
  url?: string;
  token?: string;
  verifySsl?: boolean;
}): RecoveryTrigger {
  const url = cfg.url?.trim();
  const configured = Boolean(url);
  let dispatcher: Dispatcher | undefined;
  const getDispatcher = (): Dispatcher => {
    if (!dispatcher) dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.verifySsl ?? false } });
    return dispatcher;
  };
  return {
    configured,
    async escalate(action) {
      if (!url) return { ok: false, message: 'host recovery trigger not configured' };
      try {
        const res = await undiciFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
          },
          body: JSON.stringify({ action }),
          dispatcher: getDispatcher(),
        });
        const ok = res.status >= 200 && res.status < 300;
        let message = `host trigger ${action}: HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body?.message) message = body.message;
        } catch {
          /* drained / empty */
        }
        return { ok, message };
      } catch (err) {
        if (action === 'reboot') {
          return { ok: true, message: `reboot initiated (host connection dropped: ${(err as Error).message})` };
        }
        return { ok: false, message: `host trigger ${action} failed: ${(err as Error).message}` };
      }
    },
  };
}

/** Runs one remote command. Injectable so the SSH trigger is unit-testable. */
export type SshExec = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** UDC / gadget directory names we are willing to interpolate into a command. */
const SAFE_SYSFS_NAME = /^[A-Za-z0-9._:-]+$/;

const defaultSshExec: SshExec = (args, opts) =>
  new Promise((resolve) => {
    execFile('ssh', args, { timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number'
        ? ((err as { code: number }).code)
        : err ? 255 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/**
 * SSH host-recovery transport — the STOCK-PiKVM backend for the same
 * {@link RecoveryTrigger} contract the appliance serves over loopback HTTP.
 *
 * Why this exists (2026-07-30): the MCP is meant to drive ANY PiKVM, including
 * a stock Arch image that has no pikvm-nixos recovery endpoint. Live evidence:
 * pikvm01 runs stock Arch (nothing on :8082, no recovery unit), so
 * `pikvm_usb_reconnect` had no transport and the one failure it exists to fix —
 * the HID gadget dropping to `not attached` — was unrecoverable from the MCP.
 * Toggling the UDC's D+ pull-up over SSH recovers it (validated by hand on that
 * box: `not attached` → `configured`, mouse+keyboard back, clicks landing).
 *
 * SCOPE: deliberately NOT a remote shell. Each action is a fixed sysfs/configfs
 * sequence with only a discovered, charset-validated UDC/gadget name
 * interpolated. `reboot` is intentionally unsupported here.
 *
 * AUTH: uses the operator's existing SSH configuration/agent (`ssh <host> …`,
 * BatchMode so it never hangs on a prompt). No key material is read, embedded
 * or transmitted by this code; a dedicated recovery key would be a sops concern.
 *
 * TRUTHFUL RESULT (the fix-(c) lesson): success is NOT "the command exited 0" —
 * it requires the UDC `state` to actually read `configured` afterwards. The
 * before/after states are reported either way, so a caller is never told a
 * recovery worked when the kernel says otherwise.
 */
export function makeSshRecoveryTrigger(cfg: {
  /** `[user@]host` for the PiKVM, e.g. `root@pikvm01`. Unset ⇒ not configured. */
  host?: string;
  /** Optional UDC override; default = the single entry under /sys/class/udc. */
  udc?: string;
  /** Optional gadget dir name under /sys/kernel/config/usb_gadget (rebind only). */
  gadget?: string;
  exec?: SshExec;
  timeoutMs?: number;
}): RecoveryTrigger {
  const host = cfg.host?.trim();
  const exec = cfg.exec ?? defaultSshExec;
  const timeoutMs = cfg.timeoutMs ?? 45_000;

  for (const [label, value] of [['udc', cfg.udc], ['gadget', cfg.gadget]] as const) {
    if (value && !SAFE_SYSFS_NAME.test(value)) {
      throw new Error(`makeSshRecoveryTrigger: refusing unsafe ${label} name ${JSON.stringify(value)}`);
    }
  }

  // Resolve the UDC once per call, on the host, so nothing is hardcoded.
  const udcExpr = cfg.udc
    ? `U=${cfg.udc}`
    : 'U=$(ls -1 /sys/class/udc 2>/dev/null | head -n1)';
  const gadgetExpr = cfg.gadget
    ? `G=/sys/kernel/config/usb_gadget/${cfg.gadget}`
    : 'G=$(ls -1d /sys/kernel/config/usb_gadget/*/ 2>/dev/null | head -n1)';
  const guard = '[ -n "$U" ] || { echo "no UDC under /sys/class/udc" >&2; exit 3; }';
  const readBefore = 'B=$(cat /sys/class/udc/$U/state 2>/dev/null)';
  const readAfter = 'A=$(cat /sys/class/udc/$U/state 2>/dev/null); echo "udc=$U before=$B after=$A"';

  const SCRIPTS: Record<Exclude<HostRecoveryAction, 'reboot'>, string> = {
    // R2 — kernel D+ pull-up toggle. The validated everyday fix.
    soft_connect: [
      udcExpr, guard, readBefore,
      'printf disconnect > /sys/class/udc/$U/soft_connect',
      'sleep 2',
      'printf connect > /sys/class/udc/$U/soft_connect',
      'sleep 5', readAfter,
    ].join('; '),
    // R3a — configfs unbind/rebind ("software replug") for the full-dead mode
    // soft_connect can't clear. NOT `systemctl restart kvmd-otg` (FileExistsError).
    'udc-rebind': [
      udcExpr, guard, gadgetExpr,
      '[ -n "$G" ] || { echo "no usb_gadget configfs dir" >&2; exit 4; }',
      readBefore,
      'echo "" > $G/UDC',
      'sleep 3',
      'echo $U > $G/UDC',
      'sleep 5',
      'A=$(cat /sys/class/udc/$U/state 2>/dev/null)',
      // ONE bounded retry — re-enumeration has real settle latency and a
      // first-attempt miss was observed live (4/5 first-call successes). This is
      // NOT the blind click-retry we deleted: that masked positioning error with
      // no ground truth, whereas here the kernel tells us whether the gadget
      // actually attached, and we re-check it. Exactly one extra attempt, with a
      // longer settle; if it still fails we report the truthful failure.
      '[ "$A" = "configured" ] || { R=retried; echo "" > $G/UDC 2>/dev/null; sleep 2; echo $U > $G/UDC; sleep 8; A=$(cat /sys/class/udc/$U/state 2>/dev/null); }',
      'echo "udc=$U before=$B after=$A retry=${R:-no}"',
    ].join('; '),
  };

  const sshArgs = (remote: string): string[] => [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    host as string,
    remote,
  ];

  return {
    configured: Boolean(host),
    async escalate(action) {
      if (!host) return { ok: false, message: 'ssh host recovery transport not configured' };
      if (action === 'reboot') {
        return {
          ok: false,
          message:
            'reboot is not supported over the SSH recovery transport (scoped to UDC actions); ' +
            'reboot the PiKVM manually or use the appliance recovery endpoint',
        };
      }
      const script = SCRIPTS[action];
      try {
        const { code, stdout, stderr } = await exec(sshArgs(script), { timeoutMs });
        const out = `${stdout}${stderr}`.trim().replace(/\s+/g, ' ');
        const after = /after=(\S+)/.exec(stdout)?.[1];
        if (code !== 0) {
          return { ok: false, message: `ssh ${action} failed (exit ${code}): ${out.slice(0, 200)}` };
        }
        // Ground truth, not exit status: the gadget must actually be attached.
        if (after !== 'configured') {
          return {
            ok: false,
            message:
              `ssh ${action} ran but the UDC did NOT come up — ${out.slice(0, 200)} ` +
              `(state must read "configured"; escalate to udc-rebind or check the cable/target)`,
          };
        }
        return { ok: true, message: `ssh ${action}: ${out.slice(0, 200)}` };
      } catch (err) {
        return { ok: false, message: `ssh ${action} failed: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * GROUND-TRUTH UDC state from the host recovery endpoint (M4). The kvmd HID
 * online flags lie; the kernel `/sys/class/udc/<udc>/state` node is the truth,
 * exposed read-only over the same authenticated loopback as the trigger.
 */
export interface UdcState {
  /** The bound gadget's UDC name (e.g. "fe980000.usb"), or null when none is bound. */
  udc: string | null;
  /** Raw kernel state: "configured" | "not attached" | "addressed" | … | "absent" (synthetic: no UDC). */
  state: string;
  /** Clean HID-live signal: state === "configured". */
  online: boolean;
}

/** The udc-state GET URL is the recovery base URL + "/udc-state". */
export function udcStateUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/udc-state`;
}

export interface UdcStateDeps {
  /** Injectable HTTP GET (tests). Returns the status + parsed JSON body. */
  get?: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;
}

/**
 * Build a reader for `GET {PIKVM_HID_RECOVERY_URL}/udc-state`. Returns the parsed
 * {@link UdcState} on HTTP 200, or **null** when the route is unconfigured /
 * unreachable / non-200 (so callers degrade: unknown ≠ down). Reuses the same
 * bearer token + TLS-verify as the recovery trigger.
 */
export function makeUdcStateReader(
  cfg: { url?: string; token?: string; verifySsl?: boolean },
  deps: UdcStateDeps = {},
): () => Promise<UdcState | null> {
  const base = cfg.url?.trim();
  if (!base) return async () => null; // endpoint not configured
  const url = udcStateUrl(base);
  const get =
    deps.get ??
    (async (u: string, headers: Record<string, string>) => {
      const dispatcher = new Agent({ connect: { rejectUnauthorized: cfg.verifySsl ?? false } });
      const res = await undiciFetch(u, { method: 'GET', headers, dispatcher });
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        /* non-JSON / empty */
      }
      return { status: res.status, body };
    });
  return async () => {
    try {
      const { status, body } = await get(url, cfg.token ? { authorization: `Bearer ${cfg.token}` } : {});
      if (status !== 200) return null;
      const b = body as { udc?: string | null; state?: unknown; online?: unknown };
      if (typeof b?.state !== 'string') return null;
      return { udc: b.udc ?? null, state: b.state, online: b.online === true };
    } catch {
      return null;
    }
  };
}

/**
 * GROUND-TRUTH UDC state over SSH — the STOCK-PiKVM counterpart to
 * {@link makeUdcStateReader}, so a box with no recovery endpoint still gets
 * KERNEL truth instead of the kvmd flags.
 *
 * Why this matters (live-verified 2026-07-30): on stock pikvm01 the flags read
 * `mouse=online, keyboard=offline` for a solid 30s while the gadget was
 * `configured` and clicking landed 4/4 — i.e. `keyboardOnline` alone is NOT a
 * usable HID up/down signal (the long-standing "the flags lie" finding, P3).
 * Anything diagnosing HID up/down must prefer this reader when it's available
 * and treat the flag heuristic strictly as a fallback.
 *
 * Read-only: it runs `cat /sys/class/udc/<udc>/state` for the discovered UDC and
 * nothing else. Returns null (never throws, never guesses) when unconfigured or
 * unreadable, so callers degrade to their fallback exactly as with HTTP.
 */
export function makeSshUdcStateReader(cfg: {
  /** `[user@]host`; unset ⇒ reader disabled (always null). */
  host?: string;
  /** Optional UDC override; default = the single entry under /sys/class/udc. */
  udc?: string;
  exec?: SshExec;
  timeoutMs?: number;
}): () => Promise<UdcState | null> {
  const host = cfg.host?.trim();
  if (!host) return async () => null;
  if (cfg.udc && !SAFE_SYSFS_NAME.test(cfg.udc)) {
    throw new Error(`makeSshUdcStateReader: refusing unsafe udc name ${JSON.stringify(cfg.udc)}`);
  }
  const exec = cfg.exec ?? defaultSshExec;
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const script = [
    cfg.udc ? `U=${cfg.udc}` : 'U=$(ls -1 /sys/class/udc 2>/dev/null | head -n1)',
    '[ -n "$U" ] || { echo "udc= state=absent"; exit 0; }',
    'echo "udc=$U state=$(cat /sys/class/udc/$U/state 2>/dev/null)"',
  ].join('; ');

  return async () => {
    try {
      const { code, stdout } = await exec(
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, script],
        { timeoutMs },
      );
      if (code !== 0) return null;
      const m = /udc=(\S*)\s+state=(.*)$/m.exec(stdout.trim());
      if (!m) return null;
      const state = m[2].trim();
      if (!state) return null;
      return { udc: m[1] || null, state, online: state === 'configured' };
    } catch {
      return null;
    }
  };
}
