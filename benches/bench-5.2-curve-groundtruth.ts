/**
 * Curve-one-shot ground-truth bench — the regression net for the iPad's
 * PRODUCTION default mover (strategy='curve-one-shot'), which no other bench
 * exercises.
 *
 * Per trial: slam to a corner, moveToPixel(curve-one-shot) to a target, read the
 * REAL cursor from iPadCollector getCursor(), record HDMI-px residual. Built on
 * the shared benches/lib/groundtruth harness.
 *
 * Usage:
 *   PIKVM_PROXY=http://127.0.0.1:8888 npx tsx benches/bench-5.2-curve-groundtruth.ts --trials 20
 * Output: data/bench-5.2-curve-gt/curve.jsonl  (one row per trial)
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

const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 20);

async function main() {
  console.error(`[5.2-curve] trials=${TRIALS}/target`);
  const sess = await connectIpadSession();
  console.error(`[5.2-curve] connected: logicalW=${sess.hello!.logicalW} logicalH=${sess.hello!.logicalH}`);

  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client);
  console.error(`[5.2-curve] tight region: ${JSON.stringify(geom.tight)}`);

  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const targets = standardTargets(geom.tight);

  const outDir = './data/bench-5.2-curve-gt';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'curve.jsonl');
  await fs.writeFile(outPath, '');

  console.error('');
  console.error(`target          trial   resid_hdmi`);
  console.error('-'.repeat(48));

  for (const target of targets) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      await slamToCorner(client);
      try {
        await moveToPixel(client, target, {
          profile: profile ?? undefined,
          strategy: 'curve-one-shot',
          forbidSlamFallback: true,
        });
      } catch (e) {
        await fs.appendFile(outPath, JSON.stringify({ target: target.name, trial, error: (e as Error).message }) + '\n');
        console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}   ERROR: ${(e as Error).message.slice(0, 30)}`);
        continue;
      }
      await sleep(350);
      const r = await measureResidual(sess, geom, target);
      if (!r) {
        console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}   getCursor failed; skipping`);
        continue;
      }
      await fs.appendFile(outPath, JSON.stringify({
        target: target.name, target_x: target.x, target_y: target.y, trial, ...r,
      }) + '\n');
      console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}   ${r.residualHdmi.toFixed(1).padStart(7)} px`);
    }
  }

  console.error(`\nOutput: ${outPath}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
