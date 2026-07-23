/**
 * Pure metric helpers for the desktop end-to-end harness
 * (`benches/desktop-e2e.ts`). Kept out of the bench so the target-grid,
 * residual, landed-cluster, and summary logic is unit-testable WITHOUT a live
 * PiKVM — the harness itself needs a real desktop behind the appliance, but its
 * math should not.
 *
 * The harness measures the ABSOLUTE-mouse path (`--target desktop`): after
 * `auto_calibrate`, it drives `mouseMove(x,y)` to each grid target and uses a
 * motion diff to find where the cursor actually landed. Residual = pixel
 * distance between the landed cursor and the requested target.
 */

export interface Point {
  x: number;
  y: number;
}

/** A candidate cursor location from a motion diff (a cluster centroid). */
export interface ClusterCentroid {
  centroidX: number;
  centroidY: number;
  pixels: number;
}

export interface TrialResult {
  target: Point;
  /** Where the cursor was found after the move, or null if the diff found nothing. */
  landed: Point | null;
  /** Pixel distance landed↔target, or null when not located. */
  residualPx: number | null;
}

export interface Summary {
  n: number;
  located: number;
  /** Fraction of targets where the cursor was located after the move (0..1). */
  locateRate: number;
  /** Median / 90th-percentile residual over LOCATED trials (px); null if none located. */
  residualP50: number | null;
  residualP90: number | null;
  worstResidualPx: number | null;
  thresholdPx: number;
  /** True iff every target located AND residualP90 <= thresholdPx. */
  passed: boolean;
}

/**
 * A grid of absolute-pixel targets, inset from each edge by `marginFrac` of the
 * frame so targets never sit under a taskbar/menu bar or off-screen. Row-major
 * (top-left first). `cols`/`rows` >= 1.
 */
export function buildTargetGrid(
  width: number,
  height: number,
  cols: number,
  rows: number,
  marginFrac = 0.15,
): Point[] {
  if (cols < 1 || rows < 1) throw new Error('buildTargetGrid: cols and rows must be >= 1');
  if (marginFrac < 0 || marginFrac >= 0.5) {
    throw new Error('buildTargetGrid: marginFrac must be in [0, 0.5)');
  }
  const x0 = width * marginFrac;
  const x1 = width * (1 - marginFrac);
  const y0 = height * marginFrac;
  const y1 = height * (1 - marginFrac);
  // Single row/col → place at the midpoint (avoid div-by-zero); else span edges.
  const lerp = (a: number, b: number, i: number, n: number): number =>
    n === 1 ? (a + b) / 2 : a + ((b - a) * i) / (n - 1);
  const out: Point[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: Math.round(lerp(x0, x1, c, cols)), y: Math.round(lerp(y0, y1, r, rows)) });
    }
  }
  return out;
}

/** Euclidean pixel distance. */
export function residualPx(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * From the motion-diff clusters, pick the cursor landing: the cluster centroid
 * NEAREST the requested target (a move that lands near target produces a change
 * cluster there; picking nearest-to-target rejects unrelated screen churn).
 * Returns the landed point + its residual, or null when there are no clusters.
 */
export function pickLandedCluster(
  clusters: ClusterCentroid[],
  target: Point,
): { landed: Point; residualPx: number } | null {
  let best: { landed: Point; residualPx: number } | null = null;
  for (const c of clusters) {
    const landed = { x: c.centroidX, y: c.centroidY };
    const d = residualPx(landed, target);
    if (best === null || d < best.residualPx) best = { landed, residualPx: d };
  }
  return best;
}

/** Percentile (0..100) of a numeric list via nearest-rank; [] → null. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Roll trial results into a pass/fail summary. PASS requires every target
 * located AND the 90th-percentile residual within `thresholdPx` — so a single
 * blind miss (unlocated) or a fat tail fails the run.
 */
export function summarizeResiduals(results: TrialResult[], thresholdPx: number): Summary {
  const n = results.length;
  const residuals = results
    .filter((r) => r.residualPx !== null)
    .map((r) => r.residualPx as number);
  const located = residuals.length;
  const residualP50 = percentile(residuals, 50);
  const residualP90 = percentile(residuals, 90);
  const worstResidualPx = residuals.length ? Math.max(...residuals) : null;
  const passed =
    n > 0 && located === n && residualP90 !== null && residualP90 <= thresholdPx;
  return {
    n,
    located,
    locateRate: n === 0 ? 0 : located / n,
    residualP50,
    residualP90,
    worstResidualPx,
    thresholdPx,
    passed,
  };
}
