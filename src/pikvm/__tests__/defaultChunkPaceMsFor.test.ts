/**
 * Phase 156 — regression tests for defaultChunkPaceMsFor.
 *
 * Phase 136 (v0.5.128) measured a 167-mickey Y emit landing 60 px
 * past target on iPad at the original 30 ms chunk pace because
 * iPadOS pointer acceleration tracks velocity across consecutive
 * chunks and saw 9 chunks of 20 mickeys as one fast burst (1.6×
 * over-shoot).
 *
 * Slowing to 100 ms lets velocity decay between chunks. Pinning
 * the helper guards against a future "let's optimise latency by
 * halving this" or a flat-default revert silently re-introducing
 * the overshoot.
 */

import { describe, expect, it } from 'vitest';
import { defaultChunkPaceMsFor } from '../click-verify.js';

describe('defaultChunkPaceMsFor', () => {
  it('returns 100 for relative-mouse targets (iPad)', () => {
    expect(defaultChunkPaceMsFor(false)).toBe(100);
  });

  it('returns undefined for absolute-mouse targets (desktop) so caller default applies', () => {
    expect(defaultChunkPaceMsFor(true)).toBeUndefined();
  });

  it('REGRESSION: collapsing both branches to a single value must fail', () => {
    // Phase 136's whole point: the iPad path is DIFFERENT from the
    // desktop path. A flat "100 for both" or "undefined for both"
    // refactor would silently regress one or the other.
    expect(defaultChunkPaceMsFor(false)).not.toBe(defaultChunkPaceMsFor(true));
  });

  it('REGRESSION: iPad value must not drop below 100 (Phase 136 overshoot)', () => {
    // If a future "let's halve this for latency" refactor sets the
    // iPad default to 50 ms, this assertion catches it. 100 ms is
    // the minimum that empirically prevented the 60 px overshoot.
    const ipadValue = defaultChunkPaceMsFor(false);
    expect(ipadValue).toBeDefined();
    expect(ipadValue!).toBeGreaterThanOrEqual(100);
  });
});
