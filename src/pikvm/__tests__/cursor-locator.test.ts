/**
 * Unit tests for CursorLocator (Candidate 1 / Phase 1).
 *
 * Fully offline: every detector / device / verify collaborator is an injected
 * vitest stub. These pin the three (four) cascades' EXACT call order + fallback
 * semantics, the honest-confidence contract (null for motion-diff / template /
 * shape; a real number for ml / cascade), the motion-diff probeMeasurement
 * carry, and the belief wiring (observe / reset / setBounds / predict).
 *
 * Nothing hits hardware; the fake belief is a bag of vi.fn()s.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CursorLocator,
  type CursorLocatorDeps,
  type V8Detection,
} from '../cursor-locator.js';
import type { CursorBelief } from '../cursor-belief.js';
import type { DecodedScreenshot } from '../cursor-detect.js';

// --- fakes ------------------------------------------------------------------

function fakeShot(): DecodedScreenshot {
  return {
    buffer: Buffer.from([0xff]),
    rgb: Buffer.alloc(3),
    width: 200,
    height: 100,
  };
}

function fakeBelief(): CursorBelief {
  return {
    position: { x: 111, y: 222 },
    bounds: null,
    observe: vi.fn(),
    reset: vi.fn(),
    predict: vi.fn(),
  } as unknown as CursorBelief;
}

/** A full deps object where everything is a stub; each stub is a no-op / null
 *  by default so a test overrides only the collaborators it cares about. */
function makeDeps(overrides: Partial<CursorLocatorDeps> = {}): CursorLocatorDeps {
  const base: CursorLocatorDeps = {
    belief: fakeBelief(),
    screenshot: vi.fn(async () => fakeShot()),
    decode: vi.fn(async () => fakeShot()),
    mouseMoveRelative: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    getCachedTemplates: vi.fn(async () => []),
    isMlDisabled: vi.fn(() => false),
    findCursorByV8FullFrame: vi.fn(async () => null),
    locateCursor: vi.fn(async () => null),
    findCursorByTemplateSet: vi.fn(() => null),
    findCursorByMLMultiHint: vi.fn(async () => null),
    findCursorByShape: vi.fn(() => null),
    buildMLHints: vi.fn((predicted) => [predicted]),
    mlWiggleVerify: vi.fn(async () => null),
    wiggleVerifyCandidate: vi.fn(async () => null),
    shouldFireSecondOpinion: vi.fn(() => false),
    shouldAdoptSecondOpinion: vi.fn(() => false),
    tautologyProxThreshold: 30,
  };
  return { ...base, ...overrides };
}

const FRAME = Buffer.from([0x01, 0x02]);
const v8 = (p: Partial<V8Detection>): V8Detection => ({
  x: 10,
  y: 20,
  presence: 0.9,
  heatmapPeak: 0.9,
  ...p,
});

// --- origin -----------------------------------------------------------------

describe('locate(profile: origin)', () => {
  it('returns the V8 cascade fix first and does NOT probe motion-diff', async () => {
    const deps = makeDeps({
      findCursorByV8FullFrame: vi.fn(async () => v8({ x: 50, y: 60, presence: 0.87 })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'origin');

    expect(fix).toEqual({
      position: { x: 50, y: 60 },
      source: 'cascade',
      rawScore: 0.87,
      confidence: 0.87,
    });
    expect(deps.findCursorByV8FullFrame).toHaveBeenCalledTimes(1);
    expect(deps.locateCursor).not.toHaveBeenCalled();
    expect(deps.getCachedTemplates).not.toHaveBeenCalled();
  });

  it('skips V8 entirely when ML is disabled and falls to motion-diff', async () => {
    const deps = makeDeps({
      isMlDisabled: vi.fn(() => true),
      findCursorByV8FullFrame: vi.fn(async () => v8({})),
      locateCursor: vi.fn(async () => ({
        position: { x: 7, y: 8 },
        prePosition: { x: 0, y: 0 },
        probeOffsetPx: { x: 42, y: 0 },
        probeMickeys: { x: 60, y: 0 },
        clusterCount: 2,
      })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'origin');

    expect(deps.findCursorByV8FullFrame).not.toHaveBeenCalled();
    expect(deps.locateCursor).toHaveBeenCalledTimes(1);
    expect(fix?.source).toBe('motion-diff');
  });

  it('carries probeMeasurement and null confidence when motion-diff wins', async () => {
    const deps = makeDeps({
      locateCursor: vi.fn(async () => ({
        position: { x: 7, y: 8 },
        prePosition: { x: 0, y: 0 },
        probeOffsetPx: { x: 42, y: 0 },
        probeMickeys: { x: 60, y: 0 },
        clusterCount: 3,
      })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'origin');

    expect(fix).toEqual({
      position: { x: 7, y: 8 },
      source: 'motion-diff',
      rawScore: 0,
      confidence: null,
      probeMeasurement: {
        offsetPx: { x: 42, y: 0 },
        mickeys: { x: 60, y: 0 },
      },
    });
    // motion-diff only fires after V8 declined.
    expect(deps.findCursorByV8FullFrame).toHaveBeenCalledTimes(1);
    // and the template fallback must NOT run once motion-diff succeeds.
    expect(deps.getCachedTemplates).not.toHaveBeenCalled();
  });

  it('falls to the template-set progressive wake and wins on the 2nd nudge', async () => {
    const templates = [{ any: 'template' }] as never;
    const found = vi
      .fn()
      .mockReturnValueOnce(null) // 1st (30-nudge) attempt: no match
      .mockReturnValueOnce({ position: { x: 3, y: 4 }, score: 0.91, templateIndex: 0 });
    const deps = makeDeps({
      getCachedTemplates: vi.fn(async () => templates),
      findCursorByTemplateSet: found,
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'origin');

    expect(fix).toEqual({
      position: { x: 3, y: 4 },
      source: 'template',
      rawScore: 0.91,
      confidence: null,
    });
    // exactly two wake cycles ran (30 fwd/back, then 60 fwd/back) → 4 nudges.
    expect((deps.mouseMoveRelative as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [30, 0],
      [-30, 0],
      [60, 0],
      [-60, 0],
    ]);
    expect(found).toHaveBeenCalledTimes(2);
    // minScore floor is 0.85 on every template call.
    for (const call of found.mock.calls) {
      expect(call[2]).toMatchObject({ minScore: 0.85 });
    }
  });

  it('returns null when all three origin stages fail (caller keeps slam)', async () => {
    const deps = makeDeps({
      getCachedTemplates: vi.fn(async () => [{ t: 1 }] as never),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'origin');

    expect(fix).toBeNull();
    // all three nudge cycles exhausted.
    expect(deps.findCursorByTemplateSet).toHaveBeenCalledTimes(3);
  });
});

// --- openLoopShape ----------------------------------------------------------

describe('locate(profile: openLoopShape)', () => {
  const HINT = { x: 500, y: 400 };

  it('returns the ML fix (with real confidence) and skips shape when prox is far', async () => {
    const deps = makeDeps({
      // prox from hint (500,400) is large (>30) so no wiggle-verify is required.
      findCursorByMLMultiHint: vi.fn(async () => ({
        x: 700,
        y: 600,
        confidence: 0.97,
        crop: { left: 0, top: 0 },
      })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'openLoopShape', HINT);

    expect(fix).toEqual({
      position: { x: 700, y: 600 },
      source: 'ml',
      rawScore: 0.97,
      confidence: 0.97,
    });
    expect(deps.buildMLHints).toHaveBeenCalledTimes(1);
    expect(deps.mlWiggleVerify).not.toHaveBeenCalled();
    expect(deps.findCursorByShape).not.toHaveBeenCalled();
    // ML crop ran at minConfidence 0.5.
    const mlCall = (deps.findCursorByMLMultiHint as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(mlCall[4]).toMatchObject({ minConfidence: 0.5 });
  });

  it('wiggle-verifies a suspiciously-close CROP-BASED ML detection (crop != 0,0) and accepts it', async () => {
    const deps = makeDeps({
      // prox 0 (<= threshold 30) AND crop-based (non-zero crop = the hint-crop
      // fallback, which CAN be a hint echo) → mlWiggleVerify must run.
      findCursorByMLMultiHint: vi.fn(async () => ({
        x: HINT.x,
        y: HINT.y,
        confidence: 0.8,
        crop: { left: 120, top: 80 },
      })),
      mlWiggleVerify: vi.fn(async () => ({
        x: HINT.x,
        y: HINT.y,
        confidence: 0.8,
        crop: { left: 120, top: 80 },
      })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'openLoopShape', HINT);

    expect(deps.mlWiggleVerify).toHaveBeenCalledTimes(1);
    expect(fix?.source).toBe('ml');
    expect(deps.findCursorByShape).not.toHaveBeenCalled();
  });

  it('SKIPS wiggle-verify for a full-frame-cascade (crop 0,0) detection near the hint (the fix)', async () => {
    // findCursorByMLMultiHint returns crop {0,0} when its hint-INDEPENDENT full-frame
    // cascade fired, so a near-hint landing is genuine, not a tautology — accept it
    // directly WITHOUT the wiggle-verify that was false-rejecting it live (upper-right 0%).
    const deps = makeDeps({
      findCursorByMLMultiHint: vi.fn(async () => ({
        x: HINT.x, y: HINT.y, confidence: 0.8, crop: { left: 0, top: 0 },
      })),
      mlWiggleVerify: vi.fn(async () => null), // would REJECT if called — must NOT be called
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'openLoopShape', HINT);

    expect(deps.mlWiggleVerify).not.toHaveBeenCalled();
    expect(fix).toEqual({ position: { x: HINT.x, y: HINT.y }, source: 'ml', rawScore: 0.8, confidence: 0.8 });
    expect(deps.findCursorByShape).not.toHaveBeenCalled();
  });

  it('falls through to a wiggle-verified shape candidate when ML is rejected', async () => {
    const deps = makeDeps({
      // Crop-based ML near hint (crop != 0,0) but wiggle rejects it → shape fallback.
      findCursorByMLMultiHint: vi.fn(async () => ({
        x: HINT.x,
        y: HINT.y,
        confidence: 0.7,
        crop: { left: 120, top: 80 },
      })),
      mlWiggleVerify: vi.fn(async () => null),
      findCursorByShape: vi
        .fn()
        // dark pass returns a strong candidate; bright pass returns null.
        .mockReturnValueOnce({ centroidX: 510.4, centroidY: 402.6, pixels: 40, shapeScore: 0.6 })
        .mockReturnValueOnce(null),
      wiggleVerifyCandidate: vi.fn(async (pos) => ({ pos })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'openLoopShape', HINT);

    expect(fix).toEqual({
      position: { x: 510, y: 403 },
      source: 'shape',
      rawScore: 0.6,
      confidence: null, // shape is NOT calibrated → null
    });
    expect(deps.findCursorByShape).toHaveBeenCalledTimes(2); // dark + bright
    expect(deps.wiggleVerifyCandidate).toHaveBeenCalledTimes(1);
  });

  it('returns null when ML and every shape candidate fail wiggle-verify', async () => {
    const deps = makeDeps({
      findCursorByShape: vi
        .fn()
        .mockReturnValueOnce({ centroidX: 510, centroidY: 402, pixels: 40, shapeScore: 0.6 })
        .mockReturnValueOnce({ centroidX: 460, centroidY: 350, pixels: 30, shapeScore: 0.3 }),
      wiggleVerifyCandidate: vi.fn(async () => null),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'openLoopShape', HINT);

    expect(fix).toBeNull();
    expect(deps.wiggleVerifyCandidate).toHaveBeenCalledTimes(2);
  });

  it('requires a hint', async () => {
    const loc = new CursorLocator(makeDeps());
    await expect(loc.locate(FRAME, 200, 100, 'openLoopShape')).rejects.toThrow(/hint/);
  });
});

// --- verify -----------------------------------------------------------------

describe('locate(profile: verify)', () => {
  const TARGET = { x: 300, y: 300 };

  it('adopts the template second-opinion and does NOT run V8', async () => {
    const deps = makeDeps({
      getCachedTemplates: vi.fn(async () => [{ t: 1 }] as never),
      shouldFireSecondOpinion: vi.fn(() => true),
      findCursorByTemplateSet: vi.fn(() => ({
        position: { x: 305, y: 298 },
        score: 0.82,
        templateIndex: 0,
      })),
      shouldAdoptSecondOpinion: vi.fn(() => true),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'verify', TARGET);

    expect(fix).toEqual({
      position: { x: 305, y: 298 },
      source: 'template',
      rawScore: 0.82,
      confidence: null,
    });
    expect(deps.shouldFireSecondOpinion).toHaveBeenCalledTimes(1);
    expect(deps.shouldAdoptSecondOpinion).toHaveBeenCalledTimes(1);
    expect(deps.findCursorByV8FullFrame).not.toHaveBeenCalled();
    // template match ran with the 0.7 floor + target locality.
    const tCall = (deps.findCursorByTemplateSet as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tCall[2]).toMatchObject({ minScore: 0.7, expectedNear: TARGET, expectedNearRadius: 200 });
  });

  it('falls to the V8 cascade when the second opinion does not fire', async () => {
    const deps = makeDeps({
      shouldFireSecondOpinion: vi.fn(() => false),
      findCursorByV8FullFrame: vi.fn(async () => v8({ x: 301, y: 302, presence: 0.75, heatmapPeak: 0.6 })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'verify', TARGET);

    expect(fix).toEqual({
      position: { x: 301, y: 302 },
      source: 'cascade',
      rawScore: 0.75,
      confidence: 0.75,
    });
    expect(deps.findCursorByTemplateSet).not.toHaveBeenCalled();
  });

  it('falls to V8 when the template is found but not adopted', async () => {
    const deps = makeDeps({
      getCachedTemplates: vi.fn(async () => [{ t: 1 }] as never),
      shouldFireSecondOpinion: vi.fn(() => true),
      findCursorByTemplateSet: vi.fn(() => ({
        position: { x: 999, y: 999 },
        score: 0.71,
        templateIndex: 0,
      })),
      shouldAdoptSecondOpinion: vi.fn(() => false),
      findCursorByV8FullFrame: vi.fn(async () => v8({ heatmapPeak: 0.5 })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'verify', TARGET);

    expect(fix?.source).toBe('cascade');
    expect(deps.findCursorByV8FullFrame).toHaveBeenCalledTimes(1);
  });

  it('rejects a low-heatmap V8 detection (heatmapPeak < 0.3) as null', async () => {
    const deps = makeDeps({
      findCursorByV8FullFrame: vi.fn(async () => v8({ heatmapPeak: 0.2 })),
    });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 200, 100, 'verify', TARGET);
    expect(fix).toBeNull();
  });

  it('requires a hint', async () => {
    const loc = new CursorLocator(makeDeps());
    await expect(loc.locate(FRAME, 200, 100, 'verify')).rejects.toThrow(/hint/);
  });
});

// --- curve ------------------------------------------------------------------

describe('locate(profile: curve)', () => {
  it('returns the V8 cascade fix from the passed frame at minPresence 0.5', async () => {
    const detect = vi.fn(async () => v8({ x: 12, y: 34, presence: 0.66 }));
    const deps = makeDeps({ findCursorByV8FullFrame: detect });
    const loc = new CursorLocator(deps);

    const fix = await loc.locate(FRAME, 640, 480, 'curve');

    expect(fix).toEqual({
      position: { x: 12, y: 34 },
      source: 'cascade',
      rawScore: 0.66,
      confidence: 0.66,
    });
    expect(detect).toHaveBeenCalledWith(FRAME, 640, 480, { minPresence: 0.5 });
  });

  it('returns null when V8 declines', async () => {
    const loc = new CursorLocator(makeDeps());
    const fix = await loc.locate(FRAME, 640, 480, 'curve');
    expect(fix).toBeNull();
  });
});

// --- belief wiring ----------------------------------------------------------

describe('belief wiring', () => {
  it('observe(fix) forwards position to belief.observe', () => {
    const deps = makeDeps();
    const loc = new CursorLocator(deps);

    loc.observe({ position: { x: 5, y: 6 }, source: 'ml', rawScore: 0.9, confidence: 0.9 });
    expect(deps.belief.observe).toHaveBeenCalledWith({ x: 5, y: 6 }, 0.9);
  });

  it('observe(fix) uses full weight (1) when confidence is null', () => {
    const deps = makeDeps();
    const loc = new CursorLocator(deps);

    loc.observe({ position: { x: 5, y: 6 }, source: 'motion-diff', rawScore: 0, confidence: null });
    expect(deps.belief.observe).toHaveBeenCalledWith({ x: 5, y: 6 }, 1);
  });

  it('reset(at) forwards to belief.reset', () => {
    const deps = makeDeps();
    const loc = new CursorLocator(deps);

    loc.reset({ x: 9, y: 9 });
    expect(deps.belief.reset).toHaveBeenCalledWith({ x: 9, y: 9 });
  });

  it('setBounds(b) sets belief.bounds', () => {
    const deps = makeDeps();
    const loc = new CursorLocator(deps);
    const bounds = { x: 1, y: 2, width: 3, height: 4 };

    loc.setBounds(bounds);
    expect(deps.belief.bounds).toBe(bounds);

    loc.setBounds(null);
    expect(deps.belief.bounds).toBeNull();
  });

  it('predict(emit) passes through to belief.predict', () => {
    const deps = makeDeps();
    const loc = new CursorLocator(deps);

    loc.predict({ dx: 7, dy: -3 });
    expect(deps.belief.predict).toHaveBeenCalledWith({ dx: 7, dy: -3 });
  });
});
