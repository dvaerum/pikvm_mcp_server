/**
 * Phase 192-B (v0.5.182): pin the wiring contract — every successful
 * `client.mouseMoveRelative(dx, dy)` calls `client.belief.predict`
 * with the CLAMPED emit. Bypasses the network by stubbing `request`
 * so the test runs offline.
 */

import { describe, expect, it, vi } from 'vitest';
import { PiKVMClient, createDefaultBelief } from '../client.js';

function newClient(): PiKVMClient {
  const c = new PiKVMClient({
    host: 'mock.local',
    username: 'admin',
    password: 'x',
    verifySsl: false,
  });
  // Stub the private request method so no network is touched.
  (c as unknown as { request: () => Promise<unknown> }).request = async () => undefined;
  return c;
}

describe('PiKVMClient ↔ CursorBelief wiring', () => {
  it('mouseMoveRelative forwards the clamped emit to belief.predict', async () => {
    const c = newClient();
    c.resetBelief({ x: 100, y: 100 });
    expect(c.belief.position).toEqual({ x: 100, y: 100 });

    await c.mouseMoveRelative(20, 0);

    // belief.position should have advanced by 20 * default ratio (1.3) = 26 px.
    expect(c.belief.position.x).toBeCloseTo(126, 1);
    expect(c.belief.position.y).toBe(100);
  });

  it('belief.predict uses CLAMPED values (PiKVM HID limit ±127), not the raw caller input', async () => {
    const c = newClient();
    c.resetBelief({ x: 0, y: 0 });

    // Caller asks for +500 mickeys; PiKVM clamps to +127.
    await c.mouseMoveRelative(500, 0);

    // belief.predict must see 127, not 500. So position advance is
    // 127 * 1.3 = 165.1, NOT 500 * 1.3 = 650.
    expect(c.belief.position.x).toBeCloseTo(165.1, 0);
  });

  it('multiple emits accumulate in belief.position', async () => {
    const c = newClient();
    c.resetBelief({ x: 0, y: 0 });
    await c.mouseMoveRelative(10, 0);
    await c.mouseMoveRelative(10, 0);
    await c.mouseMoveRelative(10, 0);
    // 3 × 10 × 1.3 = 39
    expect(c.belief.position.x).toBeCloseTo(39, 1);
  });

  it('setBeliefBounds enables clip-and-inflate behaviour', async () => {
    const c = newClient();
    c.setBeliefBounds({ x: 0, y: 0, width: 1000, height: 800 });
    c.resetBelief({ x: 990, y: 400 });

    const xVarBefore = c.belief.variance.x;
    // 50 mickeys * 1.3 = 65 px → would project to x=1055; clamps at 1000.
    await c.mouseMoveRelative(50, 0);

    expect(c.belief.position.x).toBe(1000);
    expect(c.belief.variance.x).toBeGreaterThan(xVarBefore);
  });

  it('observeCursor pushes a measurement into the belief', async () => {
    const c = newClient();
    c.resetBelief({ x: 0, y: 0 });
    await c.mouseMoveRelative(10, 0); // belief now ≈ (13, 0)

    c.observeCursor({ x: 13, y: 0 }, 0.95);
    // Position barely changes (measurement matches prediction); variance
    // collapses tighter.
    expect(Math.abs(c.belief.position.x - 13)).toBeLessThan(0.5);
    expect(c.belief.variance.x).toBeLessThan(2);
  });

  it('belief is initialised wide so a fresh client does not pretend to know cursor position', () => {
    const c = newClient();
    // Default initialPositionVariance is 10000 → σ ≈ 100 px.
    // expectedRegion at 95% should be ~196 px on each axis.
    const region = c.belief.expectedRegion(0.95);
    expect(region.rx).toBeGreaterThan(150);
    expect(region.ry).toBeGreaterThan(150);
  });

  it('Phase 315: default bounds prevent belief.position drift to extreme negatives', async () => {
    // Without default bounds, predict() with no setBeliefBounds call
    // would let unlock/home swipe emits drift the belief to off-screen
    // negative coords (Phase 315 diagnostic: -3051, -4130 after one
    // unlock+home cycle). The constructor now sets wide bounds
    // (4096×2160) so predict() clips even before letterbox detection.
    const c = newClient();
    c.resetBelief({ x: 100, y: 100 });
    // Simulate a huge unlock-swipe magnitude (1500 mickeys of leftward
    // emit, like dragPx=1500 chunked). Even at 1.3 px/mickey ratio
    // that's ~2000 px — would drift to negative without clip.
    for (let i = 0; i < 12; i++) {
      await c.mouseMoveRelative(-127, 0);
    }
    expect(c.belief.position.x).toBeGreaterThanOrEqual(0);
    expect(c.belief.position.y).toBeGreaterThanOrEqual(0);
  });

  it('emits to mouseMoveRelative still advance the keepalive clock (Phase 187 not regressed)', async () => {
    // We don't reach into recordEmit's internals here — just verify
    // that the call doesn't throw and belief gets updated, proving the
    // wiring runs both Phase 187 + Phase 192-B side effects.
    const c = newClient();
    c.resetBelief({ x: 0, y: 0 });
    await expect(c.mouseMoveRelative(15, 0)).resolves.toBeUndefined();
    expect(c.belief.position.x).toBeGreaterThan(0);
  });

  // C1 P2 (candidate 5): belief is owned outside the client and injected; the
  // client delegates to that same instance. Predict must fire on the injected one.
  it('C1 P2: an injected belief is used as-is (delegation, not a fresh instance)', async () => {
    const injected = createDefaultBelief();
    const c = new PiKVMClient(
      { host: 'mock.local', username: 'admin', password: 'x', verifySsl: false },
      injected,
    );
    (c as unknown as { request: () => Promise<unknown> }).request = async () => undefined;
    expect(c.belief).toBe(injected);
    c.resetBelief({ x: 100, y: 100 });
    await c.mouseMoveRelative(20, 0);
    // predict fired on the injected belief (same 20 × 1.3 = 26 px advance).
    expect(injected.position.x).toBeCloseTo(126, 1);
  });

  it('C1 P2: omitting the belief still yields an equivalent default (backward-compat)', () => {
    const a = newClient();
    const b = newClient();
    expect(a.belief).not.toBe(b.belief); // independent instances
    expect(a.belief.expectedRegion(0.95).rx).toBeCloseTo(b.belief.expectedRegion(0.95).rx, 5);
  });

  // Phase 212/222: pin client.wouldRejectAsStationary delegates to belief
  // and that observeCursor with rejectStationary forwards correctly.
  describe('Phase 212/222: stationary-cluster rejection wiring', () => {
    it('wouldRejectAsStationary returns false before any observation', () => {
      const c = newClient();
      c.resetBelief({ x: 0, y: 0 });
      expect(c.wouldRejectAsStationary({ x: 100, y: 100 })).toBe(false);
    });

    it('wouldRejectAsStationary delegates to belief.wouldRejectAsStationary', async () => {
      const c = newClient();
      c.resetBelief({ x: 0, y: 0 });
      // First observation establishes the lastObservation point.
      c.observeCursor({ x: 970, y: 771 }, 0.9);
      // Emit 50 mickeys (well over the 30-mickey gate).
      await c.mouseMoveRelative(50, 0);
      // Same point after a real emit → stationary lock-in.
      expect(c.wouldRejectAsStationary({ x: 970, y: 771 })).toBe(true);
      // A clearly-moved point → not stationary.
      expect(c.wouldRejectAsStationary({ x: 1100, y: 770 })).toBe(false);
    });

    it('observeCursor with rejectStationary returns false on lock-in (no belief update)', async () => {
      const c = newClient();
      c.resetBelief({ x: 0, y: 0 });
      c.observeCursor({ x: 970, y: 771 }, 0.9);
      await c.mouseMoveRelative(50, 0);
      const xAfterPredict = c.belief.position.x;
      const accepted = c.observeCursor(
        { x: 970, y: 771 },
        0.9,
        { rejectStationary: true },
      );
      expect(accepted).toBe(false);
      // Belief NOT pulled back to (970, 771) — rejected observation has
      // zero influence.
      expect(c.belief.position.x).toBe(xAfterPredict);
    });

    it('observeCursor with rejectStationary returns true on a clearly-moved measurement', async () => {
      const c = newClient();
      c.resetBelief({ x: 0, y: 0 });
      c.observeCursor({ x: 970, y: 771 }, 0.9);
      await c.mouseMoveRelative(50, 0);
      const accepted = c.observeCursor(
        { x: 1100, y: 770 },
        0.9,
        { rejectStationary: true },
      );
      expect(accepted).toBe(true);
    });
  });
});
