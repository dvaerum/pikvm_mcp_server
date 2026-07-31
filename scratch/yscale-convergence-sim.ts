/** Task #41 — is the SE apply-gate OPTIMISTIC about its own uncertainty?
 *
 * georgs's rig (2026-07-31): from a clean reset the learner's FIRST update landed at
 * ~1.020 (reproducibly) with SE reporting 0.50%, while the independent optimum is
 * ~1.031 — the gate declared 0.5% precision ~1% from truth. Hypothesis: SE =
 * 1.25·median(σ_i)/√N models only RANDOM detector noise and is blind to the SYSTEMATIC
 * ±direction asymmetry (#39: up 3.72% vs down 3.14%). This sim CHECKS THE MATHS: it
 * reproduces the estimator over ±-clustered traffic and compares the REPORTED SE to
 * the TRUE error at each update, then tests two candidate fixes (empirical-MAD gate;
 * balanced-direction requirement). READ-ONLY, seeded.
 *
 * usage: npx tsx scratch/yscale-convergence-sim.ts
 */
function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function makeGauss(rng: () => number) { return (mu = 0, sd = 1) => { const u1 = Math.max(1e-12, rng()), u2 = rng(); return mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); }; }
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mad = (a: number[]) => { const m = median(a); return median(a.map((v) => Math.abs(v - m))); };

const TRUE_UP = 1.0372, TRUE_DOWN = 1.0314;   // direction-dependent implied scale (#39)
const SIGMA_A = 5.1;                            // px landing noise (measured)
const WARM = 1.0364, RATE = 0.02, LO = 0.85, HI = 1.15, SE_GATE = 0.005, WMAX = 70;

// The single scalar that minimises MEDIAN |landing residual| over a balanced mix —
// the value the rig calls "the optimum" (independent of the estimator).
function optimalScalar(): number {
  let best = 1, bestErr = Infinity;
  for (let s = 1.0; s <= 1.06; s += 0.0002) {
    const resid = [TRUE_UP, TRUE_DOWN].map((t) => Math.abs(t / s - 1));
    const e = median(resid);
    if (e < bestErr) { bestErr = e; best = s; }
  }
  return best;
}
const OPT = optimalScalar();

interface Sample { implied: number; P: number; sign: number }
function seModel(win: Sample[]): number { return (1.25 * median(win.map((w) => (SIGMA_A * Math.SQRT2) / w.P))) / Math.sqrt(win.length); }
function seEmpirical(win: Sample[]): number { return (1.25 * (mad(win.map((w) => w.implied)) / 0.6745)) / Math.sqrt(win.length); }

// One move: signed distance P, true implied = direction constant + random noise/P.
function drawMove(rng: () => number, g: (m?: number, s?: number) => number, downBias: number): Sample {
  const up = rng() > downBias;                     // downBias=0.5 balanced; >0.5 = down-heavy
  const P = 300 + rng() * 590;                      // long moves ~300-890
  const implied = (up ? TRUE_UP : TRUE_DOWN) + g(0, SIGMA_A / P);
  return { implied, P, sign: up ? 1 : -1 };
}

function run(label: string, opts: { se: (w: Sample[]) => number; requireBalance?: number; downBias: number; seed: number }) {
  const g = makeGauss(mulberry32(opts.seed)); const r = mulberry32(opts.seed * 7 + 3);
  const win: Sample[] = []; let s = WARM; let firstUpdate: { move: number; s: number; se: number } | null = null;
  let move = 0;
  for (; move < 200; move++) {
    win.push(drawMove(r, g, opts.downBias)); if (win.length > WMAX) win.shift();
    if (win.length < 5) continue;
    const ups = win.filter((w) => w.sign > 0).length, downs = win.length - ups;
    if (opts.requireBalance !== undefined && Math.min(ups, downs) < opts.requireBalance) continue; // (a)
    const se = opts.se(win);
    if (se < SE_GATE) {
      const target = Math.max(LO, Math.min(HI, median(win.map((w) => w.implied))));
      const step = Math.max(-RATE * s, Math.min(RATE * s, target - s));
      if (step !== 0) { s += step; if (!firstUpdate) firstUpdate = { move: move + 1, s, se }; }
    }
  }
  const fu = firstUpdate;
  console.log(`  ${label.padEnd(34)} first-update @move ${String(fu?.move ?? '—').padStart(3)}  s=${fu ? fu.s.toFixed(4) : '—'}  reportedSE ${fu ? (fu.se * 100).toFixed(2) + '%' : '—'}  |  TRUE err at that update ${fu ? (Math.abs(fu.s - OPT) * 100).toFixed(2) + '%' : '—'}  |  final s=${s.toFixed(4)}`);
}

console.log('=== #41 SE-gate optimism check ===');
console.log(`direction implied: up ${TRUE_UP} / down ${TRUE_DOWN} (spread ${((TRUE_UP - TRUE_DOWN) * 100).toFixed(2)}%);  independent OPTIMUM ≈ ${OPT.toFixed(4)}\n`);

console.log('--- σ-MODEL SE gate (current code): reportedSE vs TRUE error at the first update ---');
for (const [lbl, db] of [['balanced mix', 0.5], ['down-heavy mix (0.7)', 0.7], ['up-heavy mix (0.3)', 0.3]] as const)
  run(lbl, { se: seModel, downBias: db, seed: 11 });
console.log('  ⇒ if reportedSE ≪ TRUE err, the σ-model gate is optimistic (measures random noise, not the systematic spread).');

console.log('\n--- FIX (c): EMPIRICAL-MAD SE gate (measure the actual dispersion, incl. the bimodal spread) ---');
for (const [lbl, db] of [['balanced mix', 0.5], ['down-heavy mix (0.7)', 0.7], ['up-heavy mix (0.3)', 0.3]] as const)
  run(lbl, { se: seEmpirical, downBias: db, seed: 11 });

console.log('\n--- FIX (a): require ≥8 samples in EACH direction before the first update (σ-model SE) ---');
for (const [lbl, db] of [['balanced mix', 0.5], ['down-heavy mix (0.7)', 0.7], ['up-heavy mix (0.3)', 0.3]] as const)
  run(lbl, { se: seModel, requireBalance: 8, downBias: db, seed: 11 });

console.log('\n--- FIX (a)+(c): empirical-MAD SE AND balanced-direction requirement ---');
for (const [lbl, db] of [['balanced mix', 0.5], ['down-heavy mix (0.7)', 0.7], ['up-heavy mix (0.3)', 0.3]] as const)
  run(lbl, { se: seEmpirical, requireBalance: 8, downBias: db, seed: 11 });

// ── THE REAL DRIVER (georgs 2026-07-31): a CONSTANT along-travel offset c biases
//    implied = s + c/P at EVERY sample, so median(implied) is biased ~c/P below s_true,
//    while the regression SLOPE (residual vs |P|) factors c into the intercept and
//    recovers s cleanly. Inject a known scale + offset and compare the two estimators.
console.log('\n=== median-of-implied vs regression-SLOPE, with a constant offset (the rig driver) ===');
function fitSlopeIntercept(pts: Array<{ x: number; y: number }>) {
  const n = pts.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const d = n * sxx - sx * sx; const slope = (n * sxy - sx * sy) / d; return { slope, intercept: (sy - slope * sx) / n };
}
const S = 1.031, sApp = 1.0364;                    // true scale; warm-start applied
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const stdev = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const fmt = (a: number[]) => `${mean(a).toFixed(4)} (bias ${((mean(a) - S) * 100).toFixed(2)}%, σ ${(stdev(a) * 100).toFixed(2)}%)`;
for (const c of [0, -5, -10]) {
  const medEsts: number[] = [], slopeEsts: number[] = [], correctedEsts: number[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const g = makeGauss(mulberry32(seed)); const r = mulberry32(seed * 13 + 5);
    const implied: number[] = []; const resid: Array<{ x: number; y: number }> = []; const Ps: number[] = [];
    for (let i = 0; i < 40; i++) {
      const P = 300 + r() * 590;
      const achievedMag = P * (S / sApp) + c + g(0, SIGMA_A);
      implied.push(sApp * (achievedMag / P)); resid.push({ x: P, y: achievedMag - P }); Ps.push(P);
    }
    const fit = fitSlopeIntercept(resid);
    medEsts.push(median(implied));
    slopeEsts.push(sApp * (1 + fit.slope));
    // intercept-corrected median: subtract the estimated constant's per-sample contribution.
    correctedEsts.push(median(implied.map((im, i) => im - sApp * fit.intercept / Ps[i])));
  }
  console.log(`  c=${String(c).padStart(3)}px  median ${fmt(medEsts)}  |  slope ${fmt(slopeEsts)}  |  intercept-corrected-median ${fmt(correctedEsts)}`);
}
console.log('  ⇒ median BIAS grows with |c| (∝ c/P); slope + corrected-median are UNBIASED — pick the lower-σ of those two.');

// ── THE RIG'S REAL PROFILE (georgs 2026-07-31, scratch/learn-speed.ts `long`):
//    per-axis the window sees only TWO distinct |P| — Y {888,444}, X {600,300}, both
//    signs, balanced. That's the ACTUAL two-cluster low-leverage case (the continuous
//    draw above over-mixes distances). The manager+iPad node explicitly asked to sim
//    THIS profile, not an idealized one. Two distinct x-values still identify a line,
//    so the slope must stay unbiased here too — verify, and note the median's bias
//    is axis-specific (worse on X: smaller P̄ ⇒ larger c/P̄).
console.log('\n=== REAL RIG PROFILE: only two distinct |P| per axis (Y{888,444}, X{600,300}) ===');
for (const [axis, dists] of [['Y', [888, 444]], ['X', [600, 300]]] as [string, number[]][]) {
  const Pbar = mean(dists);
  for (const c of [0, -5]) {
    const medEsts: number[] = [], slopeEsts: number[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const g = makeGauss(mulberry32(seed + (axis === 'X' ? 1000 : 0)));
      const implied: number[] = []; const resid: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 40; i++) {
        const P = dists[i % dists.length];              // discrete, alternating magnitudes
        const achievedMag = P * (S / sApp) + c + g(0, SIGMA_A);
        implied.push(sApp * (achievedMag / P)); resid.push({ x: P, y: achievedMag - P });
      }
      const fit = fitSlopeIntercept(resid);
      medEsts.push(median(implied)); slopeEsts.push(sApp * (1 + fit.slope));
    }
    console.log(`  ${axis} P̄=${Pbar}  c=${String(c).padStart(3)}px  median ${fmt(medEsts)}  |  slope ${fmt(slopeEsts)}`);
  }
}
console.log('  ⇒ two distinct distances still identify the slope; median bias ≈ c/P̄ (worse on X, smaller P̄).');
