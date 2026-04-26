/**
 * Phase 65 verification — bench 10 trials of moveToPixel with the
 * Phase 65 micro-step config and 10 trials WITHOUT it. Compare
 * residual distributions to see if the improvement is real.
 *
 * Each trial:
 *   1. Slam to bottom-right corner (resets cursor to known state)
 *   2. Run moveToPixel to (929, 99) with the test config
 *   3. Record final residual + whether motion-diff blind passes happened
 *
 * No clicks (avoids screen state diverging between trials).
 */

import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile, slamToCorner } from './src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');

const TARGET = { x: 929, y: 99 };
const TRIALS = 5;

interface TrialResult {
  residual: number;
  passes: number;
  cursorAt: { x: number; y: number };
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

  const cursor = r.finalDetectedPosition ?? { x: 0, y: 0 };
  const dx = cursor.x - TARGET.x;
  const dy = cursor.y - TARGET.y;
  const residual = Math.sqrt(dx * dx + dy * dy);
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
      console.error(`  trial ${i+1}: residual=${r.residual.toFixed(1)}px passes=${r.passes} blind=${r.blindPasses} cursor=(${r.cursorAt.x},${r.cursorAt.y})`);
    } catch (e) {
      console.error(`  trial ${i+1}: ERROR ${(e as Error).message}`);
    }
  }
  const residuals = results.map(r => r.residual).sort((a, b) => a - b);
  const median = residuals[Math.floor(residuals.length / 2)];
  const p95 = residuals[Math.floor(residuals.length * 0.95)];
  const succAt25 = residuals.filter(r => r <= 25).length;
  const succAt50 = residuals.filter(r => r <= 50).length;
  console.error(`  --- ${label} stats: median=${median?.toFixed(1)}px p95=${p95?.toFixed(1)}px ≤25:${succAt25}/${TRIALS} ≤50:${succAt50}/${TRIALS}`);
  return { label, results, median, p95, succAt25, succAt50 };
}

const baseline = await bench('BASELINE (default)', false);
const micro    = await bench('PHASE 65 (micro)',  true);

console.error('\n=== SUMMARY ===');
console.error(`baseline: median=${baseline.median?.toFixed(1)}px p95=${baseline.p95?.toFixed(1)}px ≤25:${baseline.succAt25}/${TRIALS}`);
console.error(`phase 65: median=${micro.median?.toFixed(1)}px p95=${micro.p95?.toFixed(1)}px ≤25:${micro.succAt25}/${TRIALS}`);
