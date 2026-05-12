/**
 * Phase 288: re-seed templates using Phase 106 masked extraction.
 *
 * Why this differs from Phase 283b/287:
 * - Phase 283b extracted templates from saved Phase 280 frames using
 *   `extractCursorTemplateDecoded` — UNMASKED. Templates contain
 *   cursor pixels + surrounding wallpaper. NCC scores reflect
 *   wallpaper-context match, not cursor-pixel match.
 * - Phase 287 tried diverse positions but still used the unmasked
 *   path. Diverse + unmasked = NCC scores drop below threshold on
 *   any frame whose wallpaper differs from the seed frame.
 * - Phase 288 uses `seedCursorTemplate` which internally calls
 *   `extractMaskedTemplate` (Phase 106). The mask is the motion-diff
 *   between before/after frames — pixels that didn't change get
 *   zeroed out in the template, leaving cursor-only pixels.
 *
 * Result: templates with cursor pixels + zeros background. NCC
 * scores reflect cursor-pixel match (good wherever cursor is) rather
 * than wallpaper-context match (good only over same wallpaper).
 *
 * Steps:
 * 1. Backup current templates
 * 2. Clear template dir
 * 3. Unlock + home
 * 4. For each of 5 seed positions:
 *    a. Drive cursor toward target via raw emits
 *    b. Call seedCursorTemplate (which does before/after + diff + mask)
 *    c. Log result
 * 5. Verify NCC score against Phase 280 f023 (cursor at 733,770)
 * 6. Output summary; live bench is a separate step
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { seedCursorTemplate } from './src/pikvm/seed-template.js';
import { decodeScreenshot, findCursorByTemplateSet } from './src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 288 masked-template re-seed at v${VERSION} ===\n`);

const BACKUP_DIR = './data/cursor-templates.backup-pre-phase288';
console.error(`Step 1: Backup current templates → ${BACKUP_DIR}`);
try {
  await fs.cp(DEFAULT_TEMPLATE_DIR, BACKUP_DIR, { recursive: true, force: true });
  const files = await fs.readdir(BACKUP_DIR);
  console.error(`  Backed up ${files.length} files`);
} catch (e) {
  console.error(`  Backup failed: ${(e as Error).message}`);
}

console.error(`Step 2: Clear ${DEFAULT_TEMPLATE_DIR}`);
await fs.mkdir(DEFAULT_TEMPLATE_DIR, { recursive: true });
const existing = await fs.readdir(DEFAULT_TEMPLATE_DIR);
let cleared = 0;
for (const f of existing) {
  if (f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg')) {
    await fs.unlink(path.join(DEFAULT_TEMPLATE_DIR, f));
    cleared++;
  }
}
console.error(`  Cleared ${cleared} files\n`);

console.error(`Step 3: Unlock + home`);
await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);
console.error(`  Done\n`);

// Each step is a relative position drift + seedCursorTemplate call.
// seedCursorTemplate emits a small wake (default +100,0) then captures
// before/after; we drive the cursor BETWEEN seed calls with raw emits.
// Drift sequence keeps the cursor across diverse wallpaper backgrounds:
//   After home: ~(1180, 805) far-right
//   Step 1: drift -200, -200 → ~(900, 525) right-of-Settings wallpaper
//   Step 2: drift -200, +50 → ~(620, 595) mid-screen wallpaper (above icons)
//   Step 3: drift +300, +200 → ~(1040, 875) right-of-Settings near dock
//   Step 4: drift -400, -200 → ~(480, 595) left-of-center wallpaper
//   Step 5: drift +200, +200 → ~(760, 875) mid-bottom near dock
interface SeedStep {
  name: string;
  driftDx: number;
  driftDy: number;
}
const STEPS: SeedStep[] = [
  { name: 'right-of-settings wallpaper', driftDx: -200, driftDy: -200 },
  { name: 'mid-screen above icons', driftDx: -200, driftDy: 50 },
  { name: 'near-dock right side', driftDx: 300, driftDy: 200 },
  { name: 'left-of-center wallpaper', driftDx: -400, driftDy: -200 },
  { name: 'mid-bottom above dock', driftDx: 200, driftDy: 200 },
];

let seeded = 0;
for (let i = 0; i < STEPS.length; i++) {
  const step = STEPS[i];
  console.error(`Step 4.${i + 1}: drift to '${step.name}' (${step.driftDx}, ${step.driftDy})`);
  // Drift cursor to the target area
  await client.mouseMoveRelative(step.driftDx, step.driftDy);
  await sleep(600);

  // Now call seedCursorTemplate. Its internal wake emit moves the
  // cursor by another (emitDx,emitDy)=default(100,0); the before
  // screenshot is taken before that wake, and the after after.
  const result = await seedCursorTemplate(client, {
    emitDx: 60,
    emitDy: 20,
    settleMs: 500,
    dir: DEFAULT_TEMPLATE_DIR,
  });
  console.error(`  ok=${result.ok}  templatePersisted=${result.templatePersisted}`);
  console.error(`  cursorPosition=${result.cursorPosition ? `(${result.cursorPosition.x},${result.cursorPosition.y})` : 'null'}`);
  console.error(`  reason: ${result.reason}\n`);
  if (result.templatePersisted) seeded++;
}

console.error(`Seeded ${seeded} masked templates\n`);

if (seeded === 0) {
  console.error(`WARNING: zero templates seeded. Restoring backup.`);
  await fs.cp(BACKUP_DIR, DEFAULT_TEMPLATE_DIR, { recursive: true, force: true });
  process.exit(1);
}

// Step 5: verify on Phase 280 f023
console.error(`Step 5: verify NCC on Phase 280 f023 (cursor at ~733,770)`);
const f023Path = './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg';
const f023Buf = await fs.readFile(f023Path);
const f023Dec = await decodeScreenshot(f023Buf);
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, undefined, null);
console.error(`  Loaded ${templates.length} masked templates`);

const unhinted = findCursorByTemplateSet(f023Dec, templates, { minScore: 0 });
console.error(`  Unhinted NCC (minScore=0): ${unhinted ? `(${unhinted.position.x},${unhinted.position.y}) score=${unhinted.score.toFixed(3)}` : 'null'}`);

const prod = findCursorByTemplateSet(f023Dec, templates, {});
console.error(`  Production NCC (minScore=0.83): ${prod ? `(${prod.position.x},${prod.position.y}) score=${prod.score.toFixed(3)}` : 'null (sub-threshold)'}`);

const hinted = findCursorByTemplateSet(f023Dec, templates, {
  expectedNear: { x: 733, y: 770 }, expectedNearRadius: 100, minScore: 0,
});
console.error(`  Hinted NCC at (733,770)±100: ${hinted ? `(${hinted.position.x},${hinted.position.y}) score=${hinted.score.toFixed(3)} dist=${Math.hypot(hinted.position.x - 733, hinted.position.y - 770).toFixed(0)}px` : 'null'}`);

console.error(`\nNew templates in ${DEFAULT_TEMPLATE_DIR}. Run test-phase262-current-click-rate to live-bench.`);
process.exit(0);
