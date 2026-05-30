/**
 * Phase 211 — measure residual pattern across 10 trials.
 *
 * Hypothesis: cursor overshoot may be SYSTEMATIC (always biased
 * in one direction). If so, the algorithm could compensate by
 * aiming at target - bias_vector.
 *
 * Runs 10 click attempts at Settings target, logs:
 *   - Per-trial residual_x, residual_y
 *   - Mean and stdev to determine if bias is real
 */

import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const TARGET = { x: 905, y: 800 };
const TRIALS = 10;

console.error(`=== Phase 211: residual pattern, target=(${TARGET.x},${TARGET.y}), n=${TRIALS} ===\n`);

interface Trial {
  trial: number;
  cursor: { x: number; y: number } | null;
  residual: number | null;
  dx: number | null;  // detected - target
  dy: number | null;
}
const trials: Trial[] = [];

for (let i = 1; i <= TRIALS; i++) {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));

  const r = await moveToPixel(client, TARGET, {
    profile: profile ?? undefined,
    forbidSlamFallback: true,
    strategy: 'detect-then-move',
  });
  const cursor = r.finalDetectedPosition;
  const dx = cursor ? cursor.x - TARGET.x : null;
  const dy = cursor ? cursor.y - TARGET.y : null;
  const residual = cursor ? Math.hypot(dx!, dy!) : null;

  trials.push({ trial: i, cursor, residual, dx, dy });
  console.error(
    `t${i}: ` +
    (cursor ? `cursor=(${cursor.x},${cursor.y}) dx=${dx} dy=${dy} residual=${residual!.toFixed(1)}` : 'cursor=null'),
  );
}

// Aggregate
const valid = trials.filter(t => t.cursor !== null);
const dxs = valid.map(t => t.dx!);
const dys = valid.map(t => t.dy!);
const residuals = valid.map(t => t.residual!);
const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
const stdev = (arr: number[]) => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
};

console.error('\n=== AGGREGATE ===');
console.error(`Valid trials: ${valid.length}/${TRIALS}`);
if (valid.length > 0) {
  console.error(`dx (detected.x - target.x):  mean=${mean(dxs).toFixed(1)}  stdev=${stdev(dxs).toFixed(1)}  min=${Math.min(...dxs)}  max=${Math.max(...dxs)}`);
  console.error(`dy (detected.y - target.y):  mean=${mean(dys).toFixed(1)}  stdev=${stdev(dys).toFixed(1)}  min=${Math.min(...dys)}  max=${Math.max(...dys)}`);
  console.error(`residual:                     mean=${mean(residuals).toFixed(1)}  stdev=${stdev(residuals).toFixed(1)}  min=${Math.min(...residuals).toFixed(1)}  max=${Math.max(...residuals).toFixed(1)}`);

  const meanDx = mean(dxs);
  const meanDy = mean(dys);
  const meanBias = Math.hypot(meanDx, meanDy);
  console.error(`\nMean bias vector: (${meanDx.toFixed(1)}, ${meanDy.toFixed(1)}) → magnitude ${meanBias.toFixed(1)} px`);
  if (meanBias > 30) {
    console.error(`SYSTEMATIC BIAS — could pre-compensate by aiming at (${(TARGET.x - meanDx).toFixed(0)}, ${(TARGET.y - meanDy).toFixed(0)}) instead of target`);
  } else {
    console.error('No strong systematic bias — error is mostly variance');
  }
}

await fs.writeFile('/tmp/residual-pattern.json', JSON.stringify(trials, null, 2));
console.error('\nFull trial data at /tmp/residual-pattern.json');
process.exit(0);
