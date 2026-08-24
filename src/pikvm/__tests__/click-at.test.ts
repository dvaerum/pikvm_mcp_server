/**
 * Unit tests for clickAt() (Phase 4/F5 extraction, 2026-08-24). Previously
 * pikvm_mouse_click_at's 290-line handler had zero real behavioral test
 * coverage — only text-grep tests that regexed index.ts as a string (see
 * mcp-tool-schema-exposure.test.ts's history). This is a from-scratch
 * suite, not a port.
 *
 * moveToPixel is mocked: clickAt's own decision logic (brightness gate,
 * cursor-verified gate, correct-element residual gate, the 2026-07-31
 * drift-bug invariant, capture wiring, force/forcedUnverified) is what's
 * under test here, not the mover's internals — those have their own
 * extensive coverage in move-to.ts's own test files.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { clickAt, type ClickAtRequest } from '../click-at.js';
import type { PiKVMClient } from '../client.js';
import type { HidPolicy } from '../hid-mode.js';
import type { MoveToResult } from '../move-to.js';

const { moveToPixelMock } = vi.hoisted(() => ({ moveToPixelMock: vi.fn() }));

vi.mock('../move-to.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../move-to.js')>();
  return { ...actual, moveToPixel: moveToPixelMock };
});

/** Uniform-fill synthetic screenshot (same helper used across the suite). */
async function makeScreenshot(width: number, height: number, fill: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

function makeMoveResult(overrides: Partial<MoveToResult> = {}): MoveToResult {
  return {
    screenshot: Buffer.from('shot'),
    screenshotWidth: 1920,
    screenshotHeight: 1080,
    target: { x: 100, y: 100 },
    finalDetectedPosition: { x: 100, y: 100 },
    message: 'moveToPixel: landed at (100,100)',
    method: 'curve-one-shot',
    ...overrides,
  } as MoveToResult;
}

const IPAD_POLICY: HidPolicy = {
  mode: 'ipad',
  mouseAbsolute: false,
  strategy: 'curve-one-shot',
  forbidSlamFallback: true,
  forbidSlamOnIpad: true,
  chunkPaceMs: 100,
  maxResidualPx: 25,
  dimThreshold: 40,
  applyTapBias: true,
};

interface MockClientOpts {
  /** Screenshots returned in order by client.screenshot(). Clamped to the
   *  last entry once exhausted. Default: a uniformly bright frame (never
   *  trips the brightness gate). */
  shots?: Buffer[];
}

function mockClient(opts: MockClientOpts = {}) {
  const shots = opts.shots;
  let shotCall = 0;
  const clicks: Array<{ button: string }> = [];
  let brightFrame: Buffer | null = null;
  const client = {
    async screenshot(): Promise<{ buffer: Buffer; screenshotWidth: number; screenshotHeight: number }> {
      if (!brightFrame) brightFrame = await makeScreenshot(400, 300, [200, 200, 200]);
      const buf = shots ? shots[Math.min(shotCall, shots.length - 1)] : brightFrame;
      shotCall++;
      return { buffer: buf, screenshotWidth: 400, screenshotHeight: 300 };
    },
    async mouseClick(button: string): Promise<void> {
      clicks.push({ button });
    },
  } as unknown as PiKVMClient;
  return { client, clicks, get screenshotCalls() { return shotCall; } };
}

function baseRequest(overrides: Partial<ClickAtRequest> = {}): ClickAtRequest {
  const { client } = mockClient();
  return {
    client,
    policy: IPAD_POLICY,
    target: { x: 100, y: 100 },
    button: 'left',
    profile: null,
    verifyClick: false, // keep most tests focused; verify-specific tests opt in
    verifySettleMs: 0,
    singleTap: false,
    force: false,
    ...overrides,
  };
}

beforeEach(() => {
  moveToPixelMock.mockReset();
  moveToPixelMock.mockResolvedValue(makeMoveResult());
});

describe('clickAt — mode-unknown', () => {
  it('reports mode-unknown and never calls moveToPixel when policy is null', async () => {
    const req = baseRequest({ policy: null });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('mode-unknown');
    expect(moveToPixelMock).not.toHaveBeenCalled();
  });
});

describe('clickAt — brightness abort', () => {
  it('aborts on a uniformly dim frame (very-dim severity) without moving the cursor', async () => {
    const dim = await makeScreenshot(400, 300, [5, 5, 5]);
    const { client } = mockClient({ shots: [dim] });
    const req = baseRequest({ client, minBrightness: 40 });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('brightness-abort');
    if (outcome.kind === 'brightness-abort') {
      expect(outcome.threshold).toBe(40);
      expect(outcome.mean).toBeLessThan(40);
    }
    expect(moveToPixelMock).not.toHaveBeenCalled();
  });

  it('does not abort on a dark-but-contrasty frame (Phase 48: dim ≠ very-dim)', async () => {
    // High-contrast frame: half black, half bright — low mean, high stddev.
    const buf = Buffer.alloc(400 * 300 * 3);
    for (let i = 0; i < 400 * 300; i++) {
      const bright = i % 2 === 0;
      buf[i * 3] = bright ? 220 : 0;
      buf[i * 3 + 1] = bright ? 220 : 0;
      buf[i * 3 + 2] = bright ? 220 : 0;
    }
    const contrasty = await sharp(buf, { raw: { width: 400, height: 300, channels: 3 } }).jpeg().toBuffer();
    const { client } = mockClient({ shots: [contrasty] });
    const req = baseRequest({ client, minBrightness: 40 });
    const outcome = await clickAt(req);
    expect(outcome.kind).not.toBe('brightness-abort');
    expect(moveToPixelMock).toHaveBeenCalled();
  });

  it('skips the brightness precheck entirely when minBrightness is 0', async () => {
    const dim = await makeScreenshot(400, 300, [5, 5, 5]);
    const { client } = mockClient({ shots: [dim] });
    const req = baseRequest({ client, minBrightness: 0 });
    const outcome = await clickAt(req);
    expect(outcome.kind).not.toBe('brightness-abort');
  });
});

describe('clickAt — cursor-unverified skip', () => {
  it('skips the click and reports cursor-unverified when the mover could not localize the cursor (iPad, no force)', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: null }));
    const { client, clicks } = mockClient();
    const req = baseRequest({ client, force: false });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('cursor-unverified');
    if (outcome.kind === 'cursor-unverified') {
      expect(outcome.message).toContain('Click NOT performed');
    }
    expect(clicks).toHaveLength(0);
  });

  it('does NOT apply the cursor-verified gate on desktop/absolute targets', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: null }));
    const req = baseRequest({ policy: { ...IPAD_POLICY, mouseAbsolute: true }, force: false });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
  });

  it('force:true fires the click anyway and reports it forcedUnverified — never a silent landing', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: null }));
    const req = baseRequest({ force: true });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
    if (outcome.kind === 'clicked') {
      expect(outcome.forcedUnverified).toBe(true);
      expect(outcome.message).toContain('UNVERIFIED');
      expect(outcome.message).toContain('LANDING IS NOT CONFIRMED');
    }
  });
});

describe('clickAt — residual-gate skip (Phase 88 correct-element gate)', () => {
  it('skips the click when the verified cursor lands farther than maxResidualPx from target', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: { x: 200, y: 200 } })); // ~141px from (100,100)
    const req = baseRequest({ maxResidualPx: 25 });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('residual-skip');
    if (outcome.kind === 'residual-skip') {
      expect(outcome.maxResidualPx).toBe(25);
      expect(outcome.residualPx).toBeGreaterThan(25);
      expect(outcome.message).toContain('adjacent element');
    }
  });

  it('proceeds to click when the residual is within maxResidualPx', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: { x: 105, y: 105 } })); // ~7px from (100,100)
    const req = baseRequest({ maxResidualPx: 25 });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
  });

  it('the gate is disabled when maxResidualPx is 0', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: { x: 900, y: 900 } }));
    const req = baseRequest({ maxResidualPx: 0 });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
  });
});

describe('clickAt — the 2026-07-31 drift bug (single-computation invariant)', () => {
  // Regression: measureBallistics.slamVerify-style test. The bug: computing
  // maxResidualPx separately for the mover's acceptGatePx and the clicker's
  // own skip check let the two drift apart (mover's correction gate sat at
  // 30 while the clicker's acceptance gate sat at 25), stranding residuals
  // in [25,30) — accepted-enough for the mover to stop correcting, but
  // still rejected by the clicker. Fixed by computing the value ONCE and
  // threading the SAME variable to both. This test proves that invariant
  // holds from the outside: whatever maxResidualPx the caller passes is
  // the exact value moveToPixel receives as acceptGatePx, AND the exact
  // value the residual-skip check compares against — not two independently
  // sourced numbers that happen to agree today.
  it('the value passed to moveToPixel.acceptGatePx is identical to the value the residual-skip check uses', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: { x: 128, y: 100 } })); // 28px from (100,100)
    // applyTapBias:false so the aim point stays exactly (100,100) — with
    // bias applied the aim shifts ~5.9px in Y, which would smear this
    // boundary-case distance and make the test fragile.
    const req = baseRequest({ policy: { ...IPAD_POLICY, applyTapBias: false }, maxResidualPx: 28 });
    // 28px residual against a 28px gate: not strictly greater than, so this
    // does NOT skip — proves the gate reads the exact same 28, not a competing
    // default (e.g. the old drifted 25/30 split would disagree on this exact
    // boundary case).
    const outcome = await clickAt(req);
    expect(moveToPixelMock).toHaveBeenCalledTimes(1);
    const [, , moveOpts] = moveToPixelMock.mock.calls[0];
    expect(moveOpts.acceptGatePx).toBe(28);
    expect(outcome.kind).toBe('clicked');
  });

  it('falls through to policy.maxResidualPx when the caller does not override it, and both surfaces still agree', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: { x: 130, y: 100 } })); // 30px, > policy's 25
    const req = baseRequest({ maxResidualPx: undefined }); // → IPAD_POLICY.maxResidualPx = 25
    const outcome = await clickAt(req);
    const [, , moveOpts] = moveToPixelMock.mock.calls[0];
    expect(moveOpts.acceptGatePx).toBe(25);
    expect(outcome.kind).toBe('residual-skip');
    if (outcome.kind === 'residual-skip') expect(outcome.maxResidualPx).toBe(25);
  });
});

describe('clickAt — successful click', () => {
  it('clicks the requested button and reports success with a screenshot', async () => {
    const { client, clicks } = mockClient();
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: { x: 100, y: 100 } }));
    const req = baseRequest({ client, button: 'right' });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
    expect(clicks).toEqual([{ button: 'right' }]);
    if (outcome.kind === 'clicked') {
      expect(outcome.forcedUnverified).toBe(false);
      expect(outcome.message).toContain('Clicked right');
    }
  });

  it('singleTap appends its advisory note', async () => {
    const req = baseRequest({ singleTap: true });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
    if (outcome.kind === 'clicked') {
      expect(outcome.message).toContain('singleTap: tapped ONCE, no retry');
    }
  });

  it('desktop/absolute targets click regardless of finalDetectedPosition (positioned by coordinates, not detection)', async () => {
    moveToPixelMock.mockResolvedValue(makeMoveResult({ finalDetectedPosition: null }));
    const req = baseRequest({ policy: { ...IPAD_POLICY, mouseAbsolute: true } });
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
    if (outcome.kind === 'clicked') expect(outcome.forcedUnverified).toBe(false);
  });
});

describe('clickAt — capture advisory (M8)', () => {
  it('captures during and after phases when a capture config is supplied', async () => {
    const captureCalls: string[] = [];
    const { client } = mockClient();
    (client as unknown as { screenshotKeepingCursorAlive?: () => Promise<{ buffer: Buffer }> }).screenshotKeepingCursorAlive =
      async () => ({ buffer: await makeScreenshot(400, 300, [200, 200, 200]) });
    const req = baseRequest({
      client,
      capture: { phases: ['during', 'after'], prefix: '/tmp/click-at-test' },
    });
    // clickAt always attempts all 3 phases (before/during/after) when a
    // capture config is set — capturePhase itself returns null immediately
    // for any phase not in config.phases, so `captured` always has 3
    // entries when capture is on, regardless of which phases were
    // requested. Advisory: a write failure also returns null, never throws.
    const outcome = await clickAt(req);
    expect(outcome.kind).toBe('clicked');
    if (outcome.kind === 'clicked') {
      expect(outcome.captured).toHaveLength(3);
      expect(outcome.captured[0]).toBeNull(); // 'before' not in phases
      expect(outcome.captured[1]).not.toBeNull(); // 'during' requested
      expect(outcome.captured[2]).not.toBeNull(); // 'after' requested
    }
    void captureCalls;
  });
});
