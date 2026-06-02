/**
 * 6.4 — map where v2-wider's prediction matches reality.
 *
 * 6.1+6.2 showed v2-wider's median pure-open-loop residual is 3.5x worse
 * than constant in production's typical regime (cold-start, dt=0). But
 * the model was TRAINED on chunked-burst sequences with non-zero dt and
 * with prior emit history. Maybe it's accurate in the regime it was
 * trained on, just bad at cold-start? This bench maps that.
 *
 * For each combination of (chunkMag, direction, dt_prev_emit_ms):
 *   1. Reset cursor to a known position
 *   2. Optionally pre-emit + wait dt_prev_emit_ms (so the cursor has
 *      history when we emit the test chunk)
 *   3. Query iPadCollector for cursor position before the test emit
 *   4. Emit one chunkMag-mickey chunk via PiKVM HID
 *   5. Wait settle
 *   6. Query iPadCollector for cursor position after
 *   7. Compute actual_displacement (HDMI px)
 *   8. Use v2-wider to predict displacement for the same inputs
 *   9. Record (params, predicted, actual, error)
 *
 * Output: jsonl per row, easy to grep / plot.
 *
 * Usage:
 *   npx tsx benches/bench-6.4-prediction-vs-reality.ts --reps 3
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
import { buildFeatures, predictDisplacement, pointerAccelModelExists } from '../src/pikvm/pointer-accel.js';

const PORT = 8767;
const REPS = Number(process.argv[process.argv.indexOf('--reps') + 1] || 3);
const IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353';
const IPAD_BUNDLE_ID = 'com.bb.iPadCollector';
const IPAD_LOGICAL_W = 820;
const IPAD_LOGICAL_H = 1180;

const SWEEP = {
  chunkMag: [10, 20, 30, 40],          // 4 magnitudes
  direction: ['+x', '-x', '+y', '-y'], // 4 cardinal directions
  dtPrev:   [0, 50, 200],              // 3 cold-start-to-warm regimes (ms since prev emit)
};
// Total per-rep: 4 * 4 * 3 = 48 conditions. With REPS=3 → 144 trials. ~7 min.

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
  console.error(`[6.4-pred-vs-real] reps=${REPS}, sweep size = ${SWEEP.chunkMag.length}*${SWEEP.direction.length}*${SWEEP.dtPrev.length} = ${SWEEP.chunkMag.length * SWEEP.direction.length * SWEEP.dtPrev.length}`);

  relaunchIpadApp();
  await sleep(3000);
  console.error('[6.4-pred-vs-real] waiting for iPad app to connect…');
  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  console.error(`[6.4-pred-vs-real] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

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
  console.error(`[6.4-pred-vs-real] iPad tight: ${JSON.stringify(tight)}`);

  await sleep(200);
  await sess.syncClock(5);
  await detectIpadBounds(client);

  if (!pointerAccelModelExists()) {
    console.error('[6.4-pred-vs-real] WARNING: pointer-accel model not found — predictions will be null');
  }
  const bounds = getLastGoodBounds();
  if (!bounds) throw new Error('iPad bounds not detected');

  const outDir = './data/bench-6.4';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `prediction-vs-reality.jsonl`);
  await fs.writeFile(outPath, '');

  console.error('');
  console.error('chunkMag dir dtPrev  rep  start              end                actual_hdmi  pred_hdmi   err_hdmi');
  console.error('-'.repeat(110));

  for (let rep = 1; rep <= REPS; rep++) {
    for (const chunkMag of SWEEP.chunkMag) {
      for (const direction of SWEEP.direction) {
        for (const dtPrev of SWEEP.dtPrev) {
          // Step 1: reset cursor near the mid-screen (not exact center to
          // avoid clamping at edges across the sweep).
          await client.mouseMoveRelative(-2000, -2000);
          await sleep(150);
          await client.mouseMoveRelative(-2000, -2000);
          await sleep(150);
          // Move to a neutral mid-screen position via raw HID (no model).
          await client.mouseMoveRelative(300, 400);
          await sleep(150);
          await client.mouseMoveRelative(100, 100);

          // Step 2: warm-up emit + dt_prev wait IF this regime requires
          // history. The model's "dt_prev_emit_ms" feature is the time
          // since the immediately-preceding emit. We can simulate that by
          // firing a SMALL prior emit then waiting dtPrev ms before the
          // test emit.
          if (dtPrev > 0) {
            // Small prior emit in same direction (gives model the
            // velocity/history context it expects).
            const prior_dx = direction === '+x' ? 5 : direction === '-x' ? -5 : 0;
            const prior_dy = direction === '+y' ? 5 : direction === '-y' ? -5 : 0;
            await client.mouseMoveRelative(prior_dx, prior_dy);
            await sleep(dtPrev);
          } else {
            // Cold start — give the cursor a long quiet period first.
            await sleep(1000);
          }

          let startCursor;
          try { startCursor = await sess.getCursor(); }
          catch (e) {
            console.error(`  rep=${rep} chunkMag=${chunkMag} dir=${direction} dtPrev=${dtPrev}: getCursor start failed`);
            continue;
          }

          // Step 4: fire the test emit (single chunkMag-mickey emit in dir).
          const dx = direction === '+x' ? chunkMag : direction === '-x' ? -chunkMag : 0;
          const dy = direction === '+y' ? chunkMag : direction === '-y' ? -chunkMag : 0;
          await client.mouseMoveRelative(dx, dy);
          await sleep(350);

          let endCursor;
          try { endCursor = await sess.getCursor(); }
          catch (e) {
            console.error(`  rep=${rep} chunkMag=${chunkMag} dir=${direction} dtPrev=${dtPrev}: getCursor end failed`);
            continue;
          }

          // Step 7: actual displacement (HDMI px).
          const actualDxLogical = endCursor.x - startCursor.x;
          const actualDyLogical = endCursor.y - startCursor.y;
          const actualDxHdmi = actualDxLogical * scaleHdmiPerLogical.x;
          const actualDyHdmi = actualDyLogical * scaleHdmiPerLogical.y;

          // Step 8: query v2-wider prediction for the same input.
          // buildFeatures expects emit-history; for "dt_prev" regimes we
          // simulate one emit-history entry at t=-dtPrev with the small
          // prior emit we fired. For cold-start (dt=0) we pass empty.
          const features = dtPrev > 0
            ? buildFeatures(
                [{ t: -dtPrev, dx: dx > 0 ? 5 : dx < 0 ? -5 : 0, dy: dy > 0 ? 5 : dy < 0 ? -5 : 0 }],
                { vxPxPerMs: 0, vyPxPerMs: 0 },
                { dx, dy, t: 0 },
                dtPrev,
              )
            : buildFeatures(
                [],
                { vxPxPerMs: 0, vyPxPerMs: 0 },
                { dx, dy, t: 0 },
                0,
              );
          const pred = await predictDisplacement(features);
          const predDxHdmi = pred ? pred.dx * scaleHdmiPerLogical.x : NaN;
          const predDyHdmi = pred ? pred.dy * scaleHdmiPerLogical.y : NaN;

          // Step 9: error.
          const errHdmi = Number.isFinite(predDxHdmi)
            ? Math.hypot(predDxHdmi - actualDxHdmi, predDyHdmi - actualDyHdmi)
            : NaN;

          await fs.appendFile(outPath, JSON.stringify({
            rep, chunkMag, direction, dtPrev,
            actualDxHdmi: Number(actualDxHdmi.toFixed(1)),
            actualDyHdmi: Number(actualDyHdmi.toFixed(1)),
            predDxHdmi: Number.isFinite(predDxHdmi) ? Number(predDxHdmi.toFixed(1)) : null,
            predDyHdmi: Number.isFinite(predDyHdmi) ? Number(predDyHdmi.toFixed(1)) : null,
            errHdmi: Number.isFinite(errHdmi) ? Number(errHdmi.toFixed(1)) : null,
          }) + '\n');

          console.error(
            `${String(chunkMag).padStart(3)}      ${direction}  ${String(dtPrev).padStart(4)}    ${rep}    (${startCursor.x.toFixed(0).padStart(4)},${startCursor.y.toFixed(0).padStart(4)})    (${endCursor.x.toFixed(0).padStart(4)},${endCursor.y.toFixed(0).padStart(4)})    (${actualDxHdmi.toFixed(0).padStart(4)},${actualDyHdmi.toFixed(0).padStart(4)})  (${Number.isFinite(predDxHdmi) ? predDxHdmi.toFixed(0).padStart(4) : '  NA'},${Number.isFinite(predDyHdmi) ? predDyHdmi.toFixed(0).padStart(4) : '  NA'})    ${Number.isFinite(errHdmi) ? errHdmi.toFixed(0).padStart(4) : '  NA'} px`,
          );
        }
      }
    }
  }

  console.error('');
  console.error(`Output: ${outPath}`);
  closeServer().catch(() => undefined);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
