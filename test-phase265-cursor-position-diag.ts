/**
 * Phase 265: diagnose where the cursor is after the standard
 * unlock + home sequence. Visual inspection is the source of truth.
 *
 * Phase 264 bench failed because the cursor wasn't visible in
 * pre-frames. Before I can validate cursor-shape-detect on diverse
 * positions, I need a reliable way to LAND the cursor at a known
 * mid-screen position. That requires knowing where it starts.
 *
 * This script takes 5 screenshots:
 *   F1: immediately after unlockIpad
 *   F2: immediately after ipadGoHome (forceHomeViaSwipe: true)
 *   F3: after 1.5s settle
 *   F4: after a tiny (10, 10) wake emit (to render the cursor if
 *       it was hidden by no-motion fade — though Phase 256 showed
 *       fade is 10+ sec, so this should change little)
 *   F5: after a larger (100, 100) emit
 *
 * Then visual inspection (manual): find the cursor in each frame,
 * note its position. Document the post-unlock cursor location so
 * the bench harness can pre-position reliably.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import sharp from 'sharp';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase265-cursor-position/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 265 cursor position diag at v${VERSION} ===\n`);

async function snapAndAnalyse(label: string, filename: string): Promise<void> {
  const shot = await client.screenshot();
  await fs.writeFile(`${ROOT}/${filename}`, shot.buffer);
  const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // Unhinted shape detect — what's the highest-scoring candidate anywhere on frame?
  const r = findCursorByShape(dec.data, dec.info.width, dec.info.height);
  if (r) {
    console.error(`  ${label}: shape top-1 = (${Math.round(r.centroidX)}, ${Math.round(r.centroidY)}) score=${r.shapeScore.toFixed(2)} pix=${r.pixels}`);
  } else {
    console.error(`  ${label}: shape top-1 = (no candidate)`);
  }
}

console.error('Step 1: unlock');
await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await snapAndAnalyse('F1 post-unlock', 'F1-post-unlock.jpg');

console.error('\nStep 2: home (forceHomeViaSwipe)');
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(200);
await snapAndAnalyse('F2 post-home (200ms settle)', 'F2-post-home.jpg');

console.error('\nStep 3: longer settle');
await sleep(1500);
await snapAndAnalyse('F3 after 1.5s settle', 'F3-after-settle.jpg');

console.error('\nStep 4: tiny wake (10, 10)');
await client.mouseMoveRelative(10, 10);
await sleep(400);
await snapAndAnalyse('F4 after tiny wake', 'F4-tiny-wake.jpg');

console.error('\nStep 5: larger emit (100, 100)');
await client.mouseMoveRelative(100, 100);
await sleep(400);
await snapAndAnalyse('F5 after (100,100)', 'F5-after-100-100.jpg');

console.error(`\nAll frames saved to ${ROOT}`);
console.error('NEXT STEP: visually inspect F1-F5 to find the cursor in each.');
console.error('Look for: small dark arrow shape (not an icon).');
process.exit(0);
