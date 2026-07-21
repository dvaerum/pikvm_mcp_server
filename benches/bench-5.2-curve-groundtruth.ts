/**
 * Curve-one-shot ground-truth bench — the missing regression net for the
 * iPad's PRODUCTION default mover.
 *
 * Every other bench drives detect-then-move or assume-at; NONE exercises
 * strategy='curve-one-shot' (the iPad click_at/move_to default). This bench
 * fills that gap so the C1-P3 `curve` reroute (routing curve-mover.detect()
 * through CursorLocator) can be §0-gated against iPadCollector ground truth
 * instead of guessed at.
 *
 * Per trial: slam cursor to a known corner, call moveToPixel(curve-one-shot)
 * to a target, read the REAL cursor position from iPadCollector getCursor(),
 * record the HDMI-px residual. curve-one-shot does its own internal detect +
 * one deterministic emit (+ optional correction), so one call per trial is the
 * whole mover.
 *
 * Usage (launch iPadCollector first OR let this relaunch it):
 *   PIKVM_PROXY=http://127.0.0.1:8888 npx tsx benches/bench-5.2-curve-groundtruth.ts --trials 20
 * Output: data/bench-5.2-curve-gt/curve.jsonl  (one row per trial)
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
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1] || 20);
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

async function waitForSession(): Promise<{ sess: IpadSession }> {
  return new Promise((resolve) => {
    startIpadAppServer({
      port: PORT,
      onSession: async (sess) => {
        const startedAt = Date.now();
        while (!sess.hello && Date.now() - startedAt < 5000) await sleep(20);
        resolve({ sess });
      },
    });
  });
}

async function main() {
  killOrphansOnPort(PORT);
  console.error(`[5.2-curve] trials=${TRIALS}/target`);
  relaunchIpadApp();
  await sleep(3000);
  console.error('[5.2-curve] waiting for iPad app to connect…');

  const { sess } = await waitForSession();
  if (!sess.hello) throw new Error('no hello payload');
  console.error(`[5.2-curve] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

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
  console.error(`[5.2-curve] iPad tight region: ${JSON.stringify(tight)}`);

  await sleep(200);
  await sess.syncClock(5);
  await detectIpadBounds(client);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);

  const targets = [
    { name: 'mid-center',  x: Math.round(tight.x + 0.50 * tight.w), y: Math.round(tight.y + 0.50 * tight.h) },
    { name: 'upper-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.25 * tight.h) },
    { name: 'lower-left',  x: Math.round(tight.x + 0.25 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
    { name: 'lower-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
  ];

  const outDir = './data/bench-5.2-curve-gt';
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'curve.jsonl');
  await fs.writeFile(outPath, '');

  console.error('');
  console.error(`target          trial   resid_hdmi`);
  console.error('-'.repeat(48));

  for (const target of targets) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      // Slam to top-left as a known starting position.
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(200);
      await client.mouseMoveRelative(-2000, -2000);
      await sleep(400);

      try {
        await moveToPixel(client, target, {
          profile: profile ?? undefined,
          strategy: 'curve-one-shot',
          forbidSlamFallback: true,
        });
      } catch (e) {
        await fs.appendFile(outPath, JSON.stringify({
          target: target.name, trial, error: (e as Error).message,
        }) + '\n');
        console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}   ERROR: ${(e as Error).message.slice(0, 30)}`);
        continue;
      }

      await sleep(350);
      let cursor;
      try {
        cursor = await sess.getCursor();
      } catch {
        console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}   getCursor failed; skipping`);
        continue;
      }

      const ipadHdmi = {
        x: tight.x + cursor.x * scaleHdmiPerLogical.x,
        y: tight.y + cursor.y * scaleHdmiPerLogical.y,
      };
      const residHdmi = Math.hypot(ipadHdmi.x - target.x, ipadHdmi.y - target.y);

      await fs.appendFile(outPath, JSON.stringify({
        target: target.name, target_x: target.x, target_y: target.y,
        trial,
        cursorLogical: { x: cursor.x, y: cursor.y },
        ipadHdmi: { x: Math.round(ipadHdmi.x), y: Math.round(ipadHdmi.y) },
        residualHdmi: Number(residHdmi.toFixed(1)),
      }) + '\n');

      console.error(`${target.name.padEnd(14)}  ${String(trial).padStart(5)}   ${residHdmi.toFixed(1).padStart(7)} px`);
    }
  }

  console.error(`\nOutput: ${outPath}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
