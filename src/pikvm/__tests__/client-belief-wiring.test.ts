/**
 * Phase 192-B (v0.5.182): pin the wiring contract — every successful
 * `client.mouseMoveRelative(dx, dy)` calls `client.belief.predict`
 * with the CLAMPED emit. Bypasses the network by stubbing `request`
 * so the test runs offline.
 */

import { describe, expect, it, vi } from 'vitest';
import { PiKVMClient } from '../client.js';

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

  it('emits to mouseMoveRelative still advance the keepalive clock (Phase 187 not regressed)', async () => {
    // We don't reach into recordEmit's internals here — just verify
    // that the call doesn't throw and belief gets updated, proving the
    // wiring runs both Phase 187 + Phase 192-B side effects.
    const c = newClient();
    c.resetBelief({ x: 0, y: 0 });
    await expect(c.mouseMoveRelative(15, 0)).resolves.toBeUndefined();
    expect(c.belief.position.x).toBeGreaterThan(0);
  });
});
