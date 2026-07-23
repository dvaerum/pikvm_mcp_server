/**
 * HID-recovery ladder — detection + escalation for when the emulated USB HID
 * gadget drops offline (mouse/keyboard stop working while video is fine).
 *
 * Canonical runbook: docs/runbooks/hid-recovery.md.
 *
 * Failure signature (observed live this project): after idle, `/hid` reports
 * `online:true` but `mouseOnline:false` AND `keyboardOnline:false`; screenshots
 * still work. That's a broken HID gadget.
 *
 * The ladder, honestly ranked by what actually recovers this failure:
 *   - RUNG 1 — soft reset (`resetHid`, POST /hid/reset [+ set_connected toggle]).
 *     Cheap FIRST TRY, but known NOT to reliably recover a controller-level drop:
 *     a soft reset can't force the host to re-enumerate, and the OTG
 *     `set_connected` control is a no-op on our unit (client.ts:796-803). This is
 *     entirely MCP-side and already exists as `pikvm_hid_reset`.
 *   - RUNG 2 — UDC rebind / `kvmd-otg` restart. Tears down + recreates the gadget
 *     at the controller level (configfs UDC unbind→bind, or `systemctl restart
 *     kvmd-otg`). UNTESTED on this unit — the candidate for a no-reboot fix. This
 *     is a PRIVILEGED HOST operation the unprivileged MCP service cannot do
 *     itself; it goes through the {@link RecoveryTrigger} the nixos side provides.
 *   - RUNG 3 — reboot the PiKVM device. The currently-known-reliable fix. Also a
 *     privileged host op via the trigger; gated behind an explicit opt-in because
 *     it takes the whole appliance (including this server) down ~30-90s.
 *
 * This module is the MCP-side scaffolding: detection, a client-side
 * poll-until-online wait, the escalation orchestrator, and the HTTP client for
 * the host trigger. The rung-2/3 HOST mechanisms are provided by pikvm-nixos
 * against the {@link RecoveryTrigger} contract (see the runbook's "Trigger
 * interface" section); until they are wired, rungs 2/3 report unavailable.
 */
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** The subset of HID state the ladder reasons about. */
export interface HidOnlineState {
  online: boolean;
  mouseOnline: boolean;
  keyboardOnline: boolean;
}

/**
 * The HID gadget is "broken" when it is NOT fully usable — i.e. mouse and
 * keyboard are not both online. Recovery targets `mouseOnline && keyboardOnline`.
 */
export function isHidBroken(s: HidOnlineState): boolean {
  return !(s.mouseOnline && s.keyboardOnline);
}

/** The privileged host recovery actions (rung 2/3), performed via the trigger. */
export type HostRecoveryAction = 'udc-rebind' | 'reboot';
export type RecoveryAction = 'soft-reset' | HostRecoveryAction;
export type Rung = 1 | 2 | 3;

/**
 * The MCP↔nixos trigger contract. The unprivileged MCP service (DynamicUser)
 * cannot rebind a UDC or reboot the host, so it delegates those to a privileged
 * host helper that pikvm-nixos provides (see runbook). `configured` is false when
 * no helper is wired, so the orchestrator can report rungs 2/3 as unavailable
 * instead of failing opaquely.
 */
export interface RecoveryTrigger {
  readonly configured: boolean;
  escalate(action: HostRecoveryAction): Promise<{ ok: boolean; message: string }>;
}

/** The client surface the ladder needs (satisfied by PiKVMClient). */
export interface HidRecoveryClient {
  getHidProfile(): Promise<HidOnlineState>;
  resetHid(opts: { reconnectUsb?: boolean; settleMs?: number }): Promise<HidOnlineState>;
}

export interface WaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `probe` until the HID is fully online or the timeout elapses. `probe`
 * returns null when the endpoint is not answering yet (e.g. mid-reboot) — that
 * counts as "not recovered, keep waiting", so this doubles as the reboot
 * wait-for-online. Injectable clock/sleep keep it unit-testable.
 */
export async function waitForHidOnline(
  probe: () => Promise<HidOnlineState | null>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
  deps: WaitDeps = {},
): Promise<{ recovered: boolean; elapsedMs: number; polls: number; last: HidOnlineState | null }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const start = now();
  let polls = 0;
  let last: HidOnlineState | null = null;
  for (;;) {
    let state: HidOnlineState | null = null;
    try {
      state = await probe();
    } catch {
      state = null; // endpoint down (e.g. mid-reboot) — treat as "keep waiting"
    }
    polls += 1;
    last = state;
    if (state && !isHidBroken(state)) {
      return { recovered: true, elapsedMs: now() - start, polls, last };
    }
    if (now() - start >= timeoutMs) {
      return { recovered: false, elapsedMs: now() - start, polls, last };
    }
    await sleep(intervalMs);
  }
}

export interface RungAttempt {
  rung: Rung;
  action: RecoveryAction;
  /** Whether the backing action was performed (rung 2/3: trigger available + accepted). */
  performed: boolean;
  /** Whether the HID was fully online after this rung. */
  recovered: boolean;
  detail: string;
}

export interface RecoverResult {
  initiallyBroken: boolean;
  recovered: boolean;
  attempts: RungAttempt[];
  finalHid: HidOnlineState;
}

export interface RecoverOpts {
  /** Highest rung to attempt (1=soft only, 2=+UDC rebind, 3=+reboot). Default 2. */
  maxRung?: Rung;
  /** Rung 3 (reboot) is destructive (whole appliance ~30-90s) — must be opted in. */
  allowReboot?: boolean;
  /** Settle after the soft reset before re-checking (ms). Default 2000. */
  softSettleMs?: number;
  /** Wait budget for the post-rung-2 online check (ms). Default 15000. */
  rebindWaitMs?: number;
  /** Wait budget for the post-reboot online check (ms). Default 120000. */
  rebootWaitMs?: number;
}

/**
 * Detect a broken HID and escalate up the ladder until it recovers or the
 * allowed rungs are exhausted. Verifies `mouseOnline && keyboardOnline` after
 * each rung. Pure orchestration over the injected client + trigger, so it is
 * unit-testable with fakes.
 */
export async function recoverHid(
  client: HidRecoveryClient,
  trigger: RecoveryTrigger,
  opts: RecoverOpts = {},
  deps: WaitDeps = {},
): Promise<RecoverResult> {
  const maxRung = opts.maxRung ?? 2;
  const attempts: RungAttempt[] = [];

  const initial = await client.getHidProfile();
  if (!isHidBroken(initial)) {
    return { initiallyBroken: false, recovered: true, attempts, finalHid: initial };
  }

  // RUNG 1 — soft reset (cheap first try; often does NOT fix a controller drop).
  const afterSoft = await client.resetHid({ reconnectUsb: true, settleMs: opts.softSettleMs ?? 2000 });
  const softOk = !isHidBroken(afterSoft);
  attempts.push({
    rung: 1,
    action: 'soft-reset',
    performed: true,
    recovered: softOk,
    detail: softOk
      ? 'soft reset recovered the HID'
      : 'soft reset did not recover (expected for a controller-level drop — set_connected is a no-op on this unit and cannot force host re-enumeration)',
  });
  if (softOk) return { initiallyBroken: true, recovered: true, attempts, finalHid: afterSoft };

  // RUNG 2 — UDC rebind (host, via trigger). Untested no-reboot candidate.
  if (maxRung >= 2) {
    if (!trigger.configured) {
      attempts.push({
        rung: 2,
        action: 'udc-rebind',
        performed: false,
        recovered: false,
        detail: 'UDC rebind unavailable: the host recovery trigger is not configured (pikvm-nixos must provide it — see docs/runbooks/hid-recovery.md)',
      });
    } else {
      const res = await trigger.escalate('udc-rebind');
      const wait = await waitForHidOnline(() => client.getHidProfile(), { timeoutMs: opts.rebindWaitMs ?? 15_000 }, deps);
      attempts.push({
        rung: 2,
        action: 'udc-rebind',
        performed: res.ok,
        recovered: wait.recovered,
        detail: `${res.message}${wait.recovered ? ' — HID online' : ' — HID still offline after rebind (UNVERIFIED on this unit; may need rung 3)'}`,
      });
      if (wait.recovered && wait.last) return { initiallyBroken: true, recovered: true, attempts, finalHid: wait.last };
    }
  }

  // RUNG 3 — reboot (host, via trigger). Known-reliable, but destructive → opt-in.
  if (maxRung >= 3) {
    if (!opts.allowReboot) {
      attempts.push({ rung: 3, action: 'reboot', performed: false, recovered: false, detail: 'reboot skipped (allowReboot=false) — the known-reliable fix, but it takes the appliance down ~30-90s; re-run with allowReboot to use it' });
    } else if (!trigger.configured) {
      attempts.push({ rung: 3, action: 'reboot', performed: false, recovered: false, detail: 'reboot unavailable: the host recovery trigger is not configured (pikvm-nixos must provide it)' });
    } else {
      const res = await trigger.escalate('reboot');
      const wait = await waitForHidOnline(() => client.getHidProfile(), { timeoutMs: opts.rebootWaitMs ?? 120_000 }, deps);
      attempts.push({
        rung: 3,
        action: 'reboot',
        performed: res.ok,
        recovered: wait.recovered,
        detail: `${res.message}${wait.recovered ? ' — HID online after reboot' : ' — HID still offline after reboot window elapsed'}`,
      });
      if (wait.recovered && wait.last) return { initiallyBroken: true, recovered: true, attempts, finalHid: wait.last };
    }
  }

  const finalHid = await client.getHidProfile().catch(() => attempts.length ? initial : initial);
  return { initiallyBroken: true, recovered: !isHidBroken(finalHid), attempts, finalHid };
}

/**
 * HTTP client for the host recovery trigger (rung 2/3). POSTs
 * `{ action }` to the nixos-provided privileged helper at `url` with a bearer
 * token. This is the MCP end of the {@link RecoveryTrigger} contract; the helper
 * itself is provided by pikvm-nixos. When `url` is unset the trigger is
 * `configured:false` and the orchestrator reports rungs 2/3 as unavailable.
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
        // Reboot legitimately drops the connection mid-response; a 2xx OR a
        // connection reset after sending both count as "initiated".
        const ok = res.status >= 200 && res.status < 300;
        let message = `host trigger ${action}: HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body?.message) message = body.message;
        } catch {
          /* no/again-drained body */
        }
        return { ok, message };
      } catch (err) {
        if (action === 'reboot') {
          // Connection dropped because the host is going down — that's success.
          return { ok: true, message: `reboot initiated (host connection dropped: ${(err as Error).message})` };
        }
        return { ok: false, message: `host trigger ${action} failed: ${(err as Error).message}` };
      }
    },
  };
}
