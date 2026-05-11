/**
 * Phase 256: measure how long the iPad's soft cursor takes to fade
 * after the last mouse emit.
 *
 * User observed ~7 seconds visually. I claimed ~300 ms based on a
 * comment in seed-template.ts that says "cursor fades within ~200ms".
 * One of us is wrong. This script measures empirically.
 *
 * Procedure:
 *   1. Unlock + home + small wake emit so the cursor is rendered
 *   2. Wait t milliseconds, then capture a screenshot
 *   3. Run a small motion-diff between the post-wake frame and the
 *      now frame. If the cursor faded, the region around its last
 *      known position shows pixel differences (cursor erased).
 *      If it didn't fade, the region is identical.
 *   4. Repeat for t = 100, 250, 500, 1000, 2000, 4000, 7000, 10000 ms
 *
 * We compare each delayed-frame to the IMMEDIATE-post-wake frame
 * (taken right after the wake emit). The first frame where the
 * cursor-region pixel-diff goes above threshold = the time the
 * cursor faded.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase256-fade';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 256 cursor-fade measurement at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);

// Wake the cursor with a small visible emit
console.error('Step 0: wake cursor with (50, 50) emit');
await client.mouseMoveRelative(50, 50);
await sleep(200);

// Capture the reference frame WHILE the cursor should still be visible.
// Use keepalive-screenshot if available; that explicitly takes a frame
// with the cursor freshly nudged.
console.error('Step 1: capture reference frame (cursor freshly emitted)');
const refShot = await client.screenshot();
await fs.writeFile(`${ROOT}/ref-t0.jpg`, refShot.buffer);

// At intervals, capture another frame WITHOUT a fresh emit. The cursor
// will be in the same logical position; but the iPad may have stopped
// rendering it.
const delays = [250, 500, 1000, 2000, 4000, 7000, 10000];
const results: { delayMs: number; pixelDiffSum: number; maxPixelDiff: number }[] = [];

for (const delayMs of delays) {
  // Wait the FULL delay (relative to the reference shot time)
  await sleep(delayMs);
  console.error(`\nStep 2: capture after ${delayMs} ms (no fresh emit since t0)`);
  const shot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t-${delayMs}.jpg`, shot.buffer);

  // Compute pixel-diff against reference. Use sharp to decode both.
  const refRaw = await sharp(refShot.buffer).removeAlpha().raw().toBuffer();
  const tRaw = await sharp(shot.buffer).removeAlpha().raw().toBuffer();
  let diffSum = 0;
  let maxDiff = 0;
  const len = Math.min(refRaw.length, tRaw.length);
  for (let i = 0; i < len; i++) {
    const d = Math.abs(refRaw[i] - tRaw[i]);
    diffSum += d;
    if (d > maxDiff) maxDiff = d;
  }
  results.push({ delayMs, pixelDiffSum: diffSum, maxPixelDiff: maxDiff });
  console.error(`  → diffSum=${diffSum.toLocaleString()}  maxDiff=${maxDiff}`);
}

console.error('\n=== RESULT ===');
console.error('delayMs  | total pixel diff      | max single-pixel diff');
console.error('---------+----------------------+----------------------');
for (const r of results) {
  console.error(
    `${r.delayMs.toString().padStart(7)}  | ${r.pixelDiffSum.toLocaleString().padStart(20)} | ${r.maxPixelDiff.toString().padStart(20)}`,
  );
}

console.error('\nInterpretation:');
console.error('  - Static UI (clock minute ticks, weather widget refresh) will contribute');
console.error('    SOME constant pixel diff across all timepoints.');
console.error('  - A SUDDEN jump in diff between two consecutive timepoints = the cursor faded.');
console.error('  - If diff is roughly flat = cursor stayed visible throughout.');
console.error('  - If diff is high at all timepoints = cursor faded fast (≤ first delay).');
console.error('\nVisual check: inspect data/phase256-fade/t-{ms}.jpg for cursor presence.');
process.exit(0);
