/**
 * Ground-truth click-flow A/B bench.
 *
 * The production click bench (bench-click-production.ts) measures
 * HIT/SKIP/MISS/NOLAUNCH against the real iPad home screen, but all of
 * its residuals come from the screenshot detector — which 1.13b proved
 * lies on cursor-on-icon frames. Six fires were spent on the 1.11
 * "+55pp pointer-accel lift" before 1.13c + 1.14 walked it back.
 *
 * This bench substitutes the screenshot detector's residual + the
 * verifyClickByDiff HIT criterion with iPadCollector ground truth:
 *
 *   1. Take a real PiKVM screenshot of iPad home page 1
 *   2. Crop to the detected iPad region
 *   3. Send the cropped image to iPadCollector as an `image` scene —
 *      now the iPad displays the home-screen pixels under
 *      iPadCollector's view, and we get the same visual surface as
 *      production (the screenshot detector sees the same thing)
 *   4. Compute each production target's position in iPad LOGICAL coords
 *   5. For each (target × trial × arm): call clickAtWithRetry,
 *      collect every `onTapEvent` that fires during retries
 *   6. HIT = at least one tap landed within `HIT_RADIUS_PX` of the
 *      target in iPad logical px
 *
 * What this measures that the production bench cannot:
 *   - Whether the tap actually landed near target, independent of the
 *     screenshot detector's residual report
 *   - Whether the 5.1 retry-instability fix actually reduces tap-drift
 *     across retries (collect ALL taps, examine each)
 *
 * Arms (use --arm to pick):
 *   - `constant`            PIKVM_USE_LEARNED_BALLISTICS=0
 *   - `v2-wider`            PIKVM_USE_LEARNED_BALLISTICS=1 + v2-wider.onnx
 *
 * Usage:
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-ground-truth-clickflow.ts --arm constant --trials 5
 *   PIKVM_USE_LEARNED_BALLISTICS=1 PIKVM_POINTER_ACCEL_MODEL=ml/pointer-accel-v2-wider.onnx npx tsx benches/bench-ground-truth-clickflow.ts --arm v2-wider --trials 5
 *
 * Output: data/bench-gt-clickflow/${arm}.jsonl  (one row per trial)
 */

import { promises as fs } from 'fs';
import sharp from 'sharp';
import type { TapEvent } from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor, defaultMaxResidualPxFor } from '../src/pikvm/click-verify.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { connectIpadSession, setupImageScene, sleep } from './lib/groundtruth.js';

const ARM = (() => {
  const i = process.argv.indexOf('--arm');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--arm <constant|v2-wider> required');
  return process.argv[i + 1];
})();
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 5);
const HIT_RADIUS_PX = 35;  // matches production maxResidualPx in HDMI-px space

const TARGETS_HDMI = [
  { name: 'Settings',  x: 1027, y: 837 },
  { name: 'Books',     x: 757,  y: 837 },
  { name: 'AppStore',  x: 1027, y: 702 },
  { name: 'Files',     x: 1162, y: 435 },
];

async function main() {
  console.error(`[gt-cf] arm=${ARM}, trials=${TRIALS}/target, ${TARGETS_HDMI.length} targets`);

  // Step 1: capture a fresh home-screen PiKVM screenshot WHILE the iPad is on
  // home (iPadCollector NOT yet foreground), then crop to the iPad region and
  // render it back as an image scene so the detectors see the production
  // home-screen surface. Tap events report logical coords inside the iPad
  // view, mapped to HDMI via the shared geometry.
  const client = new PiKVMClient(loadConfig().pikvm);
  await ipadGoHome(client);
  await sleep(1500);
  console.error('[gt-cf] capturing home-screen screenshot…');
  const homeShot = await client.screenshot();
  const region = await detectIpadRegion(homeShot.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN, y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN, h: region.h - 2 * NATIVE_MARGIN,
  };
  const croppedJpeg = await sharp(homeShot.buffer)
    .extract({ left: tight.x, top: tight.y, width: tight.w, height: tight.h })
    .jpeg({ quality: 80 })
    .toBuffer();
  const croppedB64 = croppedJpeg.toString('base64');
  console.error(`[gt-cf] cropped home screenshot (jpeg q=80): ${croppedJpeg.byteLength} bytes`);
  await fs.mkdir('data/bench-gt-clickflow', { recursive: true });
  await fs.writeFile(`data/bench-gt-clickflow/${ARM}-scene.jpg`, croppedJpeg);

  // Step 2: connect (relaunches iPadCollector) + render the cropped home as the
  // image scene. setupImageScene computes geometry + syncs clock + populates
  // the bounds cache moveToPixel reads.
  const sess = await connectIpadSession();
  console.error(`[gt-cf] connected: logicalW=${sess.hello!.logicalW} logicalH=${sess.hello!.logicalH}`);
  const geom = await setupImageScene(sess, client, croppedB64, region);
  console.error('[gt-cf] scene shown');
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);

  // Tap collection — set BEFORE each clickAtWithRetry call; cleared
  // after.
  let tapBuffer: TapEvent[] = [];
  sess.onTapEvent = (ev) => { tapBuffer.push(ev); };

  const outPath = `data/bench-gt-clickflow/${ARM}.jsonl`;
  await fs.writeFile(outPath, '');

  const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false);
  const MAX_RESIDUAL_PX = defaultMaxResidualPxFor(/*absolute=*/false);
  console.error(`[gt-cf] maxRetries=${MAX_RETRIES} maxResidualPx=${MAX_RESIDUAL_PX}`);
  console.error('');
  console.error('target      trial  taps  any_hit  min_dist  cls         attempts  per_tap');
  console.error('-'.repeat(110));

  const results: Record<string, { hit: number; miss_no_tap: number; miss_offtarget: number; skipped_no_click: number }> = {};
  for (const t of TARGETS_HDMI) results[t.name] = { hit: 0, miss_no_tap: 0, miss_offtarget: 0, skipped_no_click: 0 };

  for (const target of TARGETS_HDMI) {
    const targetLogical = geom.hdmiToIpad(target.x, target.y);
    for (let trial = 1; trial <= TRIALS; trial++) {
      // Slam cursor to upper-left as known starting position. Don't
      // call ipadGoHome — that would background iPadCollector.
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(200);
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(300);

      tapBuffer = [];
      let result;
      try {
        result = await clickAtWithRetry(client, { x: target.x, y: target.y }, {
          maxRetries: MAX_RETRIES,
          moveToOptions: {
            profile: profile ?? undefined,
            forbidSlamFallback: true,
            strategy: 'detect-then-move',
          },
          maxResidualPx: MAX_RESIDUAL_PX,
          requireVerifiedCursor: true,
          verifyOptions: {
            region: { x: target.x, y: target.y, halfWidth: 50, halfHeight: 50 },
            minChangedFraction: 0.05,
          },
        });
      } catch (e) {
        console.error(`  ${target.name} trial ${trial}: clickAtWithRetry threw: ${(e as Error).message}`);
        continue;
      }

      // Give the iPad app a moment to flush any in-flight tap events.
      await sleep(300);

      const taps = tapBuffer.slice();
      const tapDists = taps.map(tap => Math.hypot(tap.x - targetLogical.x, tap.y - targetLogical.y));
      const minDist = tapDists.length > 0 ? Math.min(...tapDists) : NaN;

      // Convert HIT_RADIUS from HDMI to logical (the iPad's coord system).
      const scaleHdmiPerLogicalAvg = (geom.scaleHdmiPerLogical.x + geom.scaleHdmiPerLogical.y) / 2;
      const hitRadiusLogical = HIT_RADIUS_PX / scaleHdmiPerLogicalAvg;
      const anyHit = tapDists.some(d => d <= hitRadiusLogical);

      let cls: 'hit' | 'miss_offtarget' | 'miss_no_tap' | 'skipped_no_click';
      if (taps.length === 0) {
        // No tap fired — every attempt either SKIPped (safety gate)
        // or threw. The retry loop never sent a real tap to iPadCollector.
        cls = 'skipped_no_click';
      } else if (anyHit) {
        cls = 'hit';
      } else {
        cls = 'miss_offtarget';
      }
      results[target.name][cls]++;

      const perTap = taps.map((t, i) => `(${t.x.toFixed(0)},${t.y.toFixed(0)})d=${tapDists[i].toFixed(0)}`).join(' ');
      console.error(
        `${target.name.padEnd(11)}  ${String(trial).padStart(5)}  ${String(taps.length).padStart(4)}  ${anyHit ? '   Y  ' : '   .  '}  ${Number.isFinite(minDist) ? minDist.toFixed(0).padStart(7) : '    NA'}  ${cls.padEnd(20).slice(0, 20)} ${String(result.attempts).padStart(8)}  ${perTap.slice(0, 60)}`,
      );

      await fs.appendFile(outPath, JSON.stringify({
        target: target.name, targetHdmi: target,
        targetLogical: { x: targetLogical.x, y: targetLogical.y },
        trial,
        clickAtWithRetrySuccess: result.success,
        attempts: result.attempts,
        attemptHistory: result.attemptHistory,
        taps: taps.map((t, i) => ({ x: t.x, y: t.y, t_ipad: t.t_ipad, distLogical: tapDists[i], distHdmiApprox: tapDists[i] * scaleHdmiPerLogicalAvg })),
        hitRadiusPx: HIT_RADIUS_PX,
        hitRadiusLogical,
        minDist,
        anyHit,
        cls,
      }) + '\n');
    }
  }

  console.error('');
  console.error('===================================== SUMMARY =====================================');
  console.error('target      hit  miss_offtarget  miss_no_tap  skipped_no_click');
  console.error('-'.repeat(70));
  for (const t of TARGETS_HDMI) {
    const r = results[t.name];
    console.error(`${t.name.padEnd(11)}  ${String(r.hit).padStart(3)}/${TRIALS}  ${String(r.miss_offtarget).padStart(14)}/${TRIALS}  ${String(r.miss_no_tap).padStart(11)}/${TRIALS}  ${String(r.skipped_no_click).padStart(15)}/${TRIALS}`);
  }
  const totalHit = TARGETS_HDMI.reduce((a, t) => a + results[t.name].hit, 0);
  const totalN = TARGETS_HDMI.length * TRIALS;
  console.error('-'.repeat(70));
  console.error(`TOTAL HIT: ${totalHit}/${totalN} = ${(totalHit / totalN * 100).toFixed(0)}%`);
  console.error('');
  console.error(`Output: ${outPath}`);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
