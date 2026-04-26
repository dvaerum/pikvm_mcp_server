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

  it("REGRESSION: rejects a multi-glyph text fragment (e.g. 'ript', 'ck')", () => {
    // Live failure 2026-04-26: template captures from dark-mode Settings UI
    // contained text fragments, not cursors. Each character glyph is a
    // disconnected bright region. A real cursor is ONE cohesive blob;
    // text is many small disconnected components. Reject when the largest
    // connected bright component is < ~50% of all bright pixels.
    //
    // Template here simulates 4 small disconnected bright glyphs spaced
    // horizontally — looks like text on dark background.
    const t = template(24, 24, (i) => {
      const x = i % 24, y = Math.floor(i / 24);
      // Four 3×6 bright strokes at x=2-4, 8-10, 14-16, 20-22; y=8-13.
      const inGlyphRow = y >= 8 && y < 14;
      const xCol = x % 6;
      const inGlyphCol = xCol >= 2 && xCol < 5;
      return inGlyphRow && inGlyphCol ? [240, 240, 240] : [40, 40, 40];
    });
    expect(looksLikeCursor(t)).toBe(false);
  });

  it('accepts a cursor with small anti-alias satellite pixels around the main blob', () => {
    // A real cursor with anti-aliasing produces a few disconnected dim-
    // bright outliers around the main shape. The main blob still
    // dominates (≥50% of bright pixels) so the cohesion test should pass.
    const t = template(24, 24, (i) => {
      const x = i % 24, y = Math.floor(i / 24);
      // Main 6×6 cursor blob centered at (12, 12).
      const inMain = Math.abs(x - 12) < 3 && Math.abs(y - 12) < 3;
      // A couple of single-pixel anti-alias outliers.
      const isSatellite = (x === 5 && y === 5) || (x === 19 && y === 19);
      const bright = inMain || isSatellite;
      return bright ? [240, 240, 240] : [40, 40, 40];
    });
    expect(looksLikeCursor(t)).toBe(true);
  });
});
