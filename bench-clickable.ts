/**
 * Bench against a CLICKABLE target (Settings icon at ~(1027, 833) on
 * the iPad home screen) to measure end-to-end success rate WITH
 * v0.5.102 (Phase 102-108 chain shipped). Compares maxRetries=0
 * (single-shot) vs maxRetries=2 (Phase 94 default).
 *
 * Each trial:
 * 1. Cmd+H to make sure we're on home screen
 * 2. clickAtWithRetry against the Settings icon
 * 3. Record success + residual
 * 4. Cmd+H to return home (whether we hit or not)
 *
 * Settings icon is ~70 px square — counts as "tiny target" in the
 * documented matrix (≤50 px column → ~88% with retries).
 */

import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry } from './src/pikvm/click-verify.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';
import { loadProfile } from './src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');

const TARGET = { x: 1027, y: 833 };
const TRIALS = 5;

interface Trial {
  attempt: number;
  attempts: number;
  success: boolean;
  residual: number | null;
  cursorVerified: boolean;
}

async function runTrial(maxRetries: number, useMicro = false): Promise<Trial> {
  // Return to home screen
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));

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

  const r = await clickAtWithRetry(client, TARGET, {
    maxRetries,
    moveToOptions: {
      strategy: 'detect-then-move',
      forbidSlamFallback: true,
      profile,
      ...microOpts,
    },
  });

  const cursor = r.finalMoveResult.finalDetectedPosition;
  const cursorVerified = cursor !== null;
  const residual = cursorVerified
    ? Math.sqrt((cursor!.x - TARGET.x) ** 2 + (cursor!.y - TARGET.y) ** 2)
    : null;

  return {
    attempt: 0,
    attempts: r.attempts,
    success: r.success,
    residual,
    cursorVerified,
  };
}

async function bench(label: string, maxRetries: number, useMicro = false) {
  console.error(`\n=== ${label} (maxRetries=${maxRetries}, micro=${useMicro}, ${TRIALS} trials, target=(${TARGET.x},${TARGET.y})) ===`);
  const trials: Trial[] = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const t = await runTrial(maxRetries, useMicro);
      t.attempt = i + 1;
      trials.push(t);
      const residStr = t.residual !== null ? `${t.residual.toFixed(1)}px` : 'UNVERIFIED';
      console.error(`  trial ${i+1}: success=${t.success} attempts=${t.attempts} residual=${residStr}`);
    } catch (e) {
      console.error(`  trial ${i+1}: ERROR ${(e as Error).message}`);
    }
  }
  const successCount = trials.filter(t => t.success).length;
  const verifiedCount = trials.filter(t => t.cursorVerified).length;
  const verifiedResiduals = trials
    .filter(t => t.cursorVerified && t.residual !== null)
    .map(t => t.residual as number)
    .sort((a, b) => a - b);
  const median = verifiedResiduals[Math.floor(verifiedResiduals.length / 2)];
  console.error(`  --- ${label}: opened-Settings ${successCount}/${trials.length}, cursorVerified ${verifiedCount}/${trials.length}, medianResidual=${median?.toFixed(1) ?? 'N/A'}px`);
  return { label, trials, successCount, verifiedCount };
}

const single = await bench('SINGLE-SHOT (maxRetries=0)', 0);
const retried = await bench('WITH RETRIES (maxRetries=2)', 2);
const micro = await bench('WITH RETRIES + PHASE 65 MICRO', 2, true);

console.error('\n=== END-TO-END SUMMARY (Settings-icon target, ~70 px) ===');
console.error(`single-shot:           opened ${single.successCount}/${TRIALS}, verified ${single.verifiedCount}/${TRIALS}`);
console.error(`with retries:          opened ${retried.successCount}/${TRIALS}, verified ${retried.verifiedCount}/${TRIALS}`);
console.error(`retries + micro:       opened ${micro.successCount}/${TRIALS}, verified ${micro.verifiedCount}/${TRIALS}`);

// Final return to home so we leave the iPad in a known state.
await ipadGoHome(client);
