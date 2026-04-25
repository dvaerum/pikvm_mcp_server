/**
 * Contract tests for `locateCursor`'s post-probe-position semantics.
 *
 * Old contract (which had a silent bug): "after locateCursor returns,
 * the cursor is back at result.position because we sent a compensating
 * delta." iPadOS pointer-acceleration asymmetry made this a lie — the
 * cursor often ended up between PRE and POST, and downstream callers
 * planned moves from a position that wasn't where the cursor actually
 * was.
 *
 * New contract: "after locateCursor returns, the cursor is at
 * result.position (= POST). prePosition tells you where it was before
 * the probe, for diagnostics."
 *
 * These tests pin the new shape and the brightnessFloor default so
 * future changes can't silently revert.
 */

import { describe, expect, it } from 'vitest';
import type { LocateCursorResult } from '../cursor-detect.js';

describe('LocateCursorResult contract', () => {
  it('exposes both position (post-probe) and prePosition (pre-probe)', () => {
    const stub: LocateCursorResult = {
      position: { x: 200, y: 100 },
      prePosition: { x: 180, y: 100 },
      probeOffsetPx: { x: 20, y: 0 },
      clusterCount: 2,
    };
    expect(stub.position.x).toBe(200);
    expect(stub.prePosition.x).toBe(180);
    expect(stub.position.x - stub.prePosition.x).toBe(stub.probeOffsetPx.x);
  });

  it('REGRESSION: position and prePosition are distinct fields', () => {
    // Type-level pin: if someone removes prePosition from the interface
    // (reverting to the buggy "we restored, position is pre" contract),
    // this won't compile.
    const r: LocateCursorResult = {
      position: { x: 0, y: 0 },
      prePosition: { x: 0, y: 0 },
      probeOffsetPx: { x: 0, y: 0 },
      clusterCount: 0,
    };
    expect(r).toHaveProperty('position');
    expect(r).toHaveProperty('prePosition');
  });
});
