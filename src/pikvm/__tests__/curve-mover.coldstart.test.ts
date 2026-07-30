import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isCurveShotCold,
  resetCurveMoverColdStartForTest,
  planWakeEmits,
  WAKE_EMIT_COUNT,
  COLD_START_STALE_MS,
  moveByCurveOneShot,
} from '../curve-mover.js';
import type { PiKVMClient } from '../client.js';

// Fix (e): a wake-settle before the FIRST curve shot after a relaunch/foreground
// transition. The first shot computed from a cold pointer lands ~25.3px (just over
// maxResidualPx=25); 2nd/3rd land 1–8px. We warm the pointer with the SAME net-zero
// jiggle as the faded-cursor wake, re-detect, then shoot — WITHOUT touching the gate.

describe('isCurveShotCold — the cold-start / staleness predicate', () => {
  it('null (fresh module state = relaunch) ⇒ cold', () => {
    expect(isCurveShotCold(null, 1_000_000, COLD_START_STALE_MS)).toBe(true);
  });

  it('a recent warm shot ⇒ NOT cold (2nd/3rd click stays warm)', () => {
    const now = 1_000_000;
    expect(isCurveShotCold(now - 500, now, COLD_START_STALE_MS)).toBe(false);
    expect(isCurveShotCold(now - (COLD_START_STALE_MS - 1), now, COLD_START_STALE_MS)).toBe(false);
  });

  it('a stale gap beyond the threshold (idle / foreground return) ⇒ cold', () => {
    const now = 1_000_000;
    expect(isCurveShotCold(now - (COLD_START_STALE_MS + 1), now, COLD_START_STALE_MS)).toBe(true);
  });
});

// ── Integration: drive moveByCurveOneShot with injected detect+clock seams so we
//    never touch onnxruntime, and a recording stub client so we can see the emits.

class RecordingClient {
  emits: Array<[number, number]> = [];
  belief = {} as unknown;
  async getResolution(): Promise<{ width: number; height: number }> {
    return { width: 1920, height: 1080 };
  }
  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    return { buffer: Buffer.from('frame'), screenshotWidth: 1920, screenshotHeight: 1080 };
  }
  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.emits.push([dx, dy]);
  }
}

/** Does the emit log START with the net-zero wake jiggle (WAKE_EMIT_COUNT emits)? */
function startsWithWake(emits: Array<[number, number]>): boolean {
  const wake = planWakeEmits();
  if (emits.length < wake.length) return false;
  return wake.every(([dx, dy], i) => emits[i][0] === dx && emits[i][1] === dy);
}

describe('moveByCurveOneShot — cold-start warm-up wiring (fix (e))', () => {
  beforeEach(() => resetCurveMoverColdStartForTest());
  afterEach(() => vi.useRealTimers());

  const START = { x: 100, y: 100 };
  const TARGET = { x: 800, y: 600 };

  /** Run the mover to completion under fake timers (flushing the interleaved
   *  `sleep`s), with a scripted detect sequence and a controllable clock. */
  async function run(client: RecordingClient, detectSeq: Array<{ x: number; y: number } | null>, now: () => number) {
    vi.useFakeTimers();
    let i = 0;
    const detect = async () => detectSeq[Math.min(i++, detectSeq.length - 1)];
    const p = moveByCurveOneShot(client as unknown as PiKVMClient, TARGET, {}, { detect, now });
    await vi.runAllTimersAsync();
    return p;
  }

  it('FIRST shot after relaunch (module fresh) ⇒ warms the pointer before shooting', async () => {
    const client = new RecordingClient();
    // detect: start(visible cold) → warm re-detect → landed(on target)
    const r = await run(client, [START, START, TARGET], () => 1_000_000);
    expect(startsWithWake(client.emits)).toBe(true); // the wake jiggle ran first
    expect(client.emits.length).toBeGreaterThan(WAKE_EMIT_COUNT); // …then the real toward-emits
    expect(r.message).toMatch(/cold-start warm-up/);
    expect(r.finalResidualPx).toBeCloseTo(0, 0);
  });

  it('SECOND shot moments later ⇒ NO warm-up (cursor is warm)', async () => {
    const client = new RecordingClient();
    // shot 1 stamps the clock at t=1_000_000
    await run(client, [START, START, TARGET], () => 1_000_000);
    // shot 2 at t+500ms — within the stale window ⇒ warm ⇒ no jiggle
    const client2 = new RecordingClient();
    const r2 = await run(client2, [START, TARGET], () => 1_000_500);
    expect(startsWithWake(client2.emits)).toBe(false);
    expect(r2.message).not.toMatch(/cold-start warm-up/);
  });

  it('shot after a STALE gap (idle / foreground return) ⇒ warms again', async () => {
    const client = new RecordingClient();
    await run(client, [START, START, TARGET], () => 1_000_000); // shot 1, stamps t0
    const client2 = new RecordingClient();
    // t0 + (stale + 5s): cold again
    const r2 = await run(client2, [START, START, TARGET], () => 1_000_000 + COLD_START_STALE_MS + 5_000);
    expect(startsWithWake(client2.emits)).toBe(true);
    expect(r2.message).toMatch(/cold-start warm-up/);
  });

  it('detection FAILURE still takes the M2 faded-cursor wake, not a double warm-up', async () => {
    const client = new RecordingClient();
    // start detect fails → M2 wake → re-detect finds it → landed
    const r = await run(client, [null, START, TARGET], () => 1_000_000);
    expect(startsWithWake(client.emits)).toBe(true); // exactly one wake sequence (the M2 one)
    expect(r.message).toMatch(/faded-cursor wake/);
    expect(r.message).not.toMatch(/cold-start warm-up/); // the else-if did not also fire
  });

  it('does NOT loosen the gate — maxResidualPx is nowhere in the mover (it lives in the handler)', async () => {
    const client = new RecordingClient();
    const r = await run(client, [START, START, TARGET], () => 1_000_000);
    // the mover reports the raw residual; it never gates on it.
    expect(r).not.toHaveProperty('maxResidualPx');
    expect(typeof r.finalResidualPx).toBe('number');
  });
});
