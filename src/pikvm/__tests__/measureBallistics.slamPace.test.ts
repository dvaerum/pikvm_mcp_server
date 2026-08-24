/**
 * Regression test for a correctness bug: measureBallistics used to default
 * slamPaceMs to 15ms internally, silently overriding slamToCorner's own
 * documented 60ms default — the two defaults could drift out of sync with
 * no warning. (This pace mismatch was originally suspected as the cause of
 * an observed iPad lock-screen incident; a later controlled retest found
 * the lock risk present at a non-trivial rate at both 15ms and 60ms, so
 * fixing the override is a correctness fix, not a proven mitigation for
 * that risk — see the detect+recover follow-up for the actual defense.)
 *
 * Fix: measureBallistics now threads userOptions.slamPaceMs through as
 * `undefined` when unset, instead of substituting its own default, so
 * slamToCorner's own default is the single source of truth. See
 * slamAndNudge.test.ts for slamToCorner's own default-pace coverage; this
 * test instead pins the *caller* (measureBallistics -> measureCell) to not
 * reintroduce a competing default.
 *
 * `sleep` (from util.js, used both by the slam loop and elsewhere in the
 * pipeline) is mocked to resolve instantly and record every `ms` argument
 * it was called with, so the test runs fast while still observing exactly
 * what pace was requested.
 *
 * slamCalls is passed explicitly below (rather than left to default) to
 * sidestep a separate, pre-existing bug: measureBallistics defaults
 * slamCalls to `0` as an "auto" sentinel, but slamToCorner resolves it via
 * `options.calls ?? auto`, and `0 ?? auto` is `0`, not auto — so under
 * default options the slam loop never actually runs. That bug is
 * independent of slamPaceMs (unrelated sentinel, same options block) and
 * out of scope here; it's been flagged separately. An explicit slamCalls
 * makes this test exercise the slam loop regardless of that bug's status.
 */
import { describe, expect, it, vi } from 'vitest';

const { sleepCalls } = vi.hoisted(() => ({ sleepCalls: [] as number[] }));

vi.mock('../util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util.js')>();
  return {
    ...actual,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  };
});

const { measureBallistics } = await import('../ballistics.js');
import type { PiKVMClient, ScreenResolution } from '../client.js';

class FakeClient {
  resolution: ScreenResolution = { width: 400, height: 300 };
  moveCalls: Array<{ dx: number; dy: number }> = [];

  async getResolution(_force?: boolean): Promise<ScreenResolution> {
    return this.resolution;
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.moveCalls.push({ dx, dy });
  }

  async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
    // Uniform blank frame: no cursor cluster will ever be detected, so
    // every cell is rejected. That's fine here — we only care about the
    // pace the slam phase requests, not whether a sample is accepted.
    const sharp = (await import('sharp')).default;
    const buf = await sharp(
      Buffer.alloc(this.resolution.width * this.resolution.height * 3),
      { raw: { width: this.resolution.width, height: this.resolution.height, channels: 3 } },
    ).png().toBuffer();
    return { buffer: buf, screenshotWidth: this.resolution.width, screenshotHeight: this.resolution.height };
  }
}

describe('measureBallistics slam pace default', () => {
  it('does not override slamToCorner\'s 60ms default with its own default when slamPaceMs is unset', async () => {
    sleepCalls.length = 0;
    const client = new FakeClient();

    await measureBallistics(client as unknown as PiKVMClient, {
      magnitudes: [5],
      paces: ['fast'],
      axes: ['x'],
      reps: 1,
      noiseFrames: 1,
      slamCalls: 12,
    });

    // slamToCorner's own default (used because measureBallistics no longer
    // substitutes a competing one) must show up in the recorded sleeps.
    expect(sleepCalls).toContain(60);
    // The old unsafe override must never appear again.
    expect(sleepCalls).not.toContain(15);
  });

  it('still allows an explicit slamPaceMs override to reach slamToCorner', async () => {
    sleepCalls.length = 0;
    const client = new FakeClient();

    await measureBallistics(client as unknown as PiKVMClient, {
      magnitudes: [5],
      paces: ['fast'],
      axes: ['x'],
      reps: 1,
      noiseFrames: 1,
      slamCalls: 12,
      slamPaceMs: 90,
    });

    expect(sleepCalls).toContain(90);
    expect(sleepCalls).not.toContain(60);
  });
});
