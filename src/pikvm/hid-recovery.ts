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
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { decodeScreenshot, diffScreenshotsDecoded } from './cursor-detect.js';

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
export type HostRecoveryAction = 'soft-connect' | 'udc-rebind' | 'reboot';
/** Every ladder step that performs an action (R1 is MCP-native, the rest host). */
export type LadderAction = 'soft-reset' | HostRecoveryAction;

/** Ordered escalation. maxRung 1..4 slices this (1=soft-reset … 4=reboot). */
const LADDER: LadderAction[] = ['soft-reset', 'soft-connect', 'udc-rebind', 'reboot'];

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

/**
 * Default behavioral verifier: emit a mouse move and check the screen actually
 * changed (a working HID moves the cursor → pixels change). Injectable so the
 * orchestrator is unit-testable with a fake. NB this is a starting heuristic;
 * ambient screen motion can false-positive — live tuning expected (mirrors the
 * desktop-e2e residuals). Returns healthy when the post-emit frame differs from
 * the pre-emit frame.
 */
export function makeBehavioralVerifier(
  client: Pick<HidRecoveryClient, 'screenshot' | 'mouseMoveRelative'>,
  opts: { emitDx?: number; settleMs?: number } = {},
  deps: WaitDeps = {},
): HidVerifier {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emitDx = opts.emitDx ?? 40;
  const settleMs = opts.settleMs ?? 300;
  return {
    async verify() {
      try {
        const before = await decodeScreenshot((await client.screenshot()).buffer);
        // Emit a there-and-back move so a working HID visibly nudges the cursor
        // without permanently displacing it.
        await client.mouseMoveRelative(emitDx, 0);
        await sleep(settleMs);
        const after = await decodeScreenshot((await client.screenshot()).buffer);
        await client.mouseMoveRelative(-emitDx, 0);
        const changed = diffScreenshotsDecoded(before, after).length > 0;
        return changed
          ? { healthy: true, detail: 'mouse emit moved the cursor (screen changed) — HID working' }
          : { healthy: false, detail: 'mouse emit produced no screen change — HID not driving input' };
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
  'soft-connect': 'R2',
  'udc-rebind': 'R3a',
  reboot: 'R3b',
};

export interface RecoverOpts {
  /** How far to escalate: 1=soft-reset, 2=+soft-connect, 3=+udc-rebind, 4=+reboot. Default 3. */
  maxRung?: 1 | 2 | 3 | 4;
  /** R3b reboot is destructive (whole appliance ~30-90s) — must be opted in. */
  allowReboot?: boolean;
  softSettleMs?: number;
  /** Post-host-action recovery wait (ms). Default 15000 for R2/R3a. */
  hostWaitMs?: number;
  /** Post-reboot recovery wait (ms). Default 120000. */
  rebootWaitMs?: number;
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

  const steps = LADDER.slice(0, maxRung);
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
