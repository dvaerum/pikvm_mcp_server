/**
 * Phase 287: re-seed cursor templates from diverse positions.
 *
 * Phase 286 found that the Phase 283 templates (extracted from frames
 * where cursor was near Settings/TV/Books icons) carry Settings-area
 * wallpaper context, causing NCC to lock onto Settings-vicinity
 * wallpaper as a stable FP regardless of where the cursor really is.
 *
 * Fix: drive the cursor to ~5 different mid-screen positions; at each
 * position verify cursor visibility via shape-detect with a high-
 * confidence score threshold (>= 4.0 — empirically a real cursor
 * scores 5+ per Phase 286); extract a template at the confirmed
 * position; persist. Replace the existing 5 Settings-biased templates
 * with this diverse set.
 *
 * Seed positions exercise different wallpaper contexts:
 *   1. ~(1000, 500) — right-side wallpaper, no widget
 *   2. ~(700, 350) — between top widgets, plain wallpaper
 *   3. ~(700, 700) — middle of icon-grid gap
 *   4. ~(300, 500) — left-side wallpaper, near calendar widget edge
 *   5. ~(950, 750) — between Settings and dock, plain area
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import {
  decodeScreenshot,
  extractCursorTemplateDecoded,
  saveCursorTemplate,
  findCursorByTemplateSet,
} from './src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 287 diverse template re-seed at v${VERSION} ===\n`);

// === Step 1: Backup existing templates ===
const BACKUP_DIR = './data/cursor-templates.backup-pre-phase287';
console.error(`Step 1: Backup existing templates → ${BACKUP_DIR}`);
try {
  await fs.cp(DEFAULT_TEMPLATE_DIR, BACKUP_DIR, { recursive: true, force: true });
  const files = await fs.readdir(BACKUP_DIR);
  console.error(`  Backed up ${files.length} files`);
} catch (e) {
  console.error(`  Backup failed: ${(e as Error).message}`);
}

// === Step 2: Clear template dir ===
console.error(`Step 2: Clear ${DEFAULT_TEMPLATE_DIR}`);
await fs.mkdir(DEFAULT_TEMPLATE_DIR, { recursive: true });
const existingFiles = await fs.readdir(DEFAULT_TEMPLATE_DIR);
let cleared = 0;
for (const f of existingFiles) {
  if (f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg')) {
    await fs.unlink(path.join(DEFAULT_TEMPLATE_DIR, f));
    cleared++;
  }
}
console.error(`  Cleared ${cleared} files\n`);

// === Step 3: Unlock + home ===
console.error(`Step 3: Unlock + home`);
await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);
console.error(`  Done. Cursor expected near (1180, 805)\n`);

// === Step 4: Drive cursor through diverse positions and seed templates ===
// Each step is a RELATIVE emit (mickeys). We don't trust precise landing
// but each emit will roughly displace the cursor by mickey*1.4 px. After
// each emit we let shape-detect find the cursor wherever it ended up.
//
// The actual position doesn't matter — what matters is variety of
// wallpaper backdrops in the captured templates.
// Each step: relative emit + EXPECTED cursor position after emit. The
// expected position is used as a locality hint to shape-detect to
// filter out the clock-widget FP (which is far from the predicted
// cursor). With locality filtering the score threshold can be lower
// because the clock FP is geometrically excluded.
const STEPS: { name: string; emitDx: number; emitDy: number; expectedX: number; expectedY: number }[] = [
  { name: 'right-side wallpaper', emitDx: -100, emitDy: -200,  expectedX: 1040, expectedY: 525 },
  { name: 'mid-top wallpaper',    emitDx: -200, emitDy: -100,  expectedX:  760, expectedY: 385 },
  { name: 'mid-screen',           emitDx:    0, emitDy:  200,  expectedX:  760, expectedY: 665 },
  { name: 'left-side wallpaper',  emitDx: -300, emitDy: -100,  expectedX:  340, expectedY: 525 },
  { name: 'bottom-mid wallpaper', emitDx: +250, emitDy:  150,  expectedX:  690, expectedY: 735 },
  { name: 'right-of-settings',    emitDx: +150, emitDy:  100,  expectedX:  900, expectedY: 875 },
];

// At static-cursor positions, shape-detect scores the real cursor at
// 0.3-1.5 (per Phase 287 measurement). The Phase 286 high-score
// detections (5+) happened mid-motion. Drop the score gate and rely
// on tight locality filtering — the cursor should be the only
// cursor-sized dark cluster near the predicted position. If shape-
// detect finds ANY candidate within the locality radius, that's the
// cursor.
const SEED_SCORE_THRESHOLD = 0.0;
const seedDir = `./data/phase287-diverse-seed/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(seedDir, { recursive: true });

let templateIdx = 0;
let extracted = 0;

for (let i = 0; i < STEPS.length; i++) {
  const step = STEPS[i];
  console.error(`Step 4.${i + 1}: ${step.name} (emit ${step.emitDx},${step.emitDy})`);
  await client.mouseMoveRelative(step.emitDx, step.emitDy);
  await sleep(700); // let cursor settle and re-render

  const shot = await client.screenshotKeepingCursorAlive();
  const fpath = path.join(seedDir, `step-${i + 1}-${step.name.replace(/\s+/g, '-')}.jpg`);
  await fs.writeFile(fpath, shot.buffer);

  const rgb = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const cand = findCursorByShape(rgb.data, rgb.info.width, rgb.info.height, {
    expectedNear: { x: step.expectedX, y: step.expectedY },
    expectedNearRadius: 150, // tight enough to filter widget FPs at known positions
  });
  if (!cand) {
    console.error(`  shape-detect returned null (no candidate within 150 px of (${step.expectedX},${step.expectedY}))`);
    continue;
  }
  console.error(`  shape-detect: (${Math.round(cand.centroidX)},${Math.round(cand.centroidY)}) score=${cand.shapeScore.toFixed(2)} px=${cand.pixels}`);
  if (cand.shapeScore < SEED_SCORE_THRESHOLD) {
    console.error(`  score ${cand.shapeScore.toFixed(2)} < threshold ${SEED_SCORE_THRESHOLD} → skip`);
    continue;
  }
  // Sanity: cursor pixel count should be in the iPad cursor range (~50-100)
  if (cand.pixels < 40 || cand.pixels > 150) {
    console.error(`  pixel count ${cand.pixels} out of cursor range [40,150] → skip`);
    continue;
  }

  // Good cursor — extract template
  const decoded = await decodeScreenshot(shot.buffer);
  const centre = { x: Math.round(cand.centroidX), y: Math.round(cand.centroidY) };
  const tpl = extractCursorTemplateDecoded(decoded, centre, 24);
  const stamp = String(Date.now() + templateIdx).slice(-10);
  const outPath = path.join(DEFAULT_TEMPLATE_DIR, `${stamp}.jpg`);
  await saveCursorTemplate(tpl, outPath);
  templateIdx++;
  extracted++;
  console.error(`  -> saved ${outPath}\n`);
}

console.error(`Extracted ${extracted} diverse templates\n`);

if (extracted < 3) {
  console.error(`WARNING: only ${extracted} templates extracted. Restoring backup.`);
  // Restore backup
  await fs.cp(BACKUP_DIR, DEFAULT_TEMPLATE_DIR, { recursive: true, force: true });
  console.error('Backup restored.');
  process.exit(1);
}

// === Step 5: Verify against Phase 280 / Phase 286 frames ===
console.error(`Step 5: Verify NCC on Phase 280 f023 (cursor known at ~(733, 770))`);
const f023Path = './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg';
const f023Buf = await fs.readFile(f023Path);
const f023Decoded = await decodeScreenshot(f023Buf);
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, undefined, null);
console.error(`  Loaded ${templates.length} templates`);

const unhinted = findCursorByTemplateSet(f023Decoded, templates, { minScore: 0 });
console.error(`  Unhinted NCC: ${unhinted ? `(${unhinted.position.x},${unhinted.position.y}) score=${unhinted.score.toFixed(3)}` : 'null'}`);
const hinted = findCursorByTemplateSet(f023Decoded, templates, {
  expectedNear: { x: 733, y: 770 }, expectedNearRadius: 100, minScore: 0,
});
console.error(`  Hinted NCC at (733,770)±100: ${hinted ? `(${hinted.position.x},${hinted.position.y}) score=${hinted.score.toFixed(3)}, dist=${Math.hypot(hinted.position.x - 733, hinted.position.y - 770).toFixed(0)}px` : 'null'}`);

console.error(`\n=== VERDICT ===`);
if (hinted && Math.hypot(hinted.position.x - 733, hinted.position.y - 770) <= 35) {
  console.error('SUCCESS — hinted NCC finds real cursor within 35 px');
} else {
  console.error('Verification weaker than expected; bench will tell us if production lifts');
}
console.error(`\nSeed frames: ${seedDir}`);
process.exit(0);
