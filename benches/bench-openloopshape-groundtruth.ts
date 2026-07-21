/**
 * openLoopShape ground-truth validation — closes the long-deferred live-verify TODO.
 *
 * openLoopShape (tryOpenLoopShapeDetect) is a DEEP fallback inside moveToPixel that
 * fires only when motion-diff AND template-match both fail, so it could never be
 * exercised on demand — it was OFFLINE-verified only. Now that it's a standalone
 * exported function, this bench calls it DIRECTLY on a real frame (with its real
 * wiggle-verify emits) and checks it locates the REAL cursor per iPadCollector
 * getCursor. That IS the ground-truth A/B the old TODO asked for.
 *
 * Per trial: land the cursor near a target so there's a real cursor on-screen, read
 * getCursor ground truth, capture+decode a frame, call tryOpenLoopShapeDetect with an
 * APPROXIMATE hint (the target — off by the mover's residual, as in production), then
 * compare the detected position to ground truth. HIT = detector within HIT_PX of the
 * real cursor.
 *
 * Usage:
 *   PIKVM_PROXY=http://127.0.0.1:8888 npx tsx benches/bench-openloopshape-groundtruth.ts --trials 10
 * Output: data/bench-openloopshape-gt/results.jsonl
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel, tryOpenLoopShapeDetect } from '../src/pikvm/move-to.js';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import {
  connectIpadSession, setupGreyScene, standardTargets, slamToCorner, readCursorHdmi, sleep,
} from './lib/groundtruth.js';

const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 10);
const HIT_PX = 35;

async function main() {
  console.error(`[ols-gt] trials=${TRIALS}/target — live-verify of the openLoopShape path`);
  const sess = await connectIpadSession();
  const client = new PiKVMClient(loadConfig().pikvm);
  const geom = await setupGreyScene(sess, client);
  console.error(`[ols-gt] tight region: ${JSON.stringify(geom.tight)}`);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const targets = standardTargets(geom.tight);

  const outDir = './data/bench-openloopshape-gt';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'results.jsonl');
  await fs.writeFile(outPath, '');

  console.error('');
  console.error('target        trial  det  det_resid  cls');
  console.error('-'.repeat(52));
  const results: Record<string, { hit: number; off: number; nul: number; n: number }> = {};
  for (const t of targets) results[t.name] = { hit: 0, off: 0, nul: 0, n: 0 };

  for (const target of targets) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      await slamToCorner(client);
      // Land the cursor near target so there's a real cursor on-screen to detect.
      try {
        await moveToPixel(client, target, {
          profile: profile ?? undefined, strategy: 'curve-one-shot', forbidSlamFallback: true,
        });
      } catch (e) {
        console.error(`  ${target.name} t${trial}: move threw ${(e as Error).message}`); continue;
      }
      await sleep(300);

      const gt = await readCursorHdmi(sess, geom);
      if (!gt) { console.error(`  ${target.name} t${trial}: getCursor failed`); continue; }

      // Capture + decode a real frame (keep the cursor alive first).
      const raw = await client.screenshotKeepingCursorAlive();
      const shot = await decodeScreenshot(raw.buffer);

      // Call the openLoopShape detector DIRECTLY with an approximate hint (the target).
      // ratios only feed wiggleVerifyCandidate's (unused) expectedAfter; 1.0 is fine.
      const det = await tryOpenLoopShapeDetect(client, 1.0, 1.0, shot, target);

      const r = results[target.name]; r.n++;
      let cls: 'hit' | 'miss_offtarget' | 'miss_null'; let detResid = NaN;
      if (!det) { cls = 'miss_null'; r.nul++; }
      else {
        detResid = Math.hypot(det.pos.x - gt.ipadHdmi.x, det.pos.y - gt.ipadHdmi.y);
        if (detResid <= HIT_PX) { cls = 'hit'; r.hit++; } else { cls = 'miss_offtarget'; r.off++; }
      }
      await fs.appendFile(outPath, JSON.stringify({
        target: target.name, trial,
        gtHdmi: { x: Math.round(gt.ipadHdmi.x), y: Math.round(gt.ipadHdmi.y) },
        det: det ? { x: Math.round(det.pos.x), y: Math.round(det.pos.y), score: det.score, prox: Math.round(det.prox) } : null,
        detResidual: Number.isFinite(detResid) ? Number(detResid.toFixed(1)) : null,
        cls,
      }) + '\n');
      console.error(
        `${target.name.padEnd(12)} ${String(trial).padStart(5)}  ${det ? ' Y ' : ' . '}  ` +
        `${Number.isFinite(detResid) ? detResid.toFixed(1).padStart(8) : '    null'}  ${cls}`,
      );
    }
  }

  console.error('');
  console.error('===== SUMMARY — openLoopShape locates the REAL cursor =====');
  let H = 0, N = 0;
  for (const t of targets) {
    const r = results[t.name]; H += r.hit; N += r.n;
    console.error(`${t.name.padEnd(12)} hit ${r.hit}/${r.n}  offtarget ${r.off}  null ${r.nul}`);
  }
  console.error(`TOTAL locate-rate: ${H}/${N} = ${N ? Math.round(H / N * 100) : 0}%`);
  console.error(`\nOutput: ${outPath}`);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
