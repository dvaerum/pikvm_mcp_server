/**
 * Phase 121 — unit tests for computeTemplateHotspot.
 *
 * The iPadOS arrow cursor's clickable hotspot is at the arrow TIP,
 * not the bounding-box centre. Returning bbox-centre (the v0.5.113
 * behaviour) introduced a systematic ~12-15 px offset between
 * "where template-match thinks the cursor is" and "where iPadOS
 * registers the click". This caused converged-but-failing clicks at
 * residuals of 30-40 px against ~70 px icons (Phase 109-117).
 *
 * `computeTemplateHotspot` finds the cursor's clickable hotspot by
 * locating the topmost-leftmost bright pixel within the template
 * (the arrow tip). For round/dot cursors this returns a point on
 * the upper-left edge of the dot — still better than the 12-15 px
 * offset of bbox-centre.
 */

import { describe, expect, it } from 'vitest';
import { computeTemplateHotspot } from '../cursor-detect.js';
import type { CursorTemplate } from '../cursor-detect.js';

function makeTemplate(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): CursorTemplate {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const [r, g, b] = paint(x, y);
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  return { rgb, width, height };
}

describe('computeTemplateHotspot', () => {
  it('returns the arrow TIP for a top-left-pointing arrow (the iPadOS case)', () => {
    // Synthetic arrow with tip at (4, 2) and body extending toward
    // the bottom-right.
    const tpl = makeTemplate(24, 24, (x, y) => {
      const onArrow =
        (x === 4 && y === 2) || // tip
        (x === 5 && y === 3) ||
        (x === 6 && y === 4) ||
        (x === 7 && y === 5) ||
        (x === 8 && y === 6) ||
        (x === 9 && y === 7) ||
        (x === 5 && y === 4) ||
        (x === 5 && y === 5) ||
        (x === 5 && y === 6) ||
        (x === 5 && y === 7) ||
        (x === 5 && y === 8) ||
        (x === 5 && y === 9) ||
        (x === 5 && y === 10);
      return onArrow ? [240, 240, 240] : [10, 10, 10];
    });
    const hs = computeTemplateHotspot(tpl);
    // Tip at (4, 2). Allow ±1 px slack for the centroid-of-topmost-
    // bright-cluster algorithm.
    expect(hs.x).toBeGreaterThanOrEqual(3);
    expect(hs.x).toBeLessThanOrEqual(5);
    expect(hs.y).toBeGreaterThanOrEqual(1);
    expect(hs.y).toBeLessThanOrEqual(3);
  });

  it('returns the bbox-centre for an empty/uniform template (degenerate fallback)', () => {
    const tpl = makeTemplate(24, 24, () => [50, 50, 50]); // no bright pixels
    const hs = computeTemplateHotspot(tpl);
    // No detectable cursor → fall back to bbox centre to preserve
    // the legacy behaviour for templates that defeat the gate.
    expect(hs).toEqual({ x: 12, y: 12 });
  });

  it('returns the centre of a round/dot cursor', () => {
    // Dot at (12, 12) with radius 4.
    const cx = 12, cy = 12, r = 4;
    const tpl = makeTemplate(24, 24, (x, y) => {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      return d2 <= r * r ? [240, 240, 240] : [10, 10, 10];
    });
    const hs = computeTemplateHotspot(tpl);
    // Dot centre is (12, 12). The "topmost bright pixel" is at
    // (12, 8) — that's where the tip detection lands. Acceptable
    // offset of up to r=4 from true centre; still better than the
    // 12 px offset of bbox-centre against an ARROW.
    expect(hs.x).toBeGreaterThanOrEqual(10);
    expect(hs.x).toBeLessThanOrEqual(14);
    expect(hs.y).toBeGreaterThanOrEqual(7);
    expect(hs.y).toBeLessThanOrEqual(13);
  });

  it('handles odd-sized templates', () => {
    const tpl = makeTemplate(25, 25, (x, y) => (x === 3 && y === 3 ? [240, 240, 240] : [10, 10, 10]));
    const hs = computeTemplateHotspot(tpl);
    expect(hs).toEqual({ x: 3, y: 3 });
  });

  it('REGRESSION (Phase 121): tip near (4, 4) of a 24px template means template-match reports the tip, not bbox-centre (12, 12)', () => {
    // The exact problem the helper solves: a 24×24 captured iPadOS
    // arrow cursor with the tip at ~(4, 4). Before Phase 121,
    // findCursorByTemplate reported bbox-centre (12, 12) as the
    // cursor position — an 11 px offset from the actual click
    // hotspot. After Phase 121, the reported position should be at
    // the tip (~(4, 4)).
    const tpl = makeTemplate(24, 24, (x, y) => {
      const onArrow =
        (x === 4 && y === 4) || (x === 5 && y === 5) || (x === 6 && y === 6) ||
        (x === 7 && y === 7) || (x === 8 && y === 8) || (x === 9 && y === 9) ||
        (x === 5 && y === 6) || (x === 5 && y === 7) || (x === 5 && y === 8) ||
        (x === 5 && y === 9) || (x === 5 && y === 10) || (x === 5 && y === 11);
      return onArrow ? [240, 240, 240] : [10, 10, 10];
    });
    const hs = computeTemplateHotspot(tpl);
    expect(hs.x).toBeLessThan(8); // closer to tip x=4 than centre x=12
    expect(hs.y).toBeLessThan(8); // closer to tip y=4 than centre y=12
  });
});
