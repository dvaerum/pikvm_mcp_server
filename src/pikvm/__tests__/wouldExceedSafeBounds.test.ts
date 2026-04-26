/**
 * Phase 49: pure tests for the edge-bounds safety predicate.
 *
 * The predicate gates the post-move micro-correction loop. Phase 45 was
 * reverted because the loop pushed the cursor down to the iPad's bottom
 * edge and triggered iPadOS's swipe-up-from-bottom gesture, opening the
 * app switcher. Phase 49 added this predicate; if its semantics ever
 * regress, the destructive gesture comes back. These tests pin the
 * boundary semantics so a future edit fails CI loudly instead of
 * silently producing live destructive failures.
 */

import { describe, expect, it } from 'vitest';
import { wouldExceedSafeBounds } from '../click-verify.js';

const IPAD_PORTRAIT_BOUNDS = {
  x: 616,
  y: 48,
  width: 688,
  height: 984,
};
const MARGIN = 50;

describe('wouldExceedSafeBounds', () => {
  it('returns false for points well inside the safe-bounds inner rectangle', () => {
    // Centre of iPad bounds.
    const cx = IPAD_PORTRAIT_BOUNDS.x + IPAD_PORTRAIT_BOUNDS.width / 2;
    const cy = IPAD_PORTRAIT_BOUNDS.y + IPAD_PORTRAIT_BOUNDS.height / 2;
    expect(wouldExceedSafeBounds(cx, cy, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(false);
  });

  it('returns true when predicted Y exceeds bottom edge minus margin', () => {
    // The Phase 45 failure mode: cursor pushed to bottom-edge gesture zone.
    const cx = IPAD_PORTRAIT_BOUNDS.x + IPAD_PORTRAIT_BOUNDS.width / 2;
    // Bottom edge at y = 48 + 984 = 1032. With margin 50, max safe Y = 982.
    const dangerY = 1000; // > 982 → exceeds
    expect(wouldExceedSafeBounds(cx, dangerY, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(true);
  });

  it('returns true when predicted Y is above top edge plus margin', () => {
    // Top-edge gesture (control centre / notifications) zone.
    const cx = IPAD_PORTRAIT_BOUNDS.x + IPAD_PORTRAIT_BOUNDS.width / 2;
    // Top edge at y = 48. With margin 50, min safe Y = 98.
    const dangerY = 80; // < 98 → exceeds
    expect(wouldExceedSafeBounds(cx, dangerY, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(true);
  });

  it('returns true when predicted X is past left edge minus margin', () => {
    // Left edge at x = 616. With margin 50, min safe X = 666.
    const dangerX = 640; // < 666 → exceeds
    const cy = IPAD_PORTRAIT_BOUNDS.y + IPAD_PORTRAIT_BOUNDS.height / 2;
    expect(wouldExceedSafeBounds(dangerX, cy, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(true);
  });

  it('returns true when predicted X is past right edge plus margin', () => {
    // Right edge at x = 616+688 = 1304. With margin 50, max safe X = 1254.
    const dangerX = 1280; // > 1254 → exceeds
    const cy = IPAD_PORTRAIT_BOUNDS.y + IPAD_PORTRAIT_BOUNDS.height / 2;
    expect(wouldExceedSafeBounds(dangerX, cy, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(true);
  });

  it('returns true when predicted point is in a corner gesture zone', () => {
    // Top-left of iPad bounds (would trigger lock-screen hot corner if cursor
    // saturated there). 600,40 is outside even before margin.
    expect(wouldExceedSafeBounds(600, 40, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(true);
  });

  it('boundary: exactly on margin edge is NOT exceeded (strict <)', () => {
    // Inner rectangle = bounds shrunk by margin. Points exactly on the
    // margin edge are NOT outside.
    const minX = IPAD_PORTRAIT_BOUNDS.x + MARGIN;
    const minY = IPAD_PORTRAIT_BOUNDS.y + MARGIN;
    const maxX = IPAD_PORTRAIT_BOUNDS.x + IPAD_PORTRAIT_BOUNDS.width - MARGIN;
    const maxY = IPAD_PORTRAIT_BOUNDS.y + IPAD_PORTRAIT_BOUNDS.height - MARGIN;
    expect(wouldExceedSafeBounds(minX, minY, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(false);
    expect(wouldExceedSafeBounds(maxX, maxY, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(false);
  });

  it('boundary: just past margin (1 px) IS exceeded', () => {
    const minX = IPAD_PORTRAIT_BOUNDS.x + MARGIN;
    expect(wouldExceedSafeBounds(minX - 1, 500, IPAD_PORTRAIT_BOUNDS, MARGIN)).toBe(true);
  });

  it('zero margin treats the bounds rect as the safe area', () => {
    // With margin=0, anywhere inside the bounds is safe.
    expect(wouldExceedSafeBounds(700, 500, IPAD_PORTRAIT_BOUNDS, 0)).toBe(false);
    // Outside the bounds is unsafe.
    expect(wouldExceedSafeBounds(0, 0, IPAD_PORTRAIT_BOUNDS, 0)).toBe(true);
  });

  it('large margin shrinks the safe area (defensive against close-call edges)', () => {
    // 200px margin shrinks the 688×984 bounds to a 288×584 inner region.
    const cx = IPAD_PORTRAIT_BOUNDS.x + IPAD_PORTRAIT_BOUNDS.width / 2;
    const cy = IPAD_PORTRAIT_BOUNDS.y + IPAD_PORTRAIT_BOUNDS.height / 2;
    expect(wouldExceedSafeBounds(cx, cy, IPAD_PORTRAIT_BOUNDS, 200)).toBe(false);
    // A point 100px from the right edge would have been safe at margin=50,
    // but exceeds at margin=200.
    const nearEdgeX = IPAD_PORTRAIT_BOUNDS.x + IPAD_PORTRAIT_BOUNDS.width - 100;
    expect(wouldExceedSafeBounds(nearEdgeX, cy, IPAD_PORTRAIT_BOUNDS, 50)).toBe(false);
    expect(wouldExceedSafeBounds(nearEdgeX, cy, IPAD_PORTRAIT_BOUNDS, 200)).toBe(true);
  });
});
