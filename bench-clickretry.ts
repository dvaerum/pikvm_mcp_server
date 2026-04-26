/**
 * Phase 65v: bench end-to-end clickAtWithRetry success rate. Measures
 * what the USER actually experiences: with maxRetries=2 (default), how
 * often does click_at get the cursor within 25 px of target?
 *
 * 5 trials each, baseline vs Phase 65 micro config.
 */

import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');

const TARGET = { x: 929, y: 99 };
const TRIALS = 10;

interface Trial {
  attempts: number;
  success: boolean;       // screenChanged was true
  finalResidual: number;  // residual from finalMoveResult
  withinIcon: boolean;    // residual ≤ 25
}

async function runTrial(useMicro: boolean): Promise<Trial> {
  // Wake cursor first
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
  const r = await clickAtWithRetry(client, TARGET, {
    maxRetries: 2,
    moveToOptions: {
      profile,
      forbidSlamFallback: true,
      ...microOpts,
    },
  });

  const cursor = r.finalMoveResult.finalDetectedPosition;
  const dx = (cursor?.x ?? 0) - TARGET.x;
  const dy = (cursor?.y ?? 0) - TARGET.y;
  const residual = Math.sqrt(dx * dx + dy * dy);
  return {
    attempts: r.attempts,
    success: r.success,
    finalResidual: residual,
    withinIcon: residual <= 25,
  };
}

async function bench(label: string, useMicro: boolean) {
  console.error(`\n=== ${label} (${TRIALS} trials with maxRetries=2) ===`);
  const trials: Trial[] = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const t = await runTrial(useMicro);
      trials.push(t);
      console.error(`  trial ${i+1}: success=${t.success} attempts=${t.attempts} residual=${t.finalResidual.toFixed(1)}px withinIcon=${t.withinIcon}`);
    } catch (e) {
      console.error(`  trial ${i+1}: ERROR ${(e as Error).message}`);
    }
  }
  const successCount = trials.filter(t => t.success).length;
  const withinIconCount = trials.filter(t => t.withinIcon).length;
  console.error(`  --- ${label}: screenChanged ${successCount}/${trials.length}, withinIcon ${withinIconCount}/${trials.length}`);
  return { label, trials, successCount, withinIconCount };
}

const baseline = await bench('BASELINE', false);
const micro    = await bench('PHASE 65', true);

console.error('\n=== END-TO-END SUMMARY ===');
console.error(`baseline: screenChanged ${baseline.successCount}/${TRIALS}, withinIcon ${baseline.withinIconCount}/${TRIALS}`);
console.error(`phase 65: screenChanged ${micro.successCount}/${TRIALS}, withinIcon ${micro.withinIconCount}/${TRIALS}`);
