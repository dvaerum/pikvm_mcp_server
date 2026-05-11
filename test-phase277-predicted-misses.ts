/**
 * Phase 277: diagnose 'predicted' mode misses.
 *
 * Phase 275 found ~3/6 near-target misses end in modeHistory just
 * [predicted] — no detector fired at all. Either the cursor isn't
 * in any of the captured frames, or the locality radius (100 px
 * around newPredicted) excluded the actual cursor.
 *
 * For each failed trial, capture the post-move frame and run
 * UNHINTED shape detection (no locality restriction, just the
 * highest-scoring candidate anywhere). If unhinted shape finds the
 * cursor, the cursor IS in the frame but was outside the 100 px
 * gate. If unhinted shape returns null OR returns a clearly-wrong
 * position (dock area, clock widget), the cursor is missing.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase277-predicted-misses/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 277 predicted-miss diagnostic at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 905, y: 800 };
const N = 10;

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  let residual: number | null = null;
  let finalMode = 'none';
  let modeHistory: string[] = [];

  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    if (r.finalDetectedPosition) {
      residual = Math.hypot(r.finalDetectedPosition.x - TARGET.x, r.finalDetectedPosition.y - TARGET.y);
    }
    modeHistory = r.diagnostics.map(d => d.mode);
    const lastDiag = r.diagnostics[r.diagnostics.length - 1];
    if (lastDiag) finalMode = lastDiag.mode;
  } catch (e) {
    console.error(`  threw: ${(e as Error).message.slice(0, 80)}`);
  }

  // Capture post-move frame for analysis
  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-post.jpg`, shot.buffer);

  const hit = residual !== null && residual <= 35;
  const isPredictedMiss = !hit && finalMode === 'predicted';

  console.error(
    `  residual=${residual !== null ? residual.toFixed(0).padStart(4) + 'px' : 'null  '}  ` +
    `final=${finalMode}  modes=[${modeHistory.join(',')}]  ${hit ? 'HIT' : 'MISS'}`,
  );

  // For predicted-mode failures, run unhinted shape on the post frame
  if (isPredictedMiss) {
    const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const unhinted = findCursorByShape(dec.data, dec.info.width, dec.info.height);
    if (unhinted) {
      const distFromTarget = Math.hypot(unhinted.centroidX - TARGET.x, unhinted.centroidY - TARGET.y);
      const inDockOrClock =
        unhinted.centroidY > 920 || // dock
        (unhinted.centroidY < 200 && unhinted.centroidX < 750); // clock widget
      console.error(
        `  UNHINTED shape best: (${Math.round(unhinted.centroidX)},${Math.round(unhinted.centroidY)}) ` +
        `score ${unhinted.shapeScore.toFixed(3)} pix=${unhinted.pixels} ` +
        `dist-from-target=${distFromTarget.toFixed(0)} px ` +
        `${inDockOrClock ? '(likely DOCK/CLOCK FP)' : '(plausible cursor location)'}`,
      );
      // If unhinted shape finds something near target, widening
      // locality from 100 → 150 would have caught it.
      if (distFromTarget < 150 && !inDockOrClock) {
        console.error(`  → Cursor likely IN FRAME but just outside locality radius 100`);
        console.error(`  → Widening to 150 px would have caught this`);
      } else if (inDockOrClock) {
        console.error(`  → Detector picked dock/clock — cursor either not in frame OR detector confused`);
      } else {
        console.error(`  → Detector found something far from target — cursor probably not in frame`);
      }
    } else {
      console.error(`  UNHINTED shape: null (no candidate anywhere in frame)`);
      console.error(`  → Cursor likely NOT in frame at all (faded, off-screen, or behind widget)`);
    }
  }
}

console.error(`\nFrames saved to ${ROOT}`);
console.error(`Visually inspect any 'predicted-miss' trials to confirm cursor visibility.`);
process.exit(0);
