/**
 * 1.13c — clean ground-truth A/B on pointer-accel.
 *
 * Bypasses the (lying) screenshot detector: iPadCollector streams the iPad's
 * OWN reported cursor position over WS = ground truth. Per trial: slam to a
 * known corner, read start (logical px), moveToPixel with the chosen
 * pointer-accel arm and the correction loop OFF (open-loop emit alone decides
 * where we land), read end, residual = |iPad_reported_end - target| in HDMI px.
 *
 * Arms:
 *   --arm constant     PIKVM_USE_LEARNED_BALLISTICS=0 (px/mickey = 1.0)
 *   --arm v1           PIKVM_USE_LEARNED_BALLISTICS=1 + v1.onnx
 *   --arm v2-wider     PIKVM_USE_LEARNED_BALLISTICS=1 + v2-wider.onnx
 *
 * Usage:
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-1.13c-groundtruth-pointer-accel.ts --arm constant
 *   PIKVM_USE_LEARNED_BALLISTICS=1 PIKVM_POINTER_ACCEL_MODEL=ml/pointer-accel-v2-wider.onnx npx tsx benches/bench-1.13c-groundtruth-pointer-accel.ts --arm v2-wider
 * Output: data/bench-1.13c/${arm}.jsonl  (one row per trial)
 *
 * Built on the shared benches/lib/groundtruth harness.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { getLastGoodBounds } from '../src/pikvm/orientation.js';
import { buildFeatures, predictDisplacement, pointerAccelModelExists } from '../src/pikvm/pointer-accel.js';
import {
  connectIpadSession, setupGreyScene, readCursorHdmi, sleep,
} from './lib/groundtruth.js';

const IPAD_LOGICAL_W = 820;
const IPAD_LOGICAL_H = 1180;
const SANE_MICKEYS_CAP = 2000;

/** Replicate move-to.ts:learnedBallisticsPxPerMickey for a pre-flight check.
 *  Returns the per-axis ratios moveToPixel will use, or null if it falls back
 *  to constant. Used to SKIP catastrophic-emit trials (v1 cold-start predicts
 *  ~0.025 px/mickey → 13k mickeys → floods + crashes the iPadCollector WS). */
async function previewLearnedRatio(
  dxPx: number, dyPx: number, chunkMag = 20,
): Promise<{ pxPerMickeyX: number; pxPerMickeyY: number } | null> {
  if (process.env.PIKVM_USE_LEARNED_BALLISTICS !== '1') return null;
  const bounds = getLastGoodBounds();
  if (!bounds) return null;
  if (!pointerAccelModelExists()) return null;
  const signX = dxPx >= 0 ? 1 : -1;
  const signY = dyPx >= 0 ? 1 : -1;
  const featX = buildFeatures([], { vxPxPerMs: 0, vyPxPerMs: 0 }, { dx: signX * chunkMag, dy: 0, t: 0 }, 0);
  const featY = buildFeatures([], { vxPxPerMs: 0, vyPxPerMs: 0 }, { dx: 0, dy: signY * chunkMag, t: 0 }, 0);
  const [predX, predY] = await Promise.all([predictDisplacement(featX), predictDisplacement(featY)]);
  if (!predX || !predY) return null;
  const scaleX = bounds.width / IPAD_LOGICAL_W;
  const scaleY = bounds.height / IPAD_LOGICAL_H;
  const screenshotDxAbs = Math.abs(predX.dx) * scaleX;
  const screenshotDyAbs = Math.abs(predY.dy) * scaleY;
  if (screenshotDxAbs <= 0 || screenshotDyAbs <= 0) return null;
  return { pxPerMickeyX: screenshotDxAbs / chunkMag, pxPerMickeyY: screenshotDyAbs / chunkMag };
}

const ARM = (() => {
  const i = process.argv.indexOf('--arm');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--arm <constant|v1|v2-wider> required');
  return process.argv[i + 1];
})();
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 10);

async function main() {
  console.error(`[gt-bench] arm=${ARM}, trials=${TRIALS}`);
  console.error(`[gt-bench] PIKVM_USE_LEARNED_BALLISTICS=${process.env.PIKVM_USE_LEARNED_BALLISTICS}`);
  console.error(`[gt-bench] PIKVM_POINTER_ACCEL_MODEL=${process.env.PIKVM_POINTER_ACCEL_MODEL || '(default)'}`);

  let sess = await connectIpadSession();
  console.error(`[gt-bench] connected: logicalW=${sess.hello!.logicalW} logicalH=${sess.hello!.logicalH}`);

  const client = new PiKVMClient(loadConfig().pikvm);
  // 0.95 grey (not the mover benches' 0.55) — the surface 1.13c has always used.
  // setupGreyScene also populates the iPad-bounds cache learnedBallisticsPxPerMickey
  // depends on; without it v1/v2/constant arms are indistinguishable.
  const geom = await setupGreyScene(sess, client, 0.95);
  console.error(`[gt-bench] iPad tight region: ${JSON.stringify(geom.tight)}`);

  const profile = await loadProfile('./data/ballistics.json').catch(() => null);

  // Deterministic interior grid + jitter so arms see the same targets.
  const rng = (() => { let s = 1337; return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x80000000; }; })();
  const targets: { x: number; y: number }[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const u = 0.2 + 0.6 * rng();
    const v = 0.2 + 0.6 * rng();
    targets.push({ x: Math.round(geom.tight.x + u * geom.tight.w), y: Math.round(geom.tight.y + v * geom.tight.h) });
  }

  const outDir = './data/bench-1.13c';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ARM}.jsonl`);
  await fs.writeFile(outPath, '');

  console.error('');
  console.error(`trial  target(hdmi)   iPad_end(logical)   residual_hdmi`);
  console.error('-'.repeat(70));

  const reconnect = async () => { sess = await connectIpadSession(); await sess.syncClock(5); };

  for (let trial = 1; trial <= TRIALS; trial++) {
    const target = targets[trial - 1];

    if (!sess.connected) await reconnect();

    // Slam to top-left corner (clamps at iPad edges).
    await client.mouseMoveRelative(-1000, -1000);
    await sleep(200);
    await client.mouseMoveRelative(-1000, -1000);
    await sleep(400);

    let start = await readCursorHdmi(sess, geom);
    if (!start) {
      console.error(`  trial ${trial}: getCursor failed at start; reconnecting`);
      await reconnect();
      start = await readCursorHdmi(sess, geom);
      if (!start) { console.error(`  trial ${trial}: still failing post-reconnect; skipping`); continue; }
    }
    const startHdmi = start.ipadHdmi;
    // Seed belief at the iPad-reported start so moveToPixel computes the right emit.
    client.belief?.reset({ x: startHdmi.x, y: startHdmi.y });

    // Pre-flight: skip catastrophic-emit trials (see previewLearnedRatio).
    const dxPx = target.x - startHdmi.x, dyPx = target.y - startHdmi.y;
    const ratio = await previewLearnedRatio(dxPx, dyPx);
    const plannedMickeysX = ratio ? Math.round(Math.abs(dxPx) / ratio.pxPerMickeyX) : Math.round(Math.abs(dxPx));
    const plannedMickeysY = ratio ? Math.round(Math.abs(dyPx) / ratio.pxPerMickeyY) : Math.round(Math.abs(dyPx));
    if (plannedMickeysX > SANE_MICKEYS_CAP || plannedMickeysY > SANE_MICKEYS_CAP) {
      const reason = `planned mickeys=(${plannedMickeysX},${plannedMickeysY}) > ${SANE_MICKEYS_CAP} (ratio=${ratio ? `(${ratio.pxPerMickeyX.toFixed(3)},${ratio.pxPerMickeyY.toFixed(3)})` : 'null'})`;
      console.error(`  trial ${trial}: SKIP — ${reason}`);
      await fs.appendFile(outPath, JSON.stringify({
        trial, target,
        startCursorLogical: start.cursorLogical,
        startHdmi: { x: Math.round(startHdmi.x), y: Math.round(startHdmi.y) },
        ratioPreview: ratio, plannedMickeysX, plannedMickeysY, skipReason: reason,
      }) + '\n');
      continue;
    }

    try {
      await moveToPixel(client, target, {
        profile: profile ?? undefined,
        strategy: 'assume-at',
        assumeCursorAt: { x: startHdmi.x, y: startHdmi.y },
        correct: false,
        forbidSlamFallback: true,
      });
    } catch (e) {
      console.error(`  trial ${trial}: moveToPixel threw — ${(e as Error).message}`);
      await fs.appendFile(outPath, JSON.stringify({ trial, target, error: (e as Error).message }) + '\n');
      continue;
    }

    await sleep(400);
    const end = await readCursorHdmi(sess, geom);
    if (!end) {
      console.error(`  trial ${trial}: getCursor failed at end (catastrophic emit?); reconnecting`);
      await fs.appendFile(outPath, JSON.stringify({
        trial, target, startCursorLogical: start.cursorLogical,
        error: 'WS disconnected after moveToPixel (catastrophic emit)',
      }) + '\n');
      await reconnect();
      continue;
    }

    const residualHdmi = Math.hypot(end.ipadHdmi.x - target.x, end.ipadHdmi.y - target.y);
    await fs.appendFile(outPath, JSON.stringify({
      trial, target,
      startCursorLogical: start.cursorLogical,
      endCursorLogical: end.cursorLogical,
      startHdmi: { x: Math.round(startHdmi.x), y: Math.round(startHdmi.y) },
      endHdmi: { x: Math.round(end.ipadHdmi.x), y: Math.round(end.ipadHdmi.y) },
      residualHdmi: Number(residualHdmi.toFixed(1)),
    }) + '\n');

    console.error(
      `${String(trial).padStart(2)}     (${String(target.x).padStart(4)},${String(target.y).padStart(4)})   ` +
      `(${end.cursorLogical.x.toFixed(0).padStart(4)},${end.cursorLogical.y.toFixed(0).padStart(4)})        ` +
      `${residualHdmi.toFixed(1).padStart(6)} px`,
    );
  }

  console.error('');
  console.error(`Output: ${outPath}`);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
