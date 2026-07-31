/** Task #41 — estimator + guard math for PASSIVE continuous curveScale learning.
 *
 * Every real move already yields a FREE sample: planned displacement P (target −
 * start) vs achieved A (landed − start), per axis, both from the detector the mover
 * already runs. A/P reveals the scale correction; the running estimate of the true
 * scale is  s_est = (A/P) · s_applied.  Real moves are paced bursts, so these samples
 * are in the correct velocity regime by construction (phase-0 finding) — the
 * isolated-ratio trap cannot occur here.
 *
 * This quantifies: single-move vs windowed-median noise, window size, cold-start
 * convergence, median-vs-mean under V8 false-positives, and a min-distance gate.
 * READ-ONLY analysis; seeded RNG for reproducibility. Nothing here touches the mover.
 *
 * usage: npx tsx scratch/yscale-estimator-sim.ts
 */

// ── seeded RNG (mulberry32) + gaussian ─────────────────────────────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeGauss(rng: () => number) {
  return (mu = 0, sd = 1) => {
    const u1 = Math.max(1e-12, rng()), u2 = rng();
    return mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.min(s.length - 1, Math.floor(q * s.length)))]; };
// Robust σ estimate (IQR/1.349) — outlier-resistant, so the V8-FP tail doesn't inflate it.
const robustStd = (a: number[]) => (quantile(a, 0.75) - quantile(a, 0.25)) / 1.349;

// ── model constants ────────────────────────────────────────────────────────────
const S_TRUE = 1.0364;         // the burst-regime scale phase-0 says landing-fit recovers
const SIGMA_DETECT = 3.0;      // px per endpoint (V8 cascade; georgs residual median ~2.2, max 8.1)
const SIGMA_A = Math.SQRT2 * SIGMA_DETECT; // achieved = landed−start → two noisy endpoints
const P_FP = 0.05;             // fraction of moves whose detection is a V8 false-positive
const FP_ERR = 120;            // px gross error on an FP sample

// One passive sample of s_true from a move of planned distance P (px), at applied
// scale s_applied. A/P = s_true/s_applied + noise/P, so sample = (A/P)·s_applied.
function sampleScale(P: number, sApplied: number, gauss: (mu?: number, sd?: number) => number, rng: () => number): number {
  const ideal = P * (S_TRUE / sApplied);          // what the device actually displaces
  const isFp = rng() < P_FP;
  const A = ideal + gauss(0, SIGMA_A) + (isFp ? (rng() < 0.5 ? -1 : 1) * FP_ERR : 0);
  return (A / P) * sApplied;
}

// realistic-ish per-axis planned distances: broad mix of short refine + long jumps
function drawDistance(rng: () => number): number {
  // 45% short (40-250), 55% long (250-900)
  return rng() < 0.45 ? 40 + rng() * 210 : 250 + rng() * 650;
}

console.log('=== #41 estimator + guard math ===');
console.log(`S_TRUE=${S_TRUE}  σ_detect=${SIGMA_DETECT}px/endpoint (σ_A=${SIGMA_A.toFixed(2)})  V8-FP rate=${P_FP}\n`);

// 1) SINGLE-MOVE noise by distance — the 1/P law that motivates a distance gate.
console.log('--- single-move s estimate noise, by planned distance (no window) ---');
for (const P of [60, 120, 250, 500, 800]) {
  const g = makeGauss(mulberry32(P));
  const r = mulberry32(P * 7);
  const samples = Array.from({ length: 4000 }, () => sampleScale(P, 1.0, g, r));
  console.log(`  P=${String(P).padStart(3)}px  median ${median(samples).toFixed(4)}  robust σ ${(robustStd(samples) * 100).toFixed(2)}%  (≈σ_A/P = ${(SIGMA_A / P * 100).toFixed(2)}%)`);
}

// 2) WINDOWED rolling-median: steady-state noise + median-vs-mean under FPs.
console.log('\n--- rolling estimator over a window (mixed distances), steady state ---');
for (const W of [5, 10, 20, 40]) {
  const g = makeGauss(mulberry32(1234));
  const r = mulberry32(9999);
  const win: number[] = [];
  const medEst: number[] = [], meanEst: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const P = drawDistance(r);
    win.push(sampleScale(P, 1.0, g, r));
    if (win.length > W) win.shift();
    if (win.length === W) { medEst.push(median(win)); meanEst.push(mean(win)); }
  }
  console.log(`  W=${String(W).padStart(2)}  MEDIAN est ${median(medEst).toFixed(4)} σ ${(std(medEst) * 100).toFixed(2)}%  |  MEAN est ${median(meanEst).toFixed(4)} σ ${(std(meanEst) * 100).toFixed(2)}%  <- mean drags on the ${P_FP * 100}% FPs`);
}

// 3) DISTANCE-GATED window: only accept P above a threshold — cuts the short-move noise.
console.log('\n--- rolling MEDIAN (W=20) with a min-distance acceptance gate ---');
for (const gate of [0, 150, 300]) {
  const g = makeGauss(mulberry32(55)); const r = mulberry32(77);
  const win: number[] = []; const est: number[] = []; let accepted = 0, seen = 0;
  for (let i = 0; i < 12000; i++) {
    const P = drawDistance(r); seen++;
    if (P < gate) continue;
    accepted++;
    win.push(sampleScale(P, 1.0, g, r)); if (win.length > 20) win.shift();
    if (win.length === 20) est.push(median(win));
  }
  console.log(`  gate ≥${String(gate).padStart(3)}px  accept ${(accepted / seen * 100).toFixed(0)}% of moves  est ${median(est).toFixed(4)} σ ${(std(est) * 100).toFixed(2)}%`);
}

// 4) COLD-START convergence: from s=1.0, how many real moves to land within ±0.5% of S_TRUE
//    and STAY there. With rate-limit (≤2%/update) + sanity band [0.85,1.15].
console.log('\n--- cold-start convergence (s0=1.0, gate≥150, W=20 [update at ≥5], rate-limit 2%/update, band[0.85,1.15]) ---');
// "converged" = FIRST accepted-move at which s is within ±0.5% of S_TRUE. Steady-state
// wobble after that is the W=20 σ (~0.3%), reported separately above — not a re-convergence.
function convergeRun(seed: number): { firstReach: number; final: number; maxStep: number } {
  const g = makeGauss(mulberry32(seed)); const r = mulberry32(seed * 3 + 1);
  const win: number[] = []; let s = 1.0; let maxStep = 0; let firstReach = -1; let accepted = 0;
  for (let move = 0; move < 400; move++) {
    const P = drawDistance(r);
    if (P < 150) continue;
    accepted++;
    win.push(sampleScale(P, s, g, r)); if (win.length > 20) win.shift();
    if (win.length >= 5) {
      let target = Math.max(0.85, Math.min(1.15, median(win)));        // sanity band
      const step = Math.max(-0.02 * s, Math.min(0.02 * s, target - s)); // rate limit ≤2%
      s += step; maxStep = Math.max(maxStep, Math.abs(step) / s * 100);
    }
    if (firstReach < 0 && Math.abs(s - S_TRUE) / S_TRUE < 0.005) firstReach = accepted;
  }
  return { firstReach, final: s, maxStep };
}
const runs = Array.from({ length: 300 }, (_, i) => convergeRun(i + 1));
const reach = runs.map((x) => x.firstReach).filter((m) => m > 0);
console.log(`  first reach ±0.5% of target: MEDIAN ${median(reach)} accepted-gate moves (p90 ${quantile(reach, 0.9)}); ${(reach.length / runs.length * 100).toFixed(0)}% reached within 400 moves`);
console.log(`  final scale after 400 moves: median ${median(runs.map((x) => x.final)).toFixed(4)} (target ${S_TRUE}); max single-update step ever ${Math.max(...runs.map((x) => x.maxStep)).toFixed(2)}% (rate-limit held at 2%)`);

console.log('\n=== takeaways ===');
console.log('• per-move noise ≈ σ_A/P: a 60px move is ±7%, an 800px move ±0.5% — GATE on distance (≥150px) or the short moves dominate the noise.');
console.log('• MEDIAN over W=20 is the estimator: it ignores the 5% V8-FP outliers that bias the mean; steady-state σ ~sub-0.5%.');
console.log('• Rate-limit (≤2%/update) + band [0.85,1.15] make lurching structurally impossible; convergence unaffected — the true correction is small and a real drift is adopted in ~2-3 updates.');
console.log('• Per-move samples center on S_TRUE by construction (real moves ARE bursts) → the estimator recovers +3.64%, not the 2.51% ratio.');
console.log('• Cold-start-from-1.0 reaches target in ~6 gated moves — BUT those 6 clicks are uncorrected (~25px). So seed from the shipped 1.0364 default (warm start: no cold miss-streak) and PERSIST the learned value to ballistics.json so a restart / the next session skips re-learning and never regresses to a bad cold scale.');
