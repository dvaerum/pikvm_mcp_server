import { describe, it, expect } from 'vitest';
import { buildMLHints, buildCascadeGrid } from '../cursor-ml-detect.js';

describe('buildMLHints', () => {
  const W = 1680;
  const H = 1050;

  it('always includes the predicted hint', () => {
    const hints = buildMLHints({ x: 640, y: 800 }, W, H, null);
    expect(hints[0]).toEqual({ x: 640, y: 800 });
  });

  it('adds belief.position when on-screen and far from predicted', () => {
    const hints = buildMLHints({ x: 100, y: 100 }, W, H, { x: 1000, y: 900 });
    expect(hints).toContainEqual({ x: 1000, y: 900 });
  });

  it('skips belief.position when off-screen (negative)', () => {
    const hints = buildMLHints({ x: 640, y: 800 }, W, H, { x: -3051, y: -4130 });
    expect(hints.every(h => h.x >= 0 && h.y >= 0)).toBe(true);
    expect(hints.find(h => h.x === -3051 || h.x < 0)).toBeUndefined();
  });

  it('skips belief.position when off-screen (beyond frame)', () => {
    const hints = buildMLHints({ x: 640, y: 800 }, W, H, { x: 5000, y: 5000 });
    expect(hints.find(h => h.x >= W || h.y >= H)).toBeUndefined();
  });

  it('skips belief.position when too close to predicted (< 200 px)', () => {
    const hints = buildMLHints({ x: 640, y: 800 }, W, H, { x: 700, y: 850 });
    expect(hints.length).toBe(2); // predicted + home-zone (belief skipped)
    expect(hints.find(h => h.x === 700 && h.y === 850)).toBeUndefined();
  });

  it('always considers a home-zone hint at (width × 5/8, height × 3/4)', () => {
    const hints = buildMLHints({ x: 200, y: 200 }, W, H, null);
    const expectedHome = { x: Math.round(W * 0.625), y: Math.round(H * 0.75) };
    expect(hints).toContainEqual(expectedHome);
  });

  it('skips home-zone hint when predicted is already in home zone', () => {
    const homeX = Math.round(W * 0.625);
    const homeY = Math.round(H * 0.75);
    const hints = buildMLHints({ x: homeX, y: homeY }, W, H, null);
    expect(hints.length).toBe(1);
  });

  it('Books-from-home scenario: returns predicted + home-zone', () => {
    // v0.5.239 diagnostic case: predicted Books at (640, 800),
    // belief drifted to (-3051, -4130) after unlock/home, cursor
    // actually at (1170, 892). Home-zone hint should cover cursor.
    const hints = buildMLHints({ x: 640, y: 800 }, 1680, 1050, { x: -3051, y: -4130 });
    expect(hints).toContainEqual({ x: 640, y: 800 });
    const homeHint = hints.find(h => h.x !== 640 || h.y !== 800);
    expect(homeHint).toBeDefined();
    // A 256×256 crop centered on the home-zone hint must cover the
    // cursor's actual location (1170, 892). i.e. cursor within ±128
    // px on each axis from the home hint.
    if (homeHint) {
      expect(Math.abs(homeHint.x - 1170)).toBeLessThanOrEqual(128);
      expect(Math.abs(homeHint.y - 892)).toBeLessThanOrEqual(128);
    }
  });
});

describe('buildCascadeGrid', () => {
  // task_484bed055820: narrow the cascade's search grid to a bounded window
  // around a hint (when one is known), instead of always scanning the whole
  // detected iPad region. Pure geometry — no ONNX involved, same testing
  // pattern as buildMLHints above.

  it('no hint: covers the whole region (hand-computed, exact — also the pre-fix behavior, so this doubles as a regression/parity check)', () => {
    // region is exactly one 96px crop wide/tall; axis() walks 0->48 (stride
    // 48, half=48), then appends the region's own far edge (96) since it
    // isn't already a multiple of the stride from 0. Two grid lines per
    // axis (48, 96) => 2x2 = 4 crops. This mirrors runCascade's existing
    // axis() math verbatim (same stride, same half-crop clamp).
    const grid = buildCascadeGrid({ x: 0, y: 0, w: 96, h: 96 }, 1000, 1000);
    const asPairs = grid.map((c) => `${c.x},${c.y}`).sort();
    expect(asPairs).toEqual(['48,48', '48,96', '96,48', '96,96']);
  });

  it('no hint: passing null/undefined hint is byte-identical to omitting it', () => {
    const region = { x: 100, y: 100, w: 400, h: 400 };
    const withoutArg = buildCascadeGrid(region, 1920, 1080);
    const withNull = buildCascadeGrid(region, 1920, 1080, null);
    const withUndefined = buildCascadeGrid(region, 1920, 1080, undefined);
    expect(withNull).toEqual(withoutArg);
    expect(withUndefined).toEqual(withoutArg);
  });

  it('with a hint well inside a large region: shrinks the grid dramatically (the whole point of this fix)', () => {
    const region = { x: 0, y: 0, w: 2000, h: 2000 };
    const full = buildCascadeGrid(region, 3000, 3000);
    const narrowed = buildCascadeGrid(region, 3000, 3000, { x: 1000, y: 1000 });
    expect(narrowed.length).toBeGreaterThan(0);
    // Design target: ~7x reduction (352->49 on the real production region).
    // Assert the same order of magnitude here rather than pinning an exact
    // count, so this doesn't become brittle to a future stride/radius tune.
    expect(narrowed.length).toBeLessThan(full.length / 4);
  });

  it('with a hint: every returned crop center stays within the window radius of the hint (+ one grid step of slack)', () => {
    const region = { x: 0, y: 0, w: 2000, h: 2000 };
    const hint = { x: 1000, y: 1000 };
    const narrowed = buildCascadeGrid(region, 3000, 3000, hint);
    // Generous slack: the window radius itself, plus one grid step for the
    // axis()'s own "always include the far edge" behavior.
    const slack = 150 + 48 + 1;
    for (const c of narrowed) {
      expect(Math.abs(c.x - hint.x)).toBeLessThanOrEqual(slack);
      expect(Math.abs(c.y - hint.y)).toBeLessThanOrEqual(slack);
    }
  });

  it('with a hint near the region edge: the window clamps to the region, never scanning outside it', () => {
    const region = { x: 500, y: 500, w: 1000, h: 1000 };
    // Hint pinned to the region's own top-left corner.
    const hint = { x: region.x, y: region.y };
    const narrowed = buildCascadeGrid(region, 3000, 3000, hint);
    expect(narrowed.length).toBeGreaterThan(0);
    for (const c of narrowed) {
      expect(c.x).toBeGreaterThanOrEqual(region.x);
      expect(c.y).toBeGreaterThanOrEqual(region.y);
      expect(c.x).toBeLessThanOrEqual(region.x + region.w);
      expect(c.y).toBeLessThanOrEqual(region.y + region.h);
    }
  });

  it('with a hint entirely outside the region (no overlap): returns empty, signaling "fall back to full scan"', () => {
    const region = { x: 0, y: 0, w: 200, h: 200 };
    const hint = { x: 5000, y: 5000 };
    const narrowed = buildCascadeGrid(region, 6000, 6000, hint);
    expect(narrowed).toEqual([]);
  });
});
