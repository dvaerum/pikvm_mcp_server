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
  success: boolean;          // screenChanged was true
  finalResidual: number | null;  // residual from finalMoveResult; null when cursor not verified
  withinIcon: boolean;       // residual ≤ 25 — false when cursor unverified
  cursorVerified: boolean;   // Phase 99 fix: distinguish unverified-cursor from far-residual
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

  // Phase 99: distinguish "cursor not verified" (finalDetectedPosition is
  // null because motion-diff + template-match both failed) from "cursor
  // verified but landed far from target". Earlier bench versions used
  // `(cursor?.x ?? 0) - TARGET.x` which produced a misleading residual of
  // sqrt(929^2 + 99^2) ≈ 934 px on the (929, 99) target whenever the
  // cursor was unverified — that residual was an artifact of the (0,0)
  // fallback, NOT a real cursor landing position.
  const cursor = r.finalMoveResult.finalDetectedPosition;
  const cursorVerified = cursor !== null;
  const residual = cursorVerified
    ? Math.sqrt((cursor!.x - TARGET.x) ** 2 + (cursor!.y - TARGET.y) ** 2)
    : null;
  return {
    attempts: r.attempts,
    success: r.success,
    finalResidual: residual,
    withinIcon: residual !== null && residual <= 25,
    cursorVerified,
  };
}

async function bench(label: string, useMicro: boolean) {
  console.error(`\n=== ${label} (${TRIALS} trials with maxRetries=2) ===`);
  const trials: Trial[] = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const t = await runTrial(useMicro);
      trials.push(t);
      const residStr = t.finalResidual !== null
        ? `${t.finalResidual.toFixed(1)}px`
        : 'UNVERIFIED';
      console.error(`  trial ${i+1}: success=${t.success} attempts=${t.attempts} residual=${residStr} withinIcon=${t.withinIcon}`);
    } catch (e) {
      console.error(`  trial ${i+1}: ERROR ${(e as Error).message}`);
    }
  }
  const successCount = trials.filter(t => t.success).length;
  const withinIconCount = trials.filter(t => t.withinIcon).length;
  const verifiedCount = trials.filter(t => t.cursorVerified).length;
  const verifiedResiduals = trials
    .filter(t => t.cursorVerified && t.finalResidual !== null)
    .map(t => t.finalResidual!);
  const medianVerifiedResidual = verifiedResiduals.length > 0
    ? [...verifiedResiduals].sort((a, b) => a - b)[Math.floor(verifiedResiduals.length / 2)]
    : null;
  console.error(`  --- ${label}: screenChanged ${successCount}/${trials.length}, withinIcon ${withinIconCount}/${trials.length}, cursorVerified ${verifiedCount}/${trials.length}, medianResidual(verified)=${medianVerifiedResidual?.toFixed(1) ?? 'N/A'}px`);
  return { label, trials, successCount, withinIconCount };
}

const baseline = await bench('BASELINE', false);
const micro    = await bench('PHASE 65', true);
console.error(`\n=== END-TO-END SUMMARY ===`);
console.error(`baseline: screenChanged ${baseline.successCount}/${TRIALS}, withinIcon ${baseline.withinIconCount}/${TRIALS}`);
console.error(`phase 65: screenChanged ${micro.successCount}/${TRIALS}, withinIcon ${micro.withinIconCount}/${TRIALS}`);

console.error('\n=== END-TO-END SUMMARY ===');
console.error(`baseline: screenChanged ${baseline.successCount}/${TRIALS}, withinIcon ${baseline.withinIconCount}/${TRIALS}`);
console.error(`phase 65: screenChanged ${micro.successCount}/${TRIALS}, withinIcon ${micro.withinIconCount}/${TRIALS}`);
