/**
 * 6.5 — run the 1.12 open-loop planner against the real iPad.
 *
 * 1.12 Phase 2 said the planner produced 721 px median residual in
 * synthetic replay (planner queries v2 → predicted landing → continues
 * planning). That's a "model predicts model's outcome" loop; it
 * doesn't directly test "what happens when we fire the planned emits
 * at the actual iPad". iPadCollector's getCursor lets us measure that.
 *
 * For each target × trial:
 *   1. Slam cursor to known start
 *   2. Read iPad-reported start position
 *   3. Run the planner to produce an emit sequence (planner uses v2-wider
 *      as its forward model; planning ratio queried at dt_prev=chunkPaceMs
 *      = 30ms, which 6.4 showed is the model's accurate regime)
 *   4. Fire each planned emit; after every Kth emit (or all of them)
 *      query iPad for cursor position
 *   5. After all emits: compute final residual to target
 *
 * We record the FULL per-step landing trajectory so the analysis can
 * answer: does the cursor track the planner's predicted trajectory? At
 * what step does drift accumulate? Is it the cold-start chunk or
 * later? Or none?
 *
 * Usage:
 *   PIKVM_USE_LEARNED_BALLISTICS=1 PIKVM_POINTER_ACCEL_MODEL=ml/pointer-accel-v2-wider.onnx \
 *     npx tsx benches/bench-6.5-planner-vs-ipad.ts --trials 3
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  killOrphansOnPort,
  startIpadAppServer,
  IpadSession,
} from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { detectIpadBounds, getLastGoodBounds } from '../src/pikvm/orientation.js';
import { predictDisplacement, HORIZON_MS, pointerAccelModelExists } from '../src/pikvm/pointer-accel.js';
import { planOpenLoopEmits } from '../src/pikvm/open-loop-planner.js';

const PORT = 8767;
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 3);
const IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353';
const IPAD_BUNDLE_ID = 'com.bb.iPadCollector';
const IPAD_LOGICAL_W = 820;
const IPAD_LOGICAL_H = 1180;
const CHUNK_MAG = 20;
const CHUNK_PACE_MS = 30;
const TOL_PX = 5;
const MAX_EMITS = 50;
const SAMPLE_EVERY_K = 5;  // query iPadCollector after every Kth planned emit

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function relaunchIpadApp(): void {
  try {
    execSync(
      `xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`,
      { stdio: 'pipe' },
    );
  } catch { /* best effort */ }
}

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
  console.error(`[6.5-planner] trials=${TRIALS}, chunkMag=${CHUNK_MAG}, chunkPaceMs=${CHUNK_PACE_MS}, maxEmits=${MAX_EMITS}, sample_every=${SAMPLE_EVERY_K}`);

  relaunchIpadApp();
  await sleep(3000);
  console.error('[6.5-planner] waiting for iPad app to connect…');
  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  console.error(`[6.5-planner] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  await sess.showScene({ kind: 'procedural', params: { proc_kind: 'solid', r: 0.55, g: 0.55, b: 0.55 } });
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

  await sleep(200);
  await sess.syncClock(5);
  await detectIpadBounds(client);

  if (!pointerAccelModelExists()) {
    throw new Error('v2-wider model missing');
  }

  // Targets in HDMI px — same set as production click bench so direct
  // comparison to 6.0/6.6 is possible.
  const targets = [
    { name: 'mid-center', x: Math.round(tight.x + 0.5 * tight.w),  y: Math.round(tight.y + 0.5 * tight.h) },
    { name: 'upper-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.25 * tight.h) },
    { name: 'lower-left',  x: Math.round(tight.x + 0.25 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
    { name: 'lower-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
  ];

  const outDir = './data/bench-6.5';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `planner-vs-ipad.jsonl`);
  await fs.writeFile(outPath, '');

  console.error('');
  console.error('target          trial  planned_emits  final_resid_hdmi  predicted_final_hdmi  reality_vs_plan');
  console.error('-'.repeat(110));

  for (const target of targets) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      // Slam to top-left, get known start position.
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(200);
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(400);

      let startCursor;
      try { startCursor = await sess.getCursor(); }
      catch (e) {
        console.error(`  ${target.name} trial ${trial}: getCursor start failed`);
        continue;
      }

      const startHdmi = {
        x: tight.x + startCursor.x * scaleHdmiPerLogical.x,
        y: tight.y + startCursor.y * scaleHdmiPerLogical.y,
      };

      // Plan the emit sequence. The planner uses v2-wider as its forward
      // model. Note: the planner queries the model with dt=chunkPaceMs
      // (30ms) for chunk 1 and beyond — 6.4 showed dt=50ms is the model's
      // accurate regime; dt=30ms is close to that.
      const dxPxTarget = target.x - startHdmi.x;
      const dyPxTarget = target.y - startHdmi.y;
      const planResult = await planOpenLoopEmits(
        { dxPx: dxPxTarget, dyPx: dyPxTarget },
        {
          chunkMag: CHUNK_MAG,
          chunkPaceMs: CHUNK_PACE_MS,
          horizonMs: HORIZON_MS,
          tolPx: TOL_PX,
          maxEmits: MAX_EMITS,
          predict: predictDisplacement,
          // Tight bounds detection gives us iPad region (HDMI px); convert
          // to scale that learnedBallisticsPxPerMickey computes.
          hdmiPerLogicalScale: scaleHdmiPerLogical,
        },
      );

      if (planResult.predictorFailed) {
        console.error(`  ${target.name} trial ${trial}: predictor failed`);
        continue;
      }

      const predictedFinalHdmi = {
        x: startHdmi.x + (dxPxTarget - planResult.residualPx.x),
        y: startHdmi.y + (dyPxTarget - planResult.residualPx.y),
      };

      // Fire the planned emits. After every SAMPLE_EVERY_K, query iPad
      // for cursor pos — produces the per-step trajectory.
      const trajectory: { emitIdx: number; ipadX: number; ipadY: number }[] = [];
      trajectory.push({ emitIdx: 0, ipadX: startCursor.x, ipadY: startCursor.y });
      for (let i = 0; i < planResult.emits.length; i++) {
        const e = planResult.emits[i];
        await client.mouseMoveRelative(e.dx, e.dy);
        await sleep(e.paceMs);
        if ((i + 1) % SAMPLE_EVERY_K === 0 || i === planResult.emits.length - 1) {
          await sleep(150);
          try {
            const c = await sess.getCursor();
            trajectory.push({ emitIdx: i + 1, ipadX: c.x, ipadY: c.y });
          } catch { /* skip */ }
        }
      }
      await sleep(300);

      let endCursor;
      try { endCursor = await sess.getCursor(); }
      catch {
        console.error(`  ${target.name} trial ${trial}: getCursor end failed`);
        continue;
      }
      const endHdmi = {
        x: tight.x + endCursor.x * scaleHdmiPerLogical.x,
        y: tight.y + endCursor.y * scaleHdmiPerLogical.y,
      };
      const finalResid = Math.hypot(endHdmi.x - target.x, endHdmi.y - target.y);
      const realityVsPlan = Math.hypot(endHdmi.x - predictedFinalHdmi.x, endHdmi.y - predictedFinalHdmi.y);

      await fs.appendFile(outPath, JSON.stringify({
        target: target.name, target_hdmi: target,
        trial,
        startCursorLogical: { x: startCursor.x, y: startCursor.y },
        startHdmi: { x: Math.round(startHdmi.x), y: Math.round(startHdmi.y) },
        plannedEmits: planResult.emits.length,
        planResidualPx: planResult.residualPx,
        predictedFinalHdmi: { x: Math.round(predictedFinalHdmi.x), y: Math.round(predictedFinalHdmi.y) },
        endCursorLogical: { x: endCursor.x, y: endCursor.y },
        endHdmi: { x: Math.round(endHdmi.x), y: Math.round(endHdmi.y) },
        finalResidHdmi: Number(finalResid.toFixed(1)),
        realityVsPlanHdmi: Number(realityVsPlan.toFixed(1)),
        trajectory,
      }) + '\n');

      console.error(
        `${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(planResult.emits.length).padStart(13)}  ${finalResid.toFixed(0).padStart(15)} px  ${`(${Math.round(predictedFinalHdmi.x)},${Math.round(predictedFinalHdmi.y)})`.padStart(20)}  ${realityVsPlan.toFixed(0).padStart(13)} px`,
      );
    }
  }

  console.error('');
  console.error(`Output: ${outPath}`);
  closeServer().catch(() => undefined);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
