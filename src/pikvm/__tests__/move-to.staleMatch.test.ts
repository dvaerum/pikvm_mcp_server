/**
 * Tests for the template-match stale-position guard. When template-match
 * returns the same position across consecutive correction passes, that
 * indicates a stable false positive — the cursor moved (we emitted
 * significant mickeys) but template-match found something stationary
 * that resembles the cursor (e.g., a button or text glyph).
 */

import { describe, expect, it } from 'vitest';
import { isStaleTemplateMatch } from '../move-to.js';

describe('isStaleTemplateMatch', () => {
  it('accepts first template match (no previous)', () => {
    expect(
      isStaleTemplateMatch({ x: 100, y: 100 }, null, 100),
    ).toBe(false);
  });

  it('accepts when current match position differs significantly from last', () => {
    expect(
      isStaleTemplateMatch({ x: 200, y: 100 }, { x: 100, y: 100 }, 100),
    ).toBe(false);
  });

  it('rejects when match is at same position AND emission was significant', () => {
    // Identical position + 100 mickeys emitted between → stale.
    expect(
      isStaleTemplateMatch({ x: 100, y: 100 }, { x: 100, y: 100 }, 100),
    ).toBe(true);
  });

  it('accepts same-position match when emission was small (cursor really may not have moved)', () => {
    // 5 mickeys emitted — too small to expect cursor movement at all.
    expect(
      isStaleTemplateMatch({ x: 100, y: 100 }, { x: 100, y: 100 }, 5),
    ).toBe(false);
  });

  it('rejects matches within 5 px of last after large emission', () => {
    // 4 px drift but 200 mickeys emitted — the cursor should have moved
    // ~200 px; 4 px drift is suspiciously small.
    expect(
      isStaleTemplateMatch({ x: 102, y: 99 }, { x: 100, y: 100 }, 200),
    ).toBe(true);
  });

  it('accepts >5 px drift after large emission', () => {
    expect(
      isStaleTemplateMatch({ x: 110, y: 100 }, { x: 100, y: 100 }, 200),
    ).toBe(false);
  });

  it('REGRESSION: the (1151,696) iPad-modal false-positive scenario', () => {
    // What happened in the live test: template-match returned (1151,696)
    // every pass; in between, we emitted -192,-121 mickeys (≈226 px move
    // expected). 0 px drift after 226 mickeys → reject as stale.
    const last = { x: 1151, y: 696 };
    const now = { x: 1151, y: 696 };
    const emittedMag = Math.hypot(192, 121);
    expect(emittedMag).toBeGreaterThan(30);
    expect(isStaleTemplateMatch(now, last, emittedMag)).toBe(true);
  });
});
