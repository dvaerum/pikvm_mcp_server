/**
 * Unit tests for the HID-recovery ladder (src/pikvm/hid-recovery.ts): detection,
 * poll-until-online, the escalation orchestrator, and the HTTP trigger's
 * unconfigured behaviour. All pure/injected — no PiKVM, no real waiting.
 */
import { describe, expect, it } from 'vitest';
import {
  isHidBroken,
  waitForHidOnline,
  recoverHid,
  makeHttpRecoveryTrigger,
  type HidOnlineState,
  type HidRecoveryClient,
  type RecoveryTrigger,
} from '../hid-recovery.js';

const ONLINE: HidOnlineState = { online: true, mouseOnline: true, keyboardOnline: true };
const BROKEN: HidOnlineState = { online: true, mouseOnline: false, keyboardOnline: false };

describe('isHidBroken', () => {
  it('is false only when mouse AND keyboard are online', () => {
    expect(isHidBroken(ONLINE)).toBe(false);
    expect(isHidBroken(BROKEN)).toBe(true);
    expect(isHidBroken({ online: true, mouseOnline: true, keyboardOnline: false })).toBe(true);
    expect(isHidBroken({ online: true, mouseOnline: false, keyboardOnline: true })).toBe(true);
  });
});

describe('waitForHidOnline', () => {
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('returns recovered as soon as the HID is online', async () => {
    const r = await waitForHidOnline(async () => ONLINE, { timeoutMs: 100, intervalMs: 10 }, fakeClock());
    expect(r.recovered).toBe(true);
    expect(r.polls).toBe(1);
  });

  it('keeps waiting through a null probe (mid-reboot) then recovers', async () => {
    let n = 0;
    const probe = async (): Promise<HidOnlineState | null> => (n++ < 3 ? null : ONLINE);
    const r = await waitForHidOnline(probe, { timeoutMs: 100_000, intervalMs: 1000 }, fakeClock());
    expect(r.recovered).toBe(true);
    expect(r.polls).toBe(4); // 3 nulls then online
  });

  it('times out when the HID never comes back', async () => {
    const r = await waitForHidOnline(async () => BROKEN, { timeoutMs: 5000, intervalMs: 1000 }, fakeClock());
    expect(r.recovered).toBe(false);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(5000);
  });

  it('treats a throwing probe as "keep waiting"', async () => {
    let n = 0;
    const probe = async (): Promise<HidOnlineState | null> => {
      if (n++ < 2) throw new Error('connection refused');
      return ONLINE;
    };
    const r = await waitForHidOnline(probe, { timeoutMs: 100_000, intervalMs: 1000 }, fakeClock());
    expect(r.recovered).toBe(true);
  });
});

/** A controllable fake rig: getHidProfile reports `state`; resetHid/escalate can flip it. */
function makeRig(initial: HidOnlineState) {
  const rig = { state: initial };
  const client = (onReset?: () => void): HidRecoveryClient => ({
    getHidProfile: async () => rig.state,
    resetHid: async () => {
      onReset?.();
      return rig.state;
    },
  });
  const trigger = (configured: boolean, onEscalate?: (a: string) => void): RecoveryTrigger => ({
    configured,
    escalate: async (action) => {
      onEscalate?.(action);
      return { ok: true, message: `host did ${action}` };
    },
  });
  return { rig, client, trigger };
}

const NO_WAIT = { sleep: async () => {}, now: () => 0 };

describe('recoverHid orchestrator', () => {
  it('no-ops when the HID is already online', async () => {
    const { client, trigger } = makeRig(ONLINE);
    const r = await recoverHid(client(), trigger(false), {}, NO_WAIT);
    expect(r.initiallyBroken).toBe(false);
    expect(r.recovered).toBe(true);
    expect(r.attempts).toHaveLength(0);
  });

  it('recovers at rung 1 when the soft reset works', async () => {
    const { rig, client, trigger } = makeRig(BROKEN);
    const r = await recoverHid(client(() => { rig.state = ONLINE; }), trigger(false), {}, NO_WAIT);
    expect(r.recovered).toBe(true);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ rung: 1, action: 'soft-reset', recovered: true });
  });

  it('reports rung 2 UNAVAILABLE when the trigger is not configured (nixos not wired)', async () => {
    const { client, trigger } = makeRig(BROKEN);
    const r = await recoverHid(client(), trigger(false), { maxRung: 2 }, NO_WAIT);
    expect(r.recovered).toBe(false);
    expect(r.attempts.map((a) => a.rung)).toEqual([1, 2]);
    expect(r.attempts[1]).toMatchObject({ rung: 2, performed: false, recovered: false });
    expect(r.attempts[1].detail).toMatch(/not configured/i);
  });

  it('escalates to rung 2 UDC rebind and recovers when the host trigger fixes it', async () => {
    const { rig, client, trigger } = makeRig(BROKEN);
    const r = await recoverHid(
      client(),
      trigger(true, () => { rig.state = ONLINE; }),
      { maxRung: 2, rebindWaitMs: 0 },
      NO_WAIT,
    );
    expect(r.recovered).toBe(true);
    expect(r.attempts.map((a) => a.rung)).toEqual([1, 2]);
    expect(r.attempts[1]).toMatchObject({ rung: 2, action: 'udc-rebind', performed: true, recovered: true });
  });

  it('skips rung 3 reboot unless allowReboot is set', async () => {
    const { client, trigger } = makeRig(BROKEN);
    const r = await recoverHid(client(), trigger(true), { maxRung: 3, rebindWaitMs: 0 }, NO_WAIT);
    const rung3 = r.attempts.find((a) => a.rung === 3);
    expect(rung3).toMatchObject({ performed: false, recovered: false });
    expect(rung3?.detail).toMatch(/allowReboot/i);
  });

  it('reboots at rung 3 (when allowed + configured) and recovers', async () => {
    const { rig, client, trigger } = makeRig(BROKEN);
    const r = await recoverHid(
      client(),
      trigger(true, (a) => { if (a === 'reboot') rig.state = ONLINE; }),
      { maxRung: 3, allowReboot: true, rebindWaitMs: 0, rebootWaitMs: 0 },
      NO_WAIT,
    );
    expect(r.recovered).toBe(true);
    const rung3 = r.attempts.find((a) => a.rung === 3);
    expect(rung3).toMatchObject({ rung: 3, action: 'reboot', performed: true, recovered: true });
  });
});

describe('makeHttpRecoveryTrigger', () => {
  it('is unconfigured (and reports so) when no url is given', async () => {
    const t = makeHttpRecoveryTrigger({});
    expect(t.configured).toBe(false);
    const r = await t.escalate('udc-rebind');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not configured/i);
  });

  it('is configured when a url is given', () => {
    expect(makeHttpRecoveryTrigger({ url: 'http://127.0.0.1:9999/recover' }).configured).toBe(true);
  });
});
