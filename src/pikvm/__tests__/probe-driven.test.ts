/**
 * Phase 26 — probe-driven correction loop (Direction 2 from
 * docs/troubleshooting/ipad-cursor-detection.md).
 *
 * The current move-to.ts correction loop estimates cursor position from
 * motion-diff against the open-loop emit, then trusts that estimate.
 * On busy iPad backdrops motion-diff can pick wrong pairs (live trial 1,
 * 240 px error) or fail entirely (trial 2). The probe-driven approach
 * replaces motion-diff with locateCursor probes — known-emit + observe —
 * which give ground-truth cursor position regardless of backdrop noise.
 *
 * Each iteration: emit small step toward target, locateCursor probe,
 * update belief, repeat until convergence or budget exhausted.
 *
 * Tests use an injected probeFn so we don't have to mock screenshots.
 * The probeFn updates the simulated cursor based on the test's chosen
 * physics model (deterministic for happy-path, perturbed for stress).
 */

import { describe, expect, it } from 'vitest';
import { moveToPixelProbeDriven } from '../move-to-probe-driven.js';
import type { PiKVMClient } from '../client.js';

class TrackingClient {
  cursor: { x: number; y: number };
  /** px/mickey applied per axis. Tests can vary this to simulate
   *  iPadOS acceleration variance. */
  pxPerMickeyX: number;
  pxPerMickeyY: number;
  emitHistory: { dx: number; dy: number }[] = [];

  constructor(start: { x: number; y: number }, ratio = 1.5) {
    this.cursor = { ...start };
    this.pxPerMickeyX = ratio;
    this.pxPerMickeyY = ratio;
  }

  async mouseMoveRelative(dx: number, dy: number): Promise<void> {
    this.emitHistory.push({ dx, dy });
    this.cursor = {
      x: this.cursor.x + dx * this.pxPerMickeyX,
      y: this.cursor.y + dy * this.pxPerMickeyY,
    };
  }
}

describe('moveToPixelProbeDriven', () => {
  it('converges to target within tolerance under deterministic ratio', async () => {
    const client = new TrackingClient({ x: 100, y: 100 }, 1.5);
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      probeFn: async (c) => ({ position: (c as unknown as TrackingClient).cursor }),
      tolerance: 30,
      maxIterations: 20,
      pxPerMickeyEstimate: 1.5,
      maxStepMickeys: 50,
      settleMs: 0,
      verbose: false,
    });
    expect(result.success).toBe(true);
    expect(Math.hypot(result.finalPosition.x - 500, result.finalPosition.y - 500)).toBeLessThan(30);
  });

  it('returns success=false when initial locateCursor probe fails', async () => {
    const client = new TrackingClient({ x: 0, y: 0 });
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      probeFn: async () => null, // probe always fails
      tolerance: 30,
      maxIterations: 10,
      settleMs: 0,
    });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/initial.*locate|probe.*fail/i);
    expect(result.iterations).toBe(0);
  });

  it('falls back to estimated position when a mid-iteration probe fails, but does not crash', async () => {
    const client = new TrackingClient({ x: 100, y: 100 }, 1.5);
    let probeCount = 0;
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      probeFn: async (c) => {
        probeCount++;
        if (probeCount === 3) return null; // fail on 3rd probe
        return { position: (c as unknown as TrackingClient).cursor };
      },
      tolerance: 30,
      maxIterations: 20,
      pxPerMickeyEstimate: 1.5,
      maxStepMickeys: 50,
      settleMs: 0,
    });
    // We don't pin success/failure — just that it didn't throw and ran.
    expect(typeof result.success).toBe('boolean');
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('caps each step at maxStepMickeys', async () => {
    const client = new TrackingClient({ x: 0, y: 0 }, 1.0);
    await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 1000, y: 1000 }, {
      probeFn: async (c) => ({ position: (c as unknown as TrackingClient).cursor }),
      tolerance: 30,
      maxIterations: 50,
      pxPerMickeyEstimate: 1.0,
      maxStepMickeys: 30,
      settleMs: 0,
    });
    // Each emit's |dx|, |dy| should never exceed 30.
    for (const e of client.emitHistory) {
      expect(Math.abs(e.dx)).toBeLessThanOrEqual(30);
      expect(Math.abs(e.dy)).toBeLessThanOrEqual(30);
    }
  });

  it('returns success=false when budget exhausted before convergence', async () => {
    const client = new TrackingClient({ x: 0, y: 0 }, 0.1); // very low ratio
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 5000, y: 5000 }, {
      probeFn: async (c) => ({ position: (c as unknown as TrackingClient).cursor }),
      tolerance: 30,
      maxIterations: 3, // too few for the low ratio
      pxPerMickeyEstimate: 1.0,
      maxStepMickeys: 30,
      settleMs: 0,
    });
    expect(result.success).toBe(false);
    expect(result.iterations).toBe(3);
  });

  it('records per-iteration trace for diagnostics', async () => {
    const client = new TrackingClient({ x: 100, y: 100 }, 1.5);
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 300, y: 200 }, {
      probeFn: async (c) => ({ position: (c as unknown as TrackingClient).cursor }),
      tolerance: 30,
      maxIterations: 20,
      pxPerMickeyEstimate: 1.5,
      maxStepMickeys: 50,
      settleMs: 0,
    });
    expect(Array.isArray(result.trace)).toBe(true);
    expect(result.trace.length).toBeGreaterThanOrEqual(1);
    for (const t of result.trace) {
      expect(typeof t.cursorX).toBe('number');
      expect(typeof t.cursorY).toBe('number');
      expect(typeof t.emitX).toBe('number');
      expect(typeof t.emitY).toBe('number');
      expect(typeof t.residual).toBe('number');
    }
  });

  it('exits early on first iteration if already at target', async () => {
    const client = new TrackingClient({ x: 500, y: 500 }, 1.5);
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 510, y: 510 }, {
      probeFn: async (c) => ({ position: (c as unknown as TrackingClient).cursor }),
      tolerance: 30,
      maxIterations: 20,
      pxPerMickeyEstimate: 1.5,
      maxStepMickeys: 50,
      settleMs: 0,
    });
    // Already within tolerance from the initial probe → no emits issued.
    expect(result.success).toBe(true);
    expect(client.emitHistory.length).toBe(0);
  });

  it('handles per-iteration ratio variance (simulating iPadOS acceleration)', async () => {
    const client = new TrackingClient({ x: 100, y: 100 }, 1.5);
    let iter = 0;
    const result = await moveToPixelProbeDriven(client as unknown as PiKVMClient, { x: 500, y: 500 }, {
      probeFn: async (c) => {
        // Vary ratio per iteration: 0.5x – 2.5x of nominal.
        iter++;
        const t = iter as number;
        client.pxPerMickeyX = 1.5 * (0.5 + (t % 5) * 0.5);
        client.pxPerMickeyY = 1.5 * (0.5 + ((t + 2) % 5) * 0.5);
        return { position: (c as unknown as TrackingClient).cursor };
      },
      tolerance: 30,
      maxIterations: 30,
      pxPerMickeyEstimate: 1.5,
      maxStepMickeys: 30,
      settleMs: 0,
    });
    // Even with 5× ratio variance, the closed-loop iteration should converge
    // because each step is observed and corrected.
    expect(result.success).toBe(true);
  });
});
