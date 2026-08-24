/**
 * Unit tests for the HID-recovery ladder (src/pikvm/hid-recovery.ts):
 * presence gate (R0), the cheap flag trigger, behavioral verification,
 * the soft_connect/udc-rebind/reboot escalation, the R4 human-terminal,
 * and the HTTP trigger's unconfigured behaviour. Pure/injected — no PiKVM.
 */
import { describe, expect, it } from 'vitest';
import {
  flagsSuggestPartialHidLoss,
  checkTargetPresent,
  makeBehavioralVerifier,
  waitForRecovery,
  recoverHid,
  makeHttpRecoveryTrigger,
  makeUdcStateReader,
  udcStateUrl,
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

describe('flagsSuggestPartialHidLoss (cheap trigger)', () => {
  it('is false only when mouse AND keyboard flags are online', () => {
    expect(flagsSuggestPartialHidLoss(ONLINE)).toBe(false);
    expect(flagsSuggestPartialHidLoss(BROKEN)).toBe(true);
    expect(flagsSuggestPartialHidLoss({ online: true, mouseOnline: true, keyboardOnline: false })).toBe(true);
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

describe('makeBehavioralVerifier (fix-c: pointer-localizable, not bare screen diff)', () => {
  const blank = Buffer.from('frame');
  const client = { screenshot: async () => ({ buffer: blank }), mouseMoveRelative: async () => {} };
  // `locate` is called twice per verify: [before-emit, after-emit].
  const scripted = (positions: Array<{ x: number; y: number } | null>) => {
    let n = 0;
    return async () => positions[Math.min(n++, positions.length - 1)];
  };
  const run = (positions: Array<{ x: number; y: number } | null>) =>
    makeBehavioralVerifier(client, { settleMs: 0 }, { ...fakeClock(), locate: scripted(positions) }).verify();

  it('healthy: the cursor is localizable AND moved with the emit', async () => {
    const v = await run([{ x: 100, y: 100 }, { x: 140, y: 100 }]); // moved 40px
    expect(v.healthy).toBe(true);
    expect(v.detail).toMatch(/moved the cursor/);
  });

  it('UNHEALTHY: cursor localizable but did NOT move — the clock-tick false-positive the old check let through', async () => {
    const v = await run([{ x: 100, y: 100 }, { x: 101, y: 100 }]); // 1px < minMovePx
    expect(v.healthy).toBe(false);
    expect(v.detail).toMatch(/did NOT move/);
  });

  it('UNHEALTHY: no localizable cursor after the emit — pointer not rendering', async () => {
    const v = await run([{ x: 100, y: 100 }, null]);
    expect(v.healthy).toBe(false);
    expect(v.detail).toMatch(/NO localizable cursor/);
  });

  it('healthy: cursor not localizable before but the emit rendered/moved it into view', async () => {
    const v = await run([null, { x: 120, y: 90 }]);
    expect(v.healthy).toBe(true);
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

  it('recovers at R2 soft_connect via the host trigger', async () => {
    const { ref, client, verifier, trigger } = makeRig();
    const r = await recoverHid(
      client(),
      trigger(true, (a) => { if (a === 'soft_connect') ref.healthy = true; }),
      verifier,
      { maxRung: 2, hostWaitMs: 0 },
      NO_WAIT,
    );
    expect(r.recovered).toBe(true);
    expect(r.attempts.map((a) => a.rung)).toEqual(['R1', 'R2']);
    expect(r.attempts[1]).toMatchObject({ rung: 'R2', action: 'soft_connect', performed: true, recovered: true });
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
    expect((await t.escalate('soft_connect')).ok).toBe(false);
  });
  it('is configured when a url is given', () => {
    expect(makeHttpRecoveryTrigger({ url: 'http://127.0.0.1:9999/recover' }).configured).toBe(true);
  });
});

describe('recoverHid skipSoftReset (M0 usb_reconnect)', () => {
  it('starts at soft_connect (skips the no-op R1) when skipSoftReset is set', async () => {
    const { ref, client, verifier, trigger } = makeRig();
    const r = await recoverHid(
      client(),
      trigger(true, (a) => { if (a === 'soft_connect') ref.healthy = true; }),
      verifier,
      { maxRung: 3, allowReboot: false, skipSoftReset: true, hostWaitMs: 0 },
      NO_WAIT,
    );
    expect(r.recovered).toBe(true);
    // No R1 soft-reset attempt — the first rung is R2 soft_connect.
    expect(r.attempts.map((a) => a.rung)).toEqual(['R2']);
    expect(r.attempts[0]).toMatchObject({ rung: 'R2', action: 'soft_connect' });
  });
});

describe('udcStateUrl', () => {
  it('appends /udc-state to the base (trimming trailing slashes)', () => {
    expect(udcStateUrl('http://127.0.0.1:8082/hid-recovery')).toBe('http://127.0.0.1:8082/hid-recovery/udc-state');
    expect(udcStateUrl('http://127.0.0.1:8082/hid-recovery/')).toBe('http://127.0.0.1:8082/hid-recovery/udc-state');
  });
});

describe('makeUdcStateReader', () => {
  const base = 'http://127.0.0.1:8082/hid-recovery';

  it('returns null when no url is configured', async () => {
    expect(await makeUdcStateReader({})()).toBeNull();
  });

  it('parses a 200 body into {udc,state,online}', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const reader = makeUdcStateReader(
      { url: base, token: 'tok' },
      {
        get: async (url, headers) => {
          seenUrl = url;
          seenAuth = headers.authorization ?? '';
          return { status: 200, body: { udc: 'fe980000.usb', state: 'configured', online: true } };
        },
      },
    );
    expect(await reader()).toEqual({ udc: 'fe980000.usb', state: 'configured', online: true });
    expect(seenUrl).toBe(`${base}/udc-state`);
    expect(seenAuth).toBe('Bearer tok');
  });

  it('carries the raw state string (no gadget → absent/false)', async () => {
    const reader = makeUdcStateReader(
      { url: base },
      { get: async () => ({ status: 200, body: { udc: null, state: 'absent', online: false } }) },
    );
    expect(await reader()).toEqual({ udc: null, state: 'absent', online: false });
  });

  it('returns null on non-200 (401/500), a bad body, or a thrown request', async () => {
    expect(await makeUdcStateReader({ url: base }, { get: async () => ({ status: 401, body: { ok: false } }) })()).toBeNull();
    expect(await makeUdcStateReader({ url: base }, { get: async () => ({ status: 500, body: {} }) })()).toBeNull();
    expect(await makeUdcStateReader({ url: base }, { get: async () => ({ status: 200, body: { udc: 'x' } }) })()).toBeNull(); // no state
    expect(await makeUdcStateReader({ url: base }, { get: async () => { throw new Error('conn refused'); } })()).toBeNull();
  });
});
