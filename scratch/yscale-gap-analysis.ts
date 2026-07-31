/** Task #41 PHASE 0 — WHY the behavioral Y compensation (3.64%) exceeds the
 *  geometric ratio (2.51%) by ~1pp. READ-ONLY analysis: imports the real planning
 *  code, changes nothing. Deliverable: what the self-calibration must fit against.
 *
 *  usage: npx tsx scratch/yscale-gap-analysis.ts
 */
import { EMIT_CURVE_X, FULL_REPORT_PX, Y_SCALE, planAxisEmits } from '../src/pikvm/curve-mover.js';

// ── The curves ────────────────────────────────────────────────────────────────
// The code MODELS Y as X-px × Y_SCALE(0.965), PIECEWISE-LINEAR through the points.
const CURVE_Y_MODEL = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const);
const FULL_Y_MODEL = FULL_REPORT_PX * Y_SCALE; // 151.505 px = what the plan targets

// Ground truth from georgs's rig:
//   equal-mickey Y:X ratio = 0.9892 ; per-full-report Y = 155.55 measured (ratio 0.9908)
//   behaviorally-validated curveScaleY = 1.0364 (fit to LANDING error)
const TRUE_RATIO_EQUALMICKEY = 0.9892;
const TRUE_FULL_Y = 155.55;
const TRUE_RATIO_FULLREPORT = TRUE_FULL_Y / FULL_REPORT_PX; // 0.9908
const BEHAVIORAL_SCALE = 1.0364;

// Piecewise-LINEAR eval of a curve at mickeys m (what mickeysForReport assumes).
function linearPxAt(m: number, curve: ReadonlyArray<readonly [number, number]>): number {
  const a = Math.max(0, Math.min(127, Math.abs(m)));
  for (let i = 1; i < curve.length; i++) {
    if (a <= curve[i][0]) {
      const [m0, p0] = curve[i - 1], [m1, p1] = curve[i];
      return p0 + (p1 - p0) * (a - m0) / (m1 - m0);
    }
  }
  return curve[curve.length - 1][1];
}

// Monotone cubic (Fritsch–Carlson) — a plausible SMOOTH truth through the measured
// points, to isolate the piecewise-linear INTERPOLATION error on the partial report.
function makePCHIP(pts: ReadonlyArray<readonly [number, number]>) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const n = xs.length, h: number[] = [], d: number[] = [];
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  m[n - 1] = d[n - 2];
  return (x: number): number => {
    const a = Math.max(xs[0], Math.min(xs[n - 1], x));
    let i = 0; while (i < n - 2 && a > xs[i + 1]) i++;
    const t = (a - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return ys[i] * (2 * t3 - 3 * t2 + 1) + h[i] * m[i] * (t3 - 2 * t2 + t)
      + ys[i + 1] * (-2 * t3 + 3 * t2) + h[i] * m[i + 1] * (t3 - t2);
  };
}
const trueXsmooth = makePCHIP(EMIT_CURVE_X);

// True Y displacement of an emitted mickey count, under a given TRUTH model.
function trueYpx(mick: number, mode: 'linear' | 'smooth', ratio = TRUE_RATIO_FULLREPORT): number {
  const xpx = mode === 'linear' ? linearPxAt(mick, EMIT_CURVE_X) : trueXsmooth(Math.abs(mick));
  return xpx * ratio;
}

// Simulate a Y move to target T using the REAL planner, return actual landing px.
function landingY(T: number, scaleY: number, truth: 'linear' | 'smooth', ratio = TRUE_RATIO_FULLREPORT) {
  const emits = planAxisEmits(T, FULL_Y_MODEL, CURVE_Y_MODEL, scaleY);
  let full = 0, partial = 0, nFull = 0;
  for (const e of emits) {
    if (Math.abs(e) === 127) { full += trueYpx(127, truth, ratio); nFull++; }
    else partial += trueYpx(e, truth, ratio);
  }
  return { landed: full + partial, full, partial, nFull, emits };
}

const DISTS: number[] = [];
for (let T = 120; T <= 900; T += 7) DISTS.push(T);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function overshootStats(scaleY: number, truth: 'linear' | 'smooth', ratio = TRUE_RATIO_FULLREPORT) {
  const pct = DISTS.map((T) => (landingY(T, scaleY, truth, ratio).landed / T - 1) * 100);
  const abs = DISTS.map((T) => landingY(T, scaleY, truth, ratio).landed - T);
  return { medPct: med(pct), meanPct: mean(pct), medAbs: med(abs), maxAbs: Math.max(...abs.map(Math.abs)) };
}

// Best single scalar scaleY that zeroes MEDIAN landing residual (px), + its spread.
function bestScale(truth: 'linear' | 'smooth', ratio = TRUE_RATIO_FULLREPORT) {
  let best = 1, bestErr = Infinity;
  for (let s = 0.98; s <= 1.08; s += 0.0002) {
    const resid = DISTS.map((T) => Math.abs(landingY(T, s, truth, ratio).landed - T));
    const e = med(resid);
    if (e < bestErr) { bestErr = e; best = s; }
  }
  const resid = DISTS.map((T) => landingY(T, best, truth, ratio).landed - T);
  return { scale: best, medResid: med(resid.map(Math.abs)), maxResid: Math.max(...resid.map(Math.abs)) };
}

console.log('=== #41 PHASE 0: geometric-vs-behavioral Y gap ===\n');
console.log(`model full-report Y = ${FULL_Y_MODEL.toFixed(3)}px ; measured = ${TRUE_FULL_Y}px  (+${((TRUE_FULL_Y/FULL_Y_MODEL-1)*100).toFixed(2)}%)`);
console.log(`geometric ratios: region/equal-mickey ${TRUE_RATIO_EQUALMICKEY} vs Y_SCALE ${Y_SCALE} = +${((TRUE_RATIO_EQUALMICKEY/Y_SCALE-1)*100).toFixed(2)}%`);
console.log(`behavioral curveScaleY = ${BEHAVIORAL_SCALE} = +${((BEHAVIORAL_SCALE-1)*100).toFixed(2)}%\n`);

console.log('--- landing overshoot at scaleY=1 (uncompensated), per TRUTH model ---');
for (const truth of ['linear', 'smooth'] as const) {
  const s = overshootStats(1, truth);
  console.log(`  truth=${truth.padEnd(6)}  median overshoot ${s.medPct.toFixed(2)}%  mean ${s.meanPct.toFixed(2)}%  medAbs ${s.medAbs.toFixed(1)}px  maxAbs ${s.maxAbs.toFixed(1)}px`);
}

console.log('\n--- best single-scalar fit to LANDING error, per TRUTH model ---');
for (const truth of ['linear', 'smooth'] as const) {
  const b = bestScale(truth);
  console.log(`  truth=${truth.padEnd(6)}  best scaleY ${b.scale.toFixed(4)} (+${((b.scale-1)*100).toFixed(2)}%)  residual med ${b.medResid.toFixed(1)}px  max ${b.maxResid.toFixed(1)}px`);
}

console.log('\n--- decompose a few moves: full vs partial contribution (scaleY=1, smooth truth) ---');
for (const T of [160, 300, 500, 700, 900]) {
  const r = landingY(T, 1, 'smooth');
  const fullOv = r.full - r.nFull * FULL_Y_MODEL;      // overshoot from full reports (model target FULL_Y_MODEL each)
  const modelRem = T - r.nFull * FULL_Y_MODEL;          // what the partial was TARGETING
  const partialOv = r.partial - modelRem;              // overshoot from the partial report
  console.log(`  T=${String(T).padStart(3)}  nFull=${r.nFull} rem=${modelRem.toFixed(1)}  landed ${r.landed.toFixed(1)} (ov ${(r.landed-T).toFixed(1)}px)  | fullOv ${fullOv.toFixed(1)} partialOv ${partialOv.toFixed(2)}`);
}

console.log('\n=== THE CRUX ===');
const needFullY = FULL_Y_MODEL * BEHAVIORAL_SCALE;
console.log(`To land the behavioral +3.64%, the EFFECTIVE per-report Y in a real move must be ${needFullY.toFixed(2)}px.`);
console.log(`  measured (isolated/equal-mickey) full-report Y = ${TRUE_FULL_Y}px  →  short by ${(needFullY-TRUE_FULL_Y).toFixed(2)}px = ${((needFullY/TRUE_FULL_Y-1)*100).toFixed(2)}%`);
console.log(`  note: ${needFullY.toFixed(1)}px ≈ the X full-report ${FULL_REPORT_PX}px → in a real burst the Y:X ratio is ~${(needFullY/FULL_REPORT_PX).toFixed(4)}, NOT the isolated ${TRUE_RATIO_EQUALMICKEY}`);
console.log(`\nInterpolation (linear→smooth) moved the median only ${(overshootStats(1,'smooth').medPct - overshootStats(1,'linear').medPct).toFixed(2)}pp — it is NOT the ~1pp gap.`);
console.log(`Every RATIO-based fit lands ~2.66-2.68%; only fitting to LANDINGS from real paced bursts recovers +3.64%.`);
