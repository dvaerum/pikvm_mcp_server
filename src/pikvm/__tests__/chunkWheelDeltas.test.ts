/**
 * Wheel-chunking regression: a single large delta_y wraps the signed-byte HID
 * wheel to a ~no-op on iPad (georgs on-device 2026-07-27: delta_y=500 didn't
 * scroll; 25× delta_y=20 did). chunkWheelDeltas splits a large scroll into
 * repeated ±WHEEL_STEP_MAX events. These tests pin the split without a live rig.
 */
import { describe, expect, it } from 'vitest';

import { chunkWheelDeltas, WHEEL_STEP_MAX } from '../client.js';

const sum = (evs: Array<{ deltaX: number; deltaY: number }>) =>
  evs.reduce((a, e) => ({ deltaX: a.deltaX + e.deltaX, deltaY: a.deltaY + e.deltaY }), {
    deltaX: 0,
    deltaY: 0,
  });

describe('chunkWheelDeltas', () => {
  it('leaves a small scroll as a single unchanged event', () => {
    expect(chunkWheelDeltas(0, 15)).toEqual([{ deltaX: 0, deltaY: 15 }]);
    expect(chunkWheelDeltas(0, WHEEL_STEP_MAX)).toEqual([{ deltaX: 0, deltaY: WHEEL_STEP_MAX }]);
  });

  it('splits the field-report failure case (delta_y=500) into ±STEP events that sum back', () => {
    const evs = chunkWheelDeltas(0, 500);
    // 500 / 20 = 25 events, none exceeding the byte-safe step.
    expect(evs).toHaveLength(Math.ceil(500 / WHEEL_STEP_MAX));
    expect(evs.every((e) => Math.abs(e.deltaY) <= WHEEL_STEP_MAX)).toBe(true);
    expect(sum(evs)).toEqual({ deltaX: 0, deltaY: 500 });
  });

  it('preserves sign for negative (scroll-up) deltas', () => {
    const evs = chunkWheelDeltas(0, -50);
    expect(evs.every((e) => e.deltaY <= 0)).toBe(true);
    expect(sum(evs)).toEqual({ deltaX: 0, deltaY: -50 });
    // 50 → 20,20,10
    expect(evs).toEqual([
      { deltaX: 0, deltaY: -20 },
      { deltaX: 0, deltaY: -20 },
      { deltaX: 0, deltaY: -10 },
    ]);
  });

  it('handles a non-multiple with a remainder tail', () => {
    const evs = chunkWheelDeltas(0, 50);
    expect(evs).toEqual([
      { deltaX: 0, deltaY: 20 },
      { deltaX: 0, deltaY: 20 },
      { deltaX: 0, deltaY: 10 },
    ]);
  });

  it('chunks both axes together (diagonal scroll) and stops when both are drained', () => {
    const evs = chunkWheelDeltas(30, -50);
    expect(sum(evs)).toEqual({ deltaX: 30, deltaY: -50 });
    // Event count = max(ceil(30/20), ceil(50/20)) = max(2,3) = 3.
    expect(evs).toHaveLength(3);
    // Each event within the byte-safe band on both axes.
    expect(evs.every((e) => Math.abs(e.deltaX) <= WHEEL_STEP_MAX && Math.abs(e.deltaY) <= WHEEL_STEP_MAX)).toBe(true);
    // Once deltaX (30) is drained after 2 events, the tail carries only deltaY.
    expect(evs[2]).toEqual({ deltaX: 0, deltaY: -10 });
  });

  it('emits no events for a zero scroll', () => {
    expect(chunkWheelDeltas(0, 0)).toEqual([]);
  });

  it('rounds fractional deltas before chunking', () => {
    expect(chunkWheelDeltas(0, 12.7)).toEqual([{ deltaX: 0, deltaY: 13 }]);
  });

  it('honours a custom step', () => {
    const evs = chunkWheelDeltas(0, 30, 10);
    expect(evs).toEqual([
      { deltaX: 0, deltaY: 10 },
      { deltaX: 0, deltaY: 10 },
      { deltaX: 0, deltaY: 10 },
    ]);
  });
});
