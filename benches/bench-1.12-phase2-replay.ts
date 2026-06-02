/**
 * 1.12 Phase 2 — open-loop planner replay test.
 *
 * Critical pass gate: feed a set of target displacements into the
 * planner with v2-wider as the forward model and check that the
 * planner converges within 10 px of target on every case. If the
 * planner can't even predict its own plan's outcome, the live Phase 3
 * run won't work.
 *
 * Targets are sampled to span the chunked-burst regime move-to uses
 * (100-800 px per axis, 4 cardinal × 4 diagonal directions). No iPad
 * needed; everything runs against the trained model + the planner.
 *
 * Usage: npx tsx benches/bench-1.12-phase2-replay.ts
 *
 * Pass: median residual < 10 px AND p95 residual < 20 px.
 */

import { planOpenLoopEmits } from '../src/pikvm/open-loop-planner.js';
import {
  predictDisplacement,
  resolveDefaultModelPath,
  HORIZON_MS,
} from '../src/pikvm/pointer-accel.js';

// Match the production constants in src/pikvm/move-to.ts.
const CHUNK_MAG = 20;
const CHUNK_PACE_MS = 30;
const TOL_PX = 5;
const MAX_EMITS = 50;

// Approximation of the iPad's cached bounds used by
// learnedBallisticsPxPerMickey. 820×1180 logical → 1280×1864 HDMI at
// the bench-time scale (~1.56 each axis). Matches the 1.9 trajectory
// manifest.
const HDMI_PER_LOGICAL_SCALE = { x: 1.56, y: 1.58 };

interface TargetCase {
  label: string;
  dxPx: number;
  dyPx: number;
}

function buildTargetGrid(): TargetCase[] {
  const magnitudes = [100, 200, 400, 600, 800];
  const cases: TargetCase[] = [];
  for (const m of magnitudes) {
    // 4 cardinal
    cases.push({ label: `+x_${m}`, dxPx: m, dyPx: 0 });
    cases.push({ label: `-x_${m}`, dxPx: -m, dyPx: 0 });
    cases.push({ label: `+y_${m}`, dxPx: 0, dyPx: m });
    cases.push({ label: `-y_${m}`, dxPx: 0, dyPx: -m });
    // 4 diagonal at equal magnitude per axis
    cases.push({ label: `+x+y_${m}`, dxPx: m, dyPx: m });
    cases.push({ label: `+x-y_${m}`, dxPx: m, dyPx: -m });
    cases.push({ label: `-x+y_${m}`, dxPx: -m, dyPx: m });
    cases.push({ label: `-x-y_${m}`, dxPx: -m, dyPx: -m });
  }
  return cases;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function main() {
  const modelPath = resolveDefaultModelPath();
  console.error(`Phase 2 replay using model: ${modelPath}`);
  console.error(`Planner opts: chunkMag=${CHUNK_MAG} paceMs=${CHUNK_PACE_MS} tolPx=${TOL_PX} maxEmits=${MAX_EMITS}`);
  console.error(`HDMI-per-logical scale: x=${HDMI_PER_LOGICAL_SCALE.x} y=${HDMI_PER_LOGICAL_SCALE.y}`);

  const cases = buildTargetGrid();
  console.error(`\nReplay ${cases.length} target cases:\n`);

  console.error('label                 emits  hitMax  predFail  resid_x  resid_y  resid_eucl');
  console.error('-'.repeat(85));

  const residualsEuclid: number[] = [];
  const residualsX: number[] = [];
  const residualsY: number[] = [];
  let hitMaxCount = 0;
  let predictorFailCount = 0;

  for (const tc of cases) {
    const result = await planOpenLoopEmits(
      { dxPx: tc.dxPx, dyPx: tc.dyPx },
      {
        chunkMag: CHUNK_MAG,
        chunkPaceMs: CHUNK_PACE_MS,
        horizonMs: HORIZON_MS,
        tolPx: TOL_PX,
        maxEmits: MAX_EMITS,
        predict: predictDisplacement,
        hdmiPerLogicalScale: HDMI_PER_LOGICAL_SCALE,
      },
    );
    if (result.predictorFailed) predictorFailCount++;
    if (result.hitMaxEmits) hitMaxCount++;
    const absX = Math.abs(result.residualPx.x);
    const absY = Math.abs(result.residualPx.y);
    const eucl = Math.hypot(result.residualPx.x, result.residualPx.y);
    residualsX.push(absX);
    residualsY.push(absY);
    residualsEuclid.push(eucl);

    console.error(
      `${tc.label.padEnd(20)}  ${String(result.emits.length).padStart(5)}  ` +
      `${result.hitMaxEmits ? '   Y  ' : '   .  '}  ` +
      `${result.predictorFailed ? '    Y   ' : '    .   '}  ` +
      `${absX.toFixed(1).padStart(7)}  ` +
      `${absY.toFixed(1).padStart(7)}  ` +
      `${eucl.toFixed(1).padStart(10)}`,
    );
  }

  console.error('\n=== SUMMARY ===');
  console.error(`cases:               ${cases.length}`);
  console.error(`predictor failures:  ${predictorFailCount}`);
  console.error(`hit maxEmits:        ${hitMaxCount}`);
  console.error(`median |resid_x|:    ${median(residualsX).toFixed(2)} px`);
  console.error(`median |resid_y|:    ${median(residualsY).toFixed(2)} px`);
  console.error(`median euclid:       ${median(residualsEuclid).toFixed(2)} px`);
  console.error(`p95 euclid:          ${quantile(residualsEuclid, 0.95).toFixed(2)} px`);
  console.error(`max euclid:          ${Math.max(...residualsEuclid).toFixed(2)} px`);

  // Pass criteria.
  const medianEuclid = median(residualsEuclid);
  const p95Euclid = quantile(residualsEuclid, 0.95);
  const pass = medianEuclid < 10 && p95Euclid < 20 && predictorFailCount === 0;
  console.error(`\nPass criterion: median<10 px AND p95<20 px AND no predictor failures.`);
  console.error(`Result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`FATAL: ${e}`);
  process.exit(2);
});
