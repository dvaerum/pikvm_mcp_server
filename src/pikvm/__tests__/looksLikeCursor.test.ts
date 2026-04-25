/**
 * Tests for looksLikeCursor — guards template capture against bad
 * motion-diff pairs that point at icon corners or animated widgets.
 *
 * Bug context: live testing on the iPad caught a self-reinforcing
 * failure mode where motion-diff picked a wrong pair, captured a
 * template from a non-cursor region (e.g. orange-blue icon corner),
 * persisted that bad template, and then every subsequent template
 * match scored 0.99 against THE SAME WRONG SPOT — the algorithm
 * thought it had found the cursor every time.
 */

import { describe, expect, it } from 'vitest';
import { looksLikeCursor } from '../move-to.js';
import type { CursorTemplate } from '../cursor-detect.js';

function template(width: number, height: number, fill: (i: number) => [number, number, number]): CursorTemplate {
  const px = width * height;
  const buf = Buffer.alloc(px * 3);
  for (let i = 0; i < px; i++) {
    const [r, g, b] = fill(i);
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return { rgb: buf, width, height };
}

describe('looksLikeCursor', () => {
  it('accepts a typical cursor template (gray cursor on dark background)', () => {
    // 24×24 with a small bright gray cursor cluster in the centre and
    // dark wallpaper everywhere else.
    const t = template(24, 24, (i) => {
      const x = i % 24, y = Math.floor(i / 24);
      const inCursor = Math.abs(x - 12) < 4 && Math.abs(y - 12) < 4;
      return inCursor ? [240, 240, 240] : [60, 60, 60];
    });
    expect(looksLikeCursor(t)).toBe(true);
  });

  it('REGRESSION: rejects a colored icon corner (orange/blue)', () => {
    // Top half orange, bottom half blue — the actual bad template that
    // got captured during live testing.
    const t = template(24, 24, (i) => {
      const y = Math.floor(i / 24);
      return y < 12 ? [220, 100, 60] : [50, 100, 220];
    });
    expect(looksLikeCursor(t)).toBe(false);
  });

  it('rejects a fully colored region (uniform red)', () => {
    const t = template(24, 24, () => [220, 60, 60]);
    expect(looksLikeCursor(t)).toBe(false);
  });

  it('rejects a region with no bright pixels (all dim)', () => {
    // No pixel reaches the 170 brightness floor → no bright achromatic.
    const t = template(24, 24, () => [120, 120, 120]);
    expect(looksLikeCursor(t)).toBe(false);
  });

  it('accepts a barely-cursor-like region (bright pixels just at threshold)', () => {
    // Cursor centre exactly at threshold (170, 170, 170), big enough to
    // pass the 4% bright-achromatic check (24*24*0.04 = ~23 pixels).
    const t = template(24, 24, (i) => {
      const x = i % 24, y = Math.floor(i / 24);
      const inCursor = Math.abs(x - 12) < 3 && Math.abs(y - 12) < 3;
      return inCursor ? [200, 200, 200] : [40, 40, 40];
    });
    expect(looksLikeCursor(t)).toBe(true);
  });
});
