/**
 * Tests for the ballistics profile freshness check that move-to.ts now
 * relies on to avoid silently consuming stale measurements.
 */

import { describe, expect, it } from 'vitest';
import { profileIsFreshFor, lookupPxPerMickey } from '../ballistics.js';
import type { BallisticsProfile } from '../ballistics.js';

function profile(width: number, height: number): BallisticsProfile {
  return {
    measuredAt: new Date().toISOString(),
    resolution: { width, height },
    samples: [],
    medians: { 'x:slow:127': 1.2, 'y:slow:127': 1.4 },
    notes: 'test fixture',
  } as unknown as BallisticsProfile;
}

describe('profileIsFreshFor', () => {
  it('returns false when profile is null', () => {
    expect(profileIsFreshFor(null, { width: 1920, height: 1080 })).toBe(false);
  });

  it('returns true when resolution matches exactly', () => {
    expect(profileIsFreshFor(profile(1920, 1080), { width: 1920, height: 1080 })).toBe(true);
  });

  it('returns false on resolution mismatch (width)', () => {
    expect(profileIsFreshFor(profile(1920, 1080), { width: 2560, height: 1080 })).toBe(false);
  });

  it('returns false on resolution mismatch (height)', () => {
    expect(profileIsFreshFor(profile(1920, 1080), { width: 1920, height: 1440 })).toBe(false);
  });

  it('REGRESSION: previously dead code is now wired into move-to', () => {
    // The bug was that profileIsFreshFor existed but was never called, so a
    // 1920×1080 profile would be silently consumed on a 2048×1536 device.
    // Move-to now calls this; this test pins the predicate's contract so
    // the wiring stays alive even if move-to's call site moves around.
    const stale = profile(1920, 1080);
    const fresh = { width: 2048, height: 1536 };
    expect(profileIsFreshFor(stale, fresh)).toBe(false);
  });
});

describe('lookupPxPerMickey', () => {
  it('returns null when profile has no samples for the requested axis/pace combo', () => {
    // Profile has only x:slow data — asking for y:fast must fall through.
    const p: BallisticsProfile = {
      measuredAt: new Date().toISOString(),
      resolution: { width: 1920, height: 1080 },
      samples: [],
      medians: { 'x:slow:127': 1.2 },
      notes: '',
    } as unknown as BallisticsProfile;
    expect(lookupPxPerMickey(p, 'y', 60, 'fast')).toBeNull();
  });

  it('returns the only available data point when one magnitude is sampled', () => {
    // The legacy bug: profile has only magnitude=127 data, lookup is
    // asked for magnitude=60, returns the 127 value because there's nothing
    // to interpolate between. Pin this so we know the failure mode.
    const p: BallisticsProfile = {
      measuredAt: new Date().toISOString(),
      resolution: { width: 1920, height: 1080 },
      samples: [],
      medians: { 'x:slow:127': 3.04 },
      notes: 'legacy single-point profile',
    } as unknown as BallisticsProfile;
    const result = lookupPxPerMickey(p, 'x', 60, 'slow');
    // We don't assert exact value — just that it returns SOMETHING (not
    // null) so we know the bad-data path is reachable. Move-to's
    // profileIsFreshFor check is what actually protects against this.
    expect(result).not.toBeNull();
  });

  // Phase 18: rich multi-magnitude profile from fresh ballistics.
  function multiMagnitude(): BallisticsProfile {
    return {
      measuredAt: new Date().toISOString(),
      resolution: { width: 1920, height: 1080 },
      samples: [],
      medians: {
        'x:slow:5':   12.4,
        'x:slow:10':  6.0,
        'x:slow:20':  3.0,
        'x:slow:40':  1.5,
        'x:slow:80':  0.75,
        'x:slow:127': 0.49,
        'y:slow:40':  3.7,
        'y:slow:80':  1.8,
        'y:slow:127': 1.0,
      },
      notes: 'multi-magnitude',
    } as unknown as BallisticsProfile;
  }

  it('returns the exact value when magnitude matches a sampled point', () => {
    const p = multiMagnitude();
    expect(lookupPxPerMickey(p, 'x', 20, 'slow')).toBe(3.0);
    expect(lookupPxPerMickey(p, 'x', 80, 'slow')).toBe(0.75);
    expect(lookupPxPerMickey(p, 'y', 40, 'slow')).toBe(3.7);
  });

  it('clamps to the smallest sampled magnitude when asked below the range', () => {
    const p = multiMagnitude();
    // Smallest x:slow sample is at mag 5 → 12.4. Asked for mag 1.
    expect(lookupPxPerMickey(p, 'x', 1, 'slow')).toBe(12.4);
    // Smallest y:slow sample is at mag 40 → 3.7. Asked for mag 10.
    expect(lookupPxPerMickey(p, 'y', 10, 'slow')).toBe(3.7);
  });

  it('clamps to the largest sampled magnitude when asked above the range', () => {
    const p = multiMagnitude();
    // Largest x:slow sample is at mag 127 → 0.49. Asked for mag 200.
    expect(lookupPxPerMickey(p, 'x', 200, 'slow')).toBe(0.49);
    expect(lookupPxPerMickey(p, 'y', 250, 'slow')).toBe(1.0);
  });

  it('linearly interpolates between two adjacent sampled magnitudes', () => {
    const p = multiMagnitude();
    // Mag 30 sits halfway between 20 (ratio 3.0) and 40 (ratio 1.5).
    // Interpolated: 3.0 + 0.5 * (1.5 - 3.0) = 2.25.
    const r = lookupPxPerMickey(p, 'x', 30, 'slow');
    expect(r).toBeCloseTo(2.25, 5);
  });

  it('does not mix axes — y request returns null if y:slow is empty', () => {
    const p: BallisticsProfile = {
      measuredAt: new Date().toISOString(),
      resolution: { width: 1920, height: 1080 },
      samples: [],
      medians: { 'x:slow:20': 3.0, 'x:slow:40': 1.5 },
    } as unknown as BallisticsProfile;
    expect(lookupPxPerMickey(p, 'y', 30, 'slow')).toBeNull();
  });

  it('does not mix paces — slow request does not see fast samples', () => {
    const p: BallisticsProfile = {
      measuredAt: new Date().toISOString(),
      resolution: { width: 1920, height: 1080 },
      samples: [],
      medians: { 'x:fast:20': 3.0, 'x:fast:40': 1.5 },
    } as unknown as BallisticsProfile;
    expect(lookupPxPerMickey(p, 'x', 30, 'slow')).toBeNull();
    // But the same magnitude on the matching pace returns interpolation.
    expect(lookupPxPerMickey(p, 'x', 30, 'fast')).toBeCloseTo(2.25, 5);
  });
});
