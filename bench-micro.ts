/**
 * Phase 65 verification — bench N trials of moveToPixel with the
 * Phase 65 micro-step config and N trials WITHOUT it. Compare
 * residual distributions to see if the improvement is real.
 *
 * Each trial:
 *   1. Wake the cursor with a tiny nudge (slamming to corner pushes
 *      cursor to letterbox where it is invisible)
 *   2. Run moveToPixel to TARGET with the test config
 *   3. Record final residual + whether motion-diff blind passes happened
 *
 * No clicks (avoids screen state diverging between trials).
 *
 * Phase 101 made target + trial count overridable via CLI args
 * (mirrors bench-clickretry's Phase 100):
 *   npx tsx bench-micro.ts                  # defaults
 *   npx tsx bench-micro.ts 1060 700         # custom target
 *   npx tsx bench-micro.ts 1060 700 10      # 10 trials
 */

import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile, slamToCorner } from './src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');

// Phase 101: parameterise via CLI args.
const argv = process.argv.slice(2);
const TARGET = {
  x: argv[0] !== undefined ? Number(argv[0]) : 929,
  y: argv[1] !== undefined ? Number(argv[1]) : 99,
};
const TRIALS = argv[2] !== undefined ? Number(argv[2]) : 5;
if (
  !Number.isFinite(TARGET.x) || !Number.isFinite(TARGET.y) ||
  !Number.isInteger(TRIALS) || TRIALS < 1
) {
  console.error(`usage: npx tsx bench-micro.ts [x] [y] [trials]`);
  console.error(`  x, y     target HDMI pixel (default 929, 99)`);
  console.error(`  trials   trials per mode (default 5, must be ≥ 1)`);
  process.exit(2);
}
console.error(`Bench target: (${TARGET.x}, ${TARGET.y}), trials per mode: ${TRIALS}`);

interface TrialResult {
  residual: number | null;  // null when cursor not verified (Phase 101 fix)
  passes: number;
  cursorAt: { x: number; y: number } | null;
  blindPasses: number;
  message: string;
}

async function runTrial(useMicro: boolean): Promise<TrialResult> {
  // Wake the cursor with a tiny nudge so detect-then-move's probe can
  // find it. (Slamming to corner pushes cursor to letterbox where it
  // is invisible — bench-broken.)
  await client.mouseMoveRelative(40, 0);
  await new Promise(r => setTimeout(r, 250));
  await client.mouseMoveRelative(-40, 0);
  await new Promise(r => setTimeout(r, 250));

  const microOpts = useMicro ? {
    linearTriggerResidualPx: 200,
    linearChunkMagnitude: 20,
    linearChunkPaceMs: 80,
    linearCorrectionCap: 40,
    linearMaxPasses: 12,
    maxCorrectionPasses: 12,
    linearResidualPx: 25,
    iconToleranceResidualPx: 25,
    disableLinearBailout: true,
  } : {};

  const r = await moveToPixel(client, TARGET, {
    profile,
    forbidSlamFallback: true,
    ...microOpts,
  });

  // Phase 101: distinguish "cursor not verified" from "verified but far".
  // The previous `?? { x: 0, y: 0 }` fallback computed a misleading
  // residual of sqrt(929² + 99²) ≈ 934 px against the (929, 99) target
  // for any unverified attempt — same bug Phase 99 fixed in
  // bench-clickretry.ts.
  const cursor = r.finalDetectedPosition;
  const residual = cursor !== null
    ? Math.sqrt((cursor.x - TARGET.x) ** 2 + (cursor.y - TARGET.y) ** 2)
    : null;
  const blindPasses = r.corrections.filter(c => c.mode === 'predicted').length;
  return {
    residual,
    passes: r.corrections.length,
    cursorAt: cursor,
    blindPasses,
    message: r.message,
  };
}

async function bench(label: string, useMicro: boolean) {
  console.error(`\n=== ${label} (${TRIALS} trials, useMicro=${useMicro}) ===`);
  const results: TrialResult[] = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const r = await runTrial(useMicro);
      results.push(r);
      const residStr = r.residual !== null ? `${r.residual.toFixed(1)}px` : 'UNVERIFIED';
      const cursorStr = r.cursorAt !== null ? `(${r.cursorAt.x},${r.cursorAt.y})` : 'null';
      console.error(`  trial ${i+1}: residual=${residStr} passes=${r.passes} blind=${r.blindPasses} cursor=${cursorStr}`);
    } catch (e) {
      console.error(`  trial ${i+1}: ERROR ${(e as Error).message}`);
    }
  }
  // Phase 101: stats computed only over verified trials. Unverified
  // attempts are reported as a separate count; treating them as residual=∞
  // would skew the distribution and hide the real precision signal.
  const verifiedResiduals = results
    .filter(r => r.residual !== null)
    .map(r => r.residual as number)
    .sort((a, b) => a - b);
  const median = verifiedResiduals[Math.floor(verifiedResiduals.length / 2)];
  const p95 = verifiedResiduals[Math.floor(verifiedResiduals.length * 0.95)];
  const succAt25 = verifiedResiduals.filter(r => r <= 25).length;
  const succAt50 = verifiedResiduals.filter(r => r <= 50).length;
  const verifiedCount = verifiedResiduals.length;
  console.error(`  --- ${label} stats (over ${verifiedCount} verified trials): median=${median?.toFixed(1) ?? 'N/A'}px p95=${p95?.toFixed(1) ?? 'N/A'}px ≤25:${succAt25}/${verifiedCount} ≤50:${succAt50}/${verifiedCount}; unverified ${TRIALS - verifiedCount}/${TRIALS}`);
  return { label, results, median, p95, succAt25, succAt50, verifiedCount };
}

const baseline = await bench('BASELINE (default)', false);
const micro    = await bench('PHASE 65 (micro)',  true);

console.error('\n=== SUMMARY (verified trials only; unverified excluded from stats) ===');
console.error(`baseline: median=${baseline.median?.toFixed(1) ?? 'N/A'}px p95=${baseline.p95?.toFixed(1) ?? 'N/A'}px ≤25:${baseline.succAt25}/${baseline.verifiedCount} (${TRIALS - baseline.verifiedCount} unverified)`);
console.error(`phase 65: median=${micro.median?.toFixed(1) ?? 'N/A'}px p95=${micro.p95?.toFixed(1) ?? 'N/A'}px ≤25:${micro.succAt25}/${micro.verifiedCount} (${TRIALS - micro.verifiedCount} unverified)`);
