/**
 * Unit tests for the HID-recovery ladder (src/pikvm/hid-recovery.ts):
 * presence gate (R0), the cheap flag trigger, behavioral verification,
 * the soft-connect/udc-rebind/reboot escalation, the R4 human-terminal,
 * and the HTTP trigger's unconfigured behaviour. Pure/injected — no PiKVM.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  isHidBroken,
  checkTargetPresent,
  makeBehavioralVerifier,
  waitForRecovery,
  recoverHid,
  makeHttpRecoveryTrigger,
  type HidOnlineState,
  type HidRecoveryClient,
  type HidVerifier,
  type RecoveryTrigger,
} from '../hid-recovery.js';

const ONLINE: HidOnlineState = { online: true, mouseOnline: true, keyboardOnline: true };
const BROKEN: HidOnlineState = { online: true, mouseOnline: false, keyboardOnline: false };
const IMG = Buffer.from('fake-image-bytes');

const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

describe('isHidBroken (cheap trigger)', () => {
  it('is false only when mouse AND keyboard flags are online', () => {
    expect(isHidBroken(ONLINE)).toBe(false);
    expect(isHidBroken(BROKEN)).toBe(true);
    expect(isHidBroken({ online: true, mouseOnline: true, keyboardOnline: false })).toBe(true);
  });
});

describe('checkTargetPresent (R0)', () => {
  it('is present when a screenshot returns a non-empty image', async () => {
    expect(await checkTargetPresent({ screenshot: async () => ({ buffer: IMG }) })).toBe(true);
  });
  it('is absent when the screenshot throws (target asleep / no HDMI)', async () => {
    expect(await checkTargetPresent({ screenshot: async () => { throw new Error('503'); } })).toBe(false);
  });
  it('is absent on an empty buffer', async () => {
    expect(await checkTargetPresent({ screenshot: async () => ({ buffer: Buffer.alloc(0) }) })).toBe(false);
  });
});

describe('makeBehavioralVerifier', () => {
  const solid = (v: number) => sharp(Buffer.alloc(8 * 8 * 3, v), { raw: { width: 8, height: 8, channels: 3 } }).jpeg().toBuffer();

  it('reports healthy when the emit changes the screen', async () => {
    let n = 0;
    const frames = [await solid(0), await solid(255)]; // before, after differ
    const client = {
      screenshot: async () => ({ buffer: frames[Math.min(n++, 1)] }),
      mouseMoveRelative: async () => {},
    };
    const v = await makeBehavioralVerifier(client, { settleMs: 0 }, fakeClock()).verify();
    expect(v.healthy).toBe(true);
  });

  it('reports unhealthy when the emit changes nothing (HID not driving input)', async () => {
    const same = await solid(120);
    const client = { screenshot: async () => ({ buffer: same }), mouseMoveRelative: async () => {} };
    const v = await makeBehavioralVerifier(client, { settleMs: 0 }, fakeClock()).verify();
    expect(v.healthy).toBe(false);
  });
});

describe('waitForRecovery', () => {
  const verifier = (ref: { healthy: boolean }): HidVerifier => ({ verify: async () => ({ healthy: ref.healthy, detail: '' }) });

  it('returns as soon as the verifier is healthy', async () => {
    const r = await waitForRecovery(verifier({ healthy: true }), { timeoutMs: 100, intervalMs: 10 }, fakeClock());
    expect(r.recovered).toBe(true);
    expect(r.polls).toBe(1);
  });
  it('times out when never healthy', async () => {
    const r = await waitForRecovery(verifier({ healthy: false }), { timeoutMs: 5000, intervalMs: 1000 }, fakeClock());
    expect(r.recovered).toBe(false);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(5000);
  });
});

/** Controllable rig: `healthy` drives the behavioral verifier; actions flip it. */
function makeRig(opts: { hid?: HidOnlineState; present?: boolean } = {}) {
  const ref = { healthy: false };
  const hid = opts.hid ?? BROKEN;
  const client = (onSoftReset?: () => void): HidRecoveryClient => ({
    getHidProfile: async () => hid,
    resetHid: async () => { onSoftReset?.(); return hid; },
    screenshot: async () => {
      if (opts.present === false) throw new Error('503 no HDMI');
      return { buffer: IMG };
    },
    mouseMoveRelative: async () => {},
  });
  const verifier: HidVerifier = { verify: async () => ({ healthy: ref.healthy, detail: ref.healthy ? 'cursor moved' : 'no change' }) };
  const trigger = (configured: boolean, onAction?: (a: string) => void): RecoveryTrigger => ({
    configured,
    escalate: async (action) => { onAction?.(action); return { ok: true, message: `host did ${action}` }; },
  });
  return { ref, client, verifier, trigger };
}

const NO_WAIT = { sleep: async () => {}, now: () => 0 };

describe('recoverHid orchestrator', () => {
  it('R0: stops and requires human action when the target is absent', async () => {
    const { client, verifier, trigger } = makeRig({ present: false });
    const r = await recoverHid(client(), trigger(true), verifier, { maxRung: 4, allowReboot: true }, NO_WAIT);
    expect(r.targetPresent).toBe(false);
    expect(r.recovered).toBe(false);
    expect(r.attempts).toHaveLength(0);
    expect(r.humanActionRequired).toMatch(/wake or power on/i);
  });

  it('no-ops when flags say ok AND behavioral verify is healthy', async () => {
    const { ref, client, verifier, trigger } = makeRig({ hid: ONLINE });
    ref.healthy = true;
    const r = await recoverHid(client(), trigger(false), verifier, {}, NO_WAIT);
    expect(r.recovered).toBe(true);
    expect(r.attempts).toHaveLength(0);
  });

  it('recovers at R1 when the soft reset restores behavioral input', async () => {
    const { ref, client, verifier, trigger } = makeRig();
    const r = await recoverHid(client(() => { ref.healthy = true; }), trigger(false), verifier, { maxRung: 1 }, NO_WAIT);
    expect(r.recovered).toBe(true);
    expect(r.attempts).toEqual([expect.objectContaining({ rung: 'R1', action: 'soft-reset', recovered: true })]);
  });

  it('recovers at R2 soft-connect via the host trigger', async () => {
    const { ref, client, verifier, trigger } = makeRig();
    const r = await recoverHid(
      client(),
      trigger(true, (a) => { if (a === 'soft-connect') ref.healthy = true; }),
      verifier,
      { maxRung: 2, hostWaitMs: 0 },
      NO_WAIT,
    );
    expect(r.recovered).toBe(true);
    expect(r.attempts.map((a) => a.rung)).toEqual(['R1', 'R2']);
    expect(r.attempts[1]).toMatchObject({ rung: 'R2', action: 'soft-connect', performed: true, recovered: true });
  });

  it('reports host rungs UNAVAILABLE and escalates to R4 when the trigger is not configured', async () => {
    const { client, verifier, trigger } = makeRig();
    const r = await recoverHid(client(), trigger(false), verifier, { maxRung: 3, hostWaitMs: 0 }, NO_WAIT);
    expect(r.recovered).toBe(false);
    expect(r.attempts.map((a) => a.rung)).toEqual(['R1', 'R2', 'R3a']);
    expect(r.attempts[1]).toMatchObject({ performed: false });
    expect(r.attempts[1].detail).toMatch(/not configured/i);
    expect(r.humanActionRequired).toMatch(/re-plug the target/i);
  });

  it('skips reboot unless allowReboot, then reboots and recovers when allowed', async () => {
    const skip = makeRig();
    const rSkip = await recoverHid(skip.client(), skip.trigger(true), skip.verifier, { maxRung: 4, hostWaitMs: 0 }, NO_WAIT);
    expect(rSkip.attempts.find((a) => a.rung === 'R3b')).toMatchObject({ performed: false });
    expect(rSkip.attempts.find((a) => a.rung === 'R3b')?.detail).toMatch(/allowReboot/i);

    const boot = makeRig();
    const rBoot = await recoverHid(
      boot.client(),
      boot.trigger(true, (a) => { if (a === 'reboot') boot.ref.healthy = true; }),
      boot.verifier,
      { maxRung: 4, allowReboot: true, hostWaitMs: 0, rebootWaitMs: 0 },
      NO_WAIT,
    );
    expect(rBoot.recovered).toBe(true);
    expect(rBoot.attempts.find((a) => a.rung === 'R3b')).toMatchObject({ action: 'reboot', performed: true, recovered: true });
  });
});

describe('makeHttpRecoveryTrigger', () => {
  it('is unconfigured (and reports so) when no url is given', async () => {
    const t = makeHttpRecoveryTrigger({});
    expect(t.configured).toBe(false);
    expect((await t.escalate('soft-connect')).ok).toBe(false);
  });
  it('is configured when a url is given', () => {
    expect(makeHttpRecoveryTrigger({ url: 'http://127.0.0.1:9999/recover' }).configured).toBe(true);
  });
});
