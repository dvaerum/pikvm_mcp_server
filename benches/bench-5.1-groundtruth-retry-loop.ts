/**
 * 5.1 — clean ground-truth A/B on the retry-instability fix.
 *
 * The production-bench A/B (1.14 baseline vs 5.1 fix) saw the fix
 * eliminate SKIPs but not move gross HIT rate at N=20 (±15pp noise). To
 * tell whether the fix actually reduced the cursor-drift-during-retries
 * pattern we need to measure CURSOR LANDING, not click success — and we
 * need ground truth, not the screenshot detector that 1.13b proved lies
 * on cursor-on-icon frames.
 *
 * Design: replicate the clickAtWithRetry retry loop OUTSIDE production
 * code, using iPadCollector's reported cursor position as ground truth.
 * For each (target × trial × arm), run a 4-attempt sequence simulating
 * what clickAtWithRetry does, then compare the per-attempt residual
 * distributions between arms.
 *
 * Arms:
 *   - `--arm control`   every attempt uses strategy='detect-then-move'
 *                       (the pre-5.1 behaviour)
 *   - `--arm fix-on`    attempt 1 uses detect-then-move; on attempt N
 *                       (N≥2), if the previous attempt's iPadCollector-
 *                       reported residual was ≤ AT_TARGET_THRESHOLD,
 *                       use strategy='assume-at' with the previous
 *                       iPad-reported HDMI position. Otherwise fall
 *                       back to detect-then-move.
 *
 * What this measures that the production bench cannot:
 *   - The actual per-attempt residual against ground truth (no
 *     detector mediation, no inverse-hallucination contamination).
 *   - Whether the fix specifically reduces "cursor was on target at
 *     attempt N, drifted away by attempt N+1" — the dominant pattern
 *     (52.5%) from the 4.1' audit.
 *
 * What this does NOT measure:
 *   - Actual click success (no clicks fired here).
 *   - Tap registration (the 5.1 fix's NOLAUNCH side-channel).
 *
 * Targets: a small set of positions inside the iPad app's view. The
 * iPad shows a solid-grey scene so the cursor (orange-bordered) is
 * readily detectable for the detect-then-move probe. iPadCollector
 * reports cursor position in iPad logical px; bench converts to HDMI
 * via the same scale moveToPixel uses.
 *
 * Usage:
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-5.1-groundtruth-retry-loop.ts --arm control --trials 8
 *   PIKVM_USE_LEARNED_BALLISTICS=0 npx tsx benches/bench-5.1-groundtruth-retry-loop.ts --arm fix-on  --trials 8
 *
 * Output: data/bench-5.1-gt/${arm}.jsonl  (one row per attempt)
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
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { detectIpadBounds } from '../src/pikvm/orientation.js';

const PORT = 8767;
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
const IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353';
const IPAD_BUNDLE_ID = 'com.bb.iPadCollector';

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function relaunchIpadApp(): void {
  try {
    execSync(
      `xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`,
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.error(`  [relaunch failed: ${(e as Error).message}]`);
  }
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
  console.error(`[5.1-gt] arm=${ARM}, trials=${TRIALS}, max_attempts=${MAX_ATTEMPTS}`);
  console.error('[5.1-gt] waiting for iPad app to connect…');

  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello payload');
  console.error(`[5.1-gt] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Solid grey scene — the iPad cursor (orange-bordered) shows up
  // cleanly against grey for the detect-then-move probe to find it.
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
  console.error(`[5.1-gt] iPad tight region: ${JSON.stringify(tight)}`);
  console.error(`[5.1-gt] HDMI-per-logical scale: x=${scaleHdmiPerLogical.x.toFixed(3)} y=${scaleHdmiPerLogical.y.toFixed(3)}`);

  await sleep(200);
  await sess.syncClock(5);
  await detectIpadBounds(client);

  const profile = await loadProfile('./data/ballistics.json').catch(() => null);

  // Four representative target positions spanning the iPad area.
  // Targets are in HDMI pixel coords so they're directly comparable to
  // production click-bench targets.
  const targets = [
    { name: 'mid-center',  x: Math.round(tight.x + 0.50 * tight.w), y: Math.round(tight.y + 0.50 * tight.h) },
    { name: 'upper-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.25 * tight.h) },
    { name: 'lower-left',  x: Math.round(tight.x + 0.25 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
    { name: 'lower-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
  ];

  const outDir = './data/bench-5.1-gt';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ARM}.jsonl`);
  await fs.writeFile(outPath, '');

  console.error('');
  console.error(`target          trial  attempt  strategy           resid_hdmi`);
  console.error('-'.repeat(80));

  for (const target of targets) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      // Slam to top-left as known starting position.
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(200);
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(400);

      let prevIpadHdmi: { x: number; y: number } | null = null;
      let prevResidualHdmi: number | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 5.1 fix logic: on attempt > 1, if PREVIOUS attempt was at-target
        // (per iPadCollector ground truth, not screenshot detector), use
        // strategy='assume-at' with the previous landing position. Else
        // detect-then-move (the pre-5.1 behaviour).
        const useAssumeAt = ARM === 'fix-on'
          && attempt > 1
          && prevResidualHdmi !== null
          && prevResidualHdmi <= AT_TARGET_THRESHOLD_PX
          && prevIpadHdmi !== null;

        const moveOpts = useAssumeAt
          ? {
              profile: profile ?? undefined,
              strategy: 'assume-at' as const,
              assumeCursorAt: prevIpadHdmi!,
              correct: true,
              forbidSlamFallback: true,
            }
          : {
              profile: profile ?? undefined,
              strategy: 'detect-then-move' as const,
              correct: true,
              forbidSlamFallback: true,
            };

        try {
          await moveToPixel(client, target, moveOpts);
        } catch (e) {
          await fs.appendFile(outPath, JSON.stringify({
            target: target.name, trial, attempt,
            strategy: moveOpts.strategy,
            error: (e as Error).message,
          }) + '\n');
          console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(attempt).padStart(7)}  ${moveOpts.strategy.padEnd(17)}  ERROR: ${(e as Error).message.slice(0, 30)}`);
          continue;
        }

        await sleep(350);

        let cursor;
        try {
          cursor = await sess.getCursor();
        } catch (e) {
          console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(attempt).padStart(7)}  ${moveOpts.strategy.padEnd(17)}  getCursor failed; aborting trial`);
          break;
        }

        const ipadHdmi = {
          x: tight.x + cursor.x * scaleHdmiPerLogical.x,
          y: tight.y + cursor.y * scaleHdmiPerLogical.y,
        };
        const residHdmi = Math.hypot(ipadHdmi.x - target.x, ipadHdmi.y - target.y);

        await fs.appendFile(outPath, JSON.stringify({
          target: target.name, target_x: target.x, target_y: target.y,
          trial, attempt,
          strategy: moveOpts.strategy,
          cursorLogical: { x: cursor.x, y: cursor.y },
          ipadHdmi: { x: Math.round(ipadHdmi.x), y: Math.round(ipadHdmi.y) },
          residualHdmi: Number(residHdmi.toFixed(1)),
        }) + '\n');

        console.error(
          `${target.name.padEnd(14)}  ${String(trial).padStart(5)}  ${String(attempt).padStart(7)}  ${moveOpts.strategy.padEnd(17)}  ${residHdmi.toFixed(1).padStart(7)} px`,
        );

        prevIpadHdmi = ipadHdmi;
        prevResidualHdmi = residHdmi;
      }
    }
  }

  console.error('');
  console.error(`Output: ${outPath}`);
  closeServer().catch(() => undefined);
  process.exit(0);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(2); });
