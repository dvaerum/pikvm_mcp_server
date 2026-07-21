/**
 * Ground-truth retry-loop bench (5.1). Simulates clickAtWithRetry's per-attempt
 * strategy choice against iPadCollector getCursor() ground truth, so per-attempt
 * cursor drift is measured against TRUTH, not the (lying) screenshot detector.
 *
 *   --arm control   every attempt uses strategy='detect-then-move'
 *   --arm fix-on     attempt 1 = detect-then-move; on attempt N>1, if the
 *                    previous attempt landed within AT_TARGET_THRESHOLD_PX of
 *                    target (per getCursor), reuse it via strategy='assume-at';
 *                    else fall back to detect-then-move.
 *
 * Usage:
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-5.1-groundtruth-retry-loop.ts --arm control --trials 8
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-5.1-groundtruth-retry-loop.ts --arm fix-on  --trials 8
 * Output: data/bench-5.1-gt/${arm}.jsonl  (one row per attempt)
 *
 * Built on the shared benches/lib/groundtruth harness.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import {
  connectIpadSession, setupGreyScene, standardTargets, slamToCorner, measureResidual, sleep,
} from './lib/groundtruth.js';

const ARM = (() => {
  const i = process.argv.indexOf('--arm');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--arm <control|fix-on> required');
  const v = process.argv[i + 1];
  if (v !== 'control' && v !== 'fix-on') throw new Error(`unknown arm "${v}"`);
  return v;
})();
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 8);
const MAX_ATTEMPTS = 4;
const AT_TARGET_THRESHOLD_PX = 35; // matches production maxResidualPx

async function main() {
  console.error(`[5.1-gt] arm=${ARM}, trials=${TRIALS}, max_attempts=${MAX_ATTEMPTS}`);
  const sess = await connectIpadSession();
  console.error(`[5.1-gt] connected: logicalW=${sess.hello!.logicalW} logicalH=${sess.hello!.logicalH}`);

  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client);
  console.error(`[5.1-gt] tight region: ${JSON.stringify(geom.tight)}`);

  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const targets = standardTargets(geom.tight);

  const outDir = './data/bench-5.1-gt';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ARM}.jsonl`);
  await fs.writeFile(outPath, '');

  console.error('');
  console.error(`target          trial  attempt  strategy           resid_hdmi`);
  console.error('-'.repeat(80));

  for (const target of targets) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      await slamToCorner(client);

      let prevIpadHdmi: { x: number; y: number } | null = null;
      let prevResidualHdmi: number | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const useAssumeAt = ARM === 'fix-on'
          && attempt > 1
          && prevResidualHdmi !== null
          && prevResidualHdmi <= AT_TARGET_THRESHOLD_PX
          && prevIpadHdmi !== null;

        const moveOpts = useAssumeAt
          ? { profile: profile ?? undefined, strategy: 'assume-at' as const, assumeCursorAt: prevIpadHdmi!, correct: true, forbidSlamFallback: true }
          : { profile: profile ?? undefined, strategy: 'detect-then-move' as const, correct: true, forbidSlamFallback: true };

        try {
          await moveToPixel(client, target, moveOpts);
        } catch (e) {
          await fs.appendFile(outPath, JSON.stringify({ target: target.name, trial, attempt, strategy: moveOpts.strategy, error: (e as Error).message }) + '\n');
          console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(attempt).padStart(7)}  ${moveOpts.strategy.padEnd(17)}  ERROR: ${(e as Error).message.slice(0, 30)}`);
          continue;
        }

        await sleep(350);
        const r = await measureResidual(sess, geom, target);
        if (!r) {
          console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(attempt).padStart(7)}  ${moveOpts.strategy.padEnd(17)}  getCursor failed; aborting trial`);
          break;
        }

        await fs.appendFile(outPath, JSON.stringify({
          target: target.name, target_x: target.x, target_y: target.y,
          trial, attempt, strategy: moveOpts.strategy,
          cursorLogical: r.cursorLogical,
          ipadHdmi: { x: Math.round(r.ipadHdmi.x), y: Math.round(r.ipadHdmi.y) },
          residualHdmi: r.residualHdmi,
        }) + '\n');
        console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(attempt).padStart(7)}  ${moveOpts.strategy.padEnd(17)}  ${r.residualHdmi.toFixed(1).padStart(7)} px`);

        prevIpadHdmi = r.ipadHdmi;
        prevResidualHdmi = r.residualHdmi;
      }
    }
  }

  console.error('');
  console.error(`Output: ${outPath}`);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
