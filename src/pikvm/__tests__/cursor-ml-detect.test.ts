import { describe, it, expect } from 'vitest';
import { buildMLHints } from '../cursor-ml-detect.js';

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
