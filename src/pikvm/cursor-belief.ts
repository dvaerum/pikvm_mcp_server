/**
 * Phase 192-A (v0.5.181) — `CursorBelief`: a Kalman-style state
 * estimator for the on-screen mouse cursor.
 *
 * Replaces scattered point-in-time hints (`expectedNear` ad-hoc
 * computation in `moveToPixel`, `lastMoveResult.finalDetectedPosition`
 * carried across calls, `usedPxPerMickey` re-discovered every move,
 * `cursor-keepalive`'s `lastEmitMs`) with one coherent probabilistic
 * model.
 *
 * Live frame-by-frame trajectory data (Phase 192, 2026-05-09) drives
 * the design:
 *   - Per-chunk px/mickey ratio varies 1.25-1.75 within a single
 *     trajectory → ratio is itself a tracked random variable, not a
 *     constant.
 *   - 12 chunks of cursor-pinned-against-an-edge produced zero
 *     visible motion while the algorithm assumed +400 px of travel
 *     → predict() must clip to bounds AND inflate variance on the
 *     clipped axis ("we know cursor is somewhere on the edge, not
 *     exactly where").
 *   - State must persist across calls → owned by `PiKVMClient` (Phase
 *     192-B will wire it in).
 *
 * Diagonal-only covariance — cross-axis correlation is small for
 * iPad relative-mouse and the simpler math is plenty given the
 * observation noise. Four scalars instead of a 4×4 matrix.
 *
 * Pure / deterministic / no I/O. The class state is local; nothing
 * in this file reaches into network, disk, or PiKVMClient.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BeliefRegion {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface BeliefEdges {
  north: boolean;
  south: boolean;
  east: boolean;
  west: boolean;
}

export interface CursorBeliefOptions {
  initialPosition: { x: number; y: number };
  /** Initial position variance per axis (px²). Default 25 (σ=5px). */
  initialPositionVariance?: number;
  /** Calibration prior for px/mickey. Default 1.3 on each axis (iPad fleet). */
  ratioPrior?: { x: number; y: number };
  /** Variance on the ratio prior. Default 0.1 each axis (σ≈0.32 px/mickey). */
  ratioVariancePrior?: { x: number; y: number };
  /** Screen bounds for clip-and-inflate behaviour. Optional. */
  bounds?: Bounds | null;
  /** Process noise scale: variance added per |emit|. Default 0.5. */
  processNoiseScale?: number;
  /** Variance contributed to the position when cursor lands at an
   *  edge — we don't know where on the edge it actually sits.
   *  Per emit. Default 100. */
  edgeClipVariance?: number;
  /** Sanity floor / ceiling on live-measured ratio (px/mickey). The
   *  ratio belief never updates past these. Default [0.5, 3.0]
   *  (matches the live observed range 1.25-1.75 with safety margin). */
  ratioClamp?: { min: number; max: number };
}

export class CursorBelief {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  variance: { x: number; y: number; vx: number; vy: number };
  ratio: { x: number; y: number; vx: number; vy: number }; // ratio mean per axis + ratio variance per axis
  bounds: Bounds | null;
  lastUpdateMs: number;

  private readonly processNoiseScale: number;
  private readonly edgeClipVariance: number;
  private readonly ratioClampMin: number;
  private readonly ratioClampMax: number;

  constructor(opts: CursorBeliefOptions) {
    this.position = { ...opts.initialPosition };
    this.velocity = { x: 0, y: 0 };
    const v0 = opts.initialPositionVariance ?? 25;
    this.variance = { x: v0, y: v0, vx: 1, vy: 1 };
    const rPrior = opts.ratioPrior ?? { x: 1.3, y: 1.3 };
    const rVar = opts.ratioVariancePrior ?? { x: 0.1, y: 0.1 };
    this.ratio = { x: rPrior.x, y: rPrior.y, vx: rVar.x, vy: rVar.y };
    this.bounds = opts.bounds ?? null;
    this.lastUpdateMs = Date.now();
    this.processNoiseScale = opts.processNoiseScale ?? 0.5;
    this.edgeClipVariance = opts.edgeClipVariance ?? 100;
    this.ratioClampMin = opts.ratioClamp?.min ?? 0.5;
    this.ratioClampMax = opts.ratioClamp?.max ?? 3.0;
  }

  /**
   * Forward-predict the belief by an emit. Position += emit · ratio,
   * variance grows by process noise + ratio uncertainty contribution.
   * If the predicted position projects past a bound, the position is
   * clamped to the edge and the clipped-axis variance is inflated.
   */
  predict(emit: { dx: number; dy: number }, nowMs?: number): void {
    const t = nowMs ?? Date.now();
    // Snapshot pre-emit position so a later observe() can compute
    // live ratio honestly even after the position has been Kalman-
    // updated. Without this snapshot, kalmanUpdateRatio would try
    // to reconstruct the pre-emit position from the post-observation
    // position and produce nonsense.
    const prePosX = this.position.x;
    const prePosY = this.position.y;
    // Position: belief.x += emit.dx * ratio.x  (per axis).
    const newX = this.position.x + emit.dx * this.ratio.x;
    const newY = this.position.y + emit.dy * this.ratio.y;

    // Variance growth:
    //   processNoise = processNoiseScale * |emit|
    //   ratioContribution = ratioVariance * emit² (because position
    //     variance from a noisy ratio is var(r·dx) = var(r)·dx² when
    //     dx is deterministic).
    const adx = Math.abs(emit.dx);
    const ady = Math.abs(emit.dy);
    let newVarX = this.variance.x + this.processNoiseScale * adx + this.ratio.vx * adx * adx;
    let newVarY = this.variance.y + this.processNoiseScale * ady + this.ratio.vy * ady * ady;

    // Clip-and-inflate on bounds. When the predicted position would
    // project outside the bounding box, snap to the edge and add
    // edgeClipVariance to the clipped-axis variance — we know the
    // cursor is "somewhere on the edge" but lost track of where.
    let clippedX = false;
    let clippedY = false;
    if (this.bounds) {
      const minX = this.bounds.x;
      const maxX = this.bounds.x + this.bounds.width;
      const minY = this.bounds.y;
      const maxY = this.bounds.y + this.bounds.height;
      const finalX = Math.max(minX, Math.min(maxX, newX));
      const finalY = Math.max(minY, Math.min(maxY, newY));
      if (finalX !== newX) {
        clippedX = true;
        newVarX += this.edgeClipVariance;
      }
      if (finalY !== newY) {
        clippedY = true;
        newVarY += this.edgeClipVariance;
      }
      this.position.x = finalX;
      this.position.y = finalY;
    } else {
      this.position.x = newX;
      this.position.y = newY;
    }

    this.variance.x = newVarX;
    this.variance.y = newVarY;
    this.lastUpdateMs = t;

    // Record the emit + pre-emit position so a later observe() can
    // compute the live ratio = (measurement - prePos) / emit.
    // If we DID clip, the actual motion was less than commanded;
    // ratio updates skip the clipped axis (cursor stopped at the
    // wall — not a valid ratio sample).
    this._lastEmit = { dx: emit.dx, dy: emit.dy, clippedX, clippedY, prePosX, prePosY };
  }

  /**
   * Observe the cursor's measured position and update the belief
   * via Kalman gain. `confidence` ∈ [0, 1]: 1 = perfect measurement,
   * 0 = ignore.
   *
   * If a recent emit is on record (from `predict`), the observation
   * also updates the ratio belief — the live measurement of how far
   * the cursor moved per emitted mickey, fused with the prior via
   * the same Kalman-gain math on the ratio variable.
   */
  observe(measurement: { x: number; y: number }, confidence: number): void {
    if (confidence <= 0 || !Number.isFinite(confidence)) return;
    const c = Math.min(1, confidence);
    // Position update. Observation noise R is high when confidence is
    // low — at c=1 R is the floor; at c=0.01 R is large.
    const R = this.observationNoise(c);
    this.kalmanUpdatePosition(measurement, R);
    // Ratio update: only when a recent (single) emit drove the position
    // and we can attribute the observed motion to that emit.
    if (this._lastEmit && (this._lastEmit.dx !== 0 || this._lastEmit.dy !== 0)) {
      this.kalmanUpdateRatio(measurement, c);
    }
  }

  /**
   * Return the search region the caller should bias detection toward.
   * Radii are scaled to a 1D Gaussian quantile so a 95% region is
   * roughly ±1.96σ.
   */
  expectedRegion(confidence = 0.95): BeliefRegion {
    // Approximate inverse normal CDF via the Φ⁻¹(p) for p ∈ [0.5, 1].
    // 95% two-sided → 1.96; 99% → 2.58; 68% → 1.0.
    const z = this.invNormalQuantile(0.5 + confidence / 2);
    const sigmaX = Math.sqrt(this.variance.x);
    const sigmaY = Math.sqrt(this.variance.y);
    return {
      cx: this.position.x,
      cy: this.position.y,
      rx: z * sigmaX,
      ry: z * sigmaY,
    };
  }

  /**
   * Per-edge boolean: is the cursor within `threshold` px of each of
   * the four bounds? All-false when no bounds are known.
   */
  isAtEdge(threshold = 10): BeliefEdges {
    if (!this.bounds) {
      return { north: false, south: false, east: false, west: false };
    }
    const minX = this.bounds.x;
    const maxX = this.bounds.x + this.bounds.width;
    const minY = this.bounds.y;
    const maxY = this.bounds.y + this.bounds.height;
    return {
      west: this.position.x - minX <= threshold,
      east: maxX - this.position.x <= threshold,
      north: this.position.y - minY <= threshold,
      south: maxY - this.position.y <= threshold,
    };
  }

  /**
   * Replace state with a known observation. Used after slam,
   * locateCursor probe, or template seed — anywhere we have
   * ground truth and want to discard the running belief.
   */
  reset(observation: { x: number; y: number }, confidence = 1.0): void {
    void confidence; // accepted but ignored — reset is unconditional
    this.position = { ...observation };
    this.velocity = { x: 0, y: 0 };
    // Tight position variance after reset; ratio belief preserved
    // (calibration we've learned shouldn't be discarded just because
    // we re-anchored position).
    this.variance.x = 1;
    this.variance.y = 1;
    this.variance.vx = 1;
    this.variance.vy = 1;
    this.lastUpdateMs = Date.now();
    this._lastEmit = null;
  }

  // -- internals --------------------------------------------------------

  private _lastEmit: { dx: number; dy: number; clippedX: boolean; clippedY: boolean; prePosX: number; prePosY: number } | null = null;

  /** Map a confidence c ∈ (0, 1] to observation noise variance. Lower
   *  confidence → larger R → less weight on the measurement. */
  private observationNoise(c: number): number {
    // c=1 → R=1 (very tight); c=0.5 → R=4; c=0.1 → R=100; c=0.01 → R=10⁴.
    return 1 / (c * c);
  }

  private kalmanUpdatePosition(measurement: { x: number; y: number }, R: number): void {
    // Per-axis scalar Kalman update.
    for (const axis of ['x', 'y'] as const) {
      const P = this.variance[axis];
      const K = P / (P + R);
      this.position[axis] = this.position[axis] + K * (measurement[axis] - this.position[axis]);
      this.variance[axis] = (1 - K) * P;
    }
  }

  private kalmanUpdateRatio(measurement: { x: number; y: number }, c: number): void {
    // Compute the observed displacement per axis since the recorded
    // emit. (We assume position pre-emit was the BELIEF's position
    // before the predict() call. Since we've now observed the
    // measured position post-emit, the difference is the actual
    // motion; divide by emit magnitude to get live ratio.)
    if (!this._lastEmit) return;
    const { dx, dy, clippedX, clippedY, prePosX, prePosY } = this._lastEmit;
    // If the emit was clipped on an axis, the observed motion isn't a
    // valid ratio sample for that axis (cursor stopped at the wall).
    // Use the SNAPSHOTTED pre-emit position, not the current position
    // (which has just been updated by kalmanUpdatePosition).
    if (dx !== 0 && !clippedX) {
      const liveRatio = (measurement.x - prePosX) / dx;
      this.updateRatioAxis('x', liveRatio, c);
    }
    if (dy !== 0 && !clippedY) {
      const liveRatio = (measurement.y - prePosY) / dy;
      this.updateRatioAxis('y', liveRatio, c);
    }
  }

  private updateRatioAxis(axis: 'x' | 'y', liveRatio: number, c: number): void {
    if (!Number.isFinite(liveRatio)) return;
    // Clamp insane live ratios so a single noisy observation can't
    // collapse the ratio to 0.1 or 30.
    const clamped = Math.max(this.ratioClampMin, Math.min(this.ratioClampMax, liveRatio));
    const varKey = axis === 'x' ? 'vx' as const : 'vy' as const;
    const meanKey = axis as 'x' | 'y';
    const P = this.ratio[varKey];
    const R = this.observationNoise(c);
    const K = P / (P + R);
    this.ratio[meanKey] = this.ratio[meanKey] + K * (clamped - this.ratio[meanKey]);
    this.ratio[varKey] = (1 - K) * P;
  }

  /** Approximate inverse normal CDF for p ∈ (0.5, 1).
   *  Beasley-Springer-Moro polynomial — 4-decimal accuracy. */
  private invNormalQuantile(p: number): number {
    // Defensive bounds.
    if (p <= 0.5) return 0;
    if (p >= 1) return 6;
    // Beasley-Springer-Moro for p ∈ (0.5, 0.92).
    const x = p - 0.5;
    if (Math.abs(x) <= 0.42) {
      const r = x * x;
      const num = ((-25.44106 * r + 41.39119) * r - 18.61500) * r + 2.50663;
      const den = (((3.13083 * r - 21.06224) * r + 23.08337) * r - 8.47351) * r + 1;
      return x * num / den;
    }
    // Tail approximation.
    let r = 1 - p;
    if (r <= 0) return 6;
    r = Math.log(-Math.log(r));
    return 1.0 + r * (0.4361836 + r * (-0.1201676 + r * 0.1393820));
  }
}
