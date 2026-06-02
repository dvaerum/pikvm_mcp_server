/**
 * 1.13c — clean ground-truth A/B on pointer-accel.
 *
 * The 1.11 +55pp HIT lift measured CLICK SUCCESS, not pointer-movement
 * accuracy. The chain (emit → cursor lands → detector reports → safety
 * gate decides → click fires → app launches) succeeded 80% with v2-wider
 * vs 25% with v1, but I never directly measured "where did the cursor
 * actually land vs where I asked it to". 1.13b just proved the screenshot
 * detector lies on cursor-on-icon frames, so the detector-reported
 * residuals in 1.11 can't carry the attribution.
 *
 * This bench bypasses the detector entirely. The iPadCollector SwiftUI
 * sidecar streams the iPad's OWN reported cursor position over WS — that
 * is the ground truth. For each trial:
 *
 *   1. Slam cursor to a known starting position (top-left corner-ish).
 *   2. Read start position from iPadCollector (logical px).
 *   3. Call moveToPixel with the chosen pointer-accel arm; disable
 *      the correction loop so the open-loop emit alone decides where
 *      we land.
 *   4. Read end position from iPadCollector.
 *   5. residual = |iPad_reported_end - target| (converted via the
 *      detected scale to HDMI px so it's directly comparable to the
 *      safety gate's 35-px threshold).
 *
 * Arms:
 *   - `--arm constant`      PIKVM_USE_LEARNED_BALLISTICS=0 (px/mickey = 1.0)
 *   - `--arm v1`            PIKVM_USE_LEARNED_BALLISTICS=1 + v1.onnx
 *   - `--arm v2-wider`      PIKVM_USE_LEARNED_BALLISTICS=1 + v2-wider.onnx
 *
 * Usage:
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-1.13c-groundtruth-pointer-accel.ts --arm constant
 *   PIKVM_USE_LEARNED_BALLISTICS=1 PIKVM_POINTER_ACCEL_MODEL=ml/pointer-accel-v1.onnx npx tsx benches/bench-1.13c-groundtruth-pointer-accel.ts --arm v1
 *   PIKVM_USE_LEARNED_BALLISTICS=1 PIKVM_POINTER_ACCEL_MODEL=ml/pointer-accel-v2-wider.onnx npx tsx benches/bench-1.13c-groundtruth-pointer-accel.ts --arm v2-wider
 *
 * Output: data/bench-1.13c/${arm}.jsonl  (one row per trial)
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  killOrphansOnPort,
  startIpadAppServer,
  IpadSession,
} from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { detectIpadBounds } from '../src/pikvm/orientation.js';

const PORT = 8767;
const ARM = (() => {
  const i = process.argv.indexOf('--arm');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--arm <constant|v1|v2-wider> required');
  return process.argv[i + 1];
})();
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 10);

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function waitForSession(): Promise<{ sess: IpadSession; closeServer: () => Promise<void> }> {
  return new Promise((resolve) => {
    const stop = startIpadAppServer({
      port: PORT,
      onSession: async (sess) => {
        const startedAt = Date.now();
        while (!sess.hello && Date.now() - startedAt < 5000) await sleep(20);
        resolve({ sess, closeServer: async () => { (await stop).close(); } });
      },
    });
  });
}

async function main() {
  killOrphansOnPort(PORT);
  console.error(`[gt-bench] arm=${ARM}, trials=${TRIALS}`);
  console.error(`[gt-bench] PIKVM_USE_LEARNED_BALLISTICS=${process.env.PIKVM_USE_LEARNED_BALLISTICS}`);
  console.error(`[gt-bench] PIKVM_POINTER_ACCEL_MODEL=${process.env.PIKVM_POINTER_ACCEL_MODEL || '(default)'}`);
  console.error('[gt-bench] waiting for iPad app to connect…');

  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello payload');
  console.error(`[gt-bench] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Light the iPad with a solid scene so detection works clean.
  await sess.showScene({ kind: 'procedural', params: { proc_kind: 'solid', r: 0.95, g: 0.95, b: 0.95 } });
  await sleep(400);
  const shot0 = await client.screenshot();
  const region = await detectIpadRegion(shot0.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN, y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN, h: region.h - 2 * NATIVE_MARGIN,
  };
  const scaleHdmiPerLogical = {
    x: tight.w / sess.hello.logicalW,
    y: tight.h / sess.hello.logicalH,
  };
  console.error(`[gt-bench] iPad tight region: ${JSON.stringify(tight)}`);
  console.error(`[gt-bench] HDMI-per-logical scale: x=${scaleHdmiPerLogical.x.toFixed(3)} y=${scaleHdmiPerLogical.y.toFixed(3)}`);

  await sleep(200);
  await sess.syncClock(5);

  // CRITICAL: populate the iPad-bounds cache that learnedBallisticsPxPerMickey
  // depends on. Without this, getLastGoodBounds() returns null, the learned-
  // ballistics path silently no-ops, and moveToPixel falls back to the
  // constant 1.0 px/mickey — making v1/v2/constant arms indistinguishable.
  const bounds = await detectIpadBounds(client);
  console.error(`[gt-bench] detected iPad bounds: ${JSON.stringify(bounds)}`);

  const profile = await loadProfile('./data/ballistics.json').catch(() => null);

  // Sample N target points roughly evenly across the iPad area in HDMI coords.
  // Use deterministic interior grid + small jitter so arms see the same targets.
  const rng = (() => { let s = 1337; return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x80000000; }; })();
  const targets: { x: number; y: number }[] = [];
  for (let i = 0; i < TRIALS; i++) {
    // 20% margin inside the iPad area to keep targets reachable without edge-clamp.
    const u = 0.2 + 0.6 * rng();
    const v = 0.2 + 0.6 * rng();
    targets.push({
      x: Math.round(tight.x + u * tight.w),
      y: Math.round(tight.y + v * tight.h),
    });
  }

  const outDir = './data/bench-1.13c';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ARM}.jsonl`);
  await fs.writeFile(outPath, '');

  console.error('');
  console.error(`trial  target(hdmi)        slam_start(logical)    iPad_end(logical)     actual_hdmi          residual_hdmi`);
  console.error('-'.repeat(110));

  for (let trial = 1; trial <= TRIALS; trial++) {
    const target = targets[trial - 1];

    // Slam to top-left corner — clamp at iPad edges. Use slam-then-move
    // strategy on a DUMMY target to do the slam, then read iPadCollector
    // for the actual start position. Simpler: directly emit huge -dx/-dy.
    await client.mouseMoveRelative(-1000, -1000);
    await sleep(200);
    await client.mouseMoveRelative(-1000, -1000);
    await sleep(400);

    let startCursor;
    try { startCursor = await sess.getCursor(); }
    catch (e) { console.error(`  trial ${trial}: getCursor failed at start — ${(e as Error).message}`); continue; }

    // Pure-open-loop moveToPixel: assume-at (use current belief — we just
    // slammed to (0,0) ish) + no correction loop. This isolates the
    // model's px/mickey ratio as the only thing different between arms.
    // We set the belief to the iPadCollector-reported start position
    // converted to HDMI px so moveToPixel knows where it's starting.
    const startHdmi = {
      x: tight.x + startCursor.x * scaleHdmiPerLogical.x,
      y: tight.y + startCursor.y * scaleHdmiPerLogical.y,
    };
    // Seed belief at the iPad-reported start so moveToPixel computes
    // the correct emit distance.
    client.belief?.reset({ x: startHdmi.x, y: startHdmi.y });

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

    let endCursor;
    try { endCursor = await sess.getCursor(); }
    catch (e) { console.error(`  trial ${trial}: getCursor failed at end — ${(e as Error).message}`); continue; }

    const endHdmi = {
      x: tight.x + endCursor.x * scaleHdmiPerLogical.x,
      y: tight.y + endCursor.y * scaleHdmiPerLogical.y,
    };
    const residualHdmi = Math.hypot(endHdmi.x - target.x, endHdmi.y - target.y);

    const row = {
      trial,
      target,
      startCursorLogical: { x: startCursor.x, y: startCursor.y },
      endCursorLogical: { x: endCursor.x, y: endCursor.y },
      startHdmi: { x: Math.round(startHdmi.x), y: Math.round(startHdmi.y) },
      endHdmi: { x: Math.round(endHdmi.x), y: Math.round(endHdmi.y) },
      residualHdmi: Number(residualHdmi.toFixed(1)),
    };
    await fs.appendFile(outPath, JSON.stringify(row) + '\n');

    console.error(
      `${String(trial).padStart(2)}     (${String(target.x).padStart(4)},${String(target.y).padStart(4)})  ` +
      `(${startCursor.x.toFixed(0).padStart(4)},${startCursor.y.toFixed(0).padStart(4)})      ` +
      `(${endCursor.x.toFixed(0).padStart(4)},${endCursor.y.toFixed(0).padStart(4)})      ` +
      `(${Math.round(endHdmi.x).toString().padStart(4)},${Math.round(endHdmi.y).toString().padStart(4)})     ` +
      `${residualHdmi.toFixed(1).padStart(6)} px`,
    );
  }

  console.error('');
  console.error(`Output: ${outPath}`);
  // Don't await closeServer() — WS close can hang waiting for the iPad
  // side to acknowledge. We've written everything we need.
  closeServer().catch(() => undefined);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
