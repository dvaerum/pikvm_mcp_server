/**
 * Phase 283: re-seed cursor templates against current iPad state.
 *
 * Phase 281 found NCC returns null on every iPad home-screen frame
 * because cached templates (300-750 bytes each, old cursor style)
 * don't correlate with the current arrow cursor. Best NCC score
 * unhinted: 0.78; production threshold: 0.83.
 *
 * This script:
 *   1. Backs up the current template directory (so we can roll back)
 *   2. Unlocks + homes the iPad
 *   3. Runs seedCursorTemplate to capture a fresh template against
 *      the current iPad state
 *   4. Reports the seeded position and template stats
 *   5. Verifies the new template scores ≥0.85 on Phase 280 frame
 *      f023 (cursor known to be at ~(733, 770))
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { seedCursorTemplate } from './src/pikvm/seed-template.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import { findCursorByTemplateSet, decodeScreenshot } from './src/pikvm/cursor-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 283 re-seed cursor templates at v${VERSION} ===\n`);

// Step 1a: Back up existing templates
const BACKUP_DIR = `./data/cursor-templates.backup-pre-phase283`;
console.error(`Step 1a: Backing up existing templates to ${BACKUP_DIR}`);
try {
  await fs.cp(DEFAULT_TEMPLATE_DIR, BACKUP_DIR, { recursive: true, force: true });
  const backupFiles = await fs.readdir(BACKUP_DIR);
  console.error(`  Backed up ${backupFiles.length} files`);
} catch (e) {
  console.error(`  Backup failed: ${(e as Error).message}`);
}

// Step 1b: Clear the template directory so the perceptual-dedup check
// doesn't reject the fresh seed as "similar to an existing template".
// The old templates are still in BACKUP_DIR for rollback if needed.
console.error(`Step 1b: Clearing ${DEFAULT_TEMPLATE_DIR} so dedup doesn't reject new seed`);
try {
  const existing = await fs.readdir(DEFAULT_TEMPLATE_DIR);
  for (const f of existing) {
    if (f.endsWith('.jpg') || f.endsWith('.jpeg')) {
      await fs.unlink(`${DEFAULT_TEMPLATE_DIR}/${f}`);
    }
  }
  console.error(`  Cleared ${existing.length} old template files\n`);
} catch (e) {
  console.error(`  Clear failed: ${(e as Error).message}\n`);
}

// Step 2: Unlock and home the iPad
console.error(`Step 2: Unlock + home iPad`);
await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);
console.error(`  done\n`);

// Step 3: Seed fresh template
// After ipadGoHome the cursor lands at far-right (~1180, 805). Need a
// large enough emit LEFT to definitively displace the cursor and create
// a clean motion-diff cluster. Larger settleMs lets iPadOS re-render.
// Pre-position cursor leftward with a manual emit first so the seed
// emit doesn't have to fight the edge clamp.
// Avoid the status-bar area (clock seconds tick) by pre-positioning
// the cursor toward mid-screen, then emit a vertical wake. Vertical
// motion produces a vertical diff smear that motion-diff handles
// cleanly and the status-bar area stays unchanged.
console.error(`Step 3a: pre-position cursor toward mid-screen (-300 X, +200 Y)`);
await client.mouseMoveRelative(-300, 200);
await sleep(600);
console.error(`Step 3b: seedCursorTemplate (emit +0, +120 mickeys = move DOWN, 700ms settle)`);
const seedResult = await seedCursorTemplate(client, {
  emitDx: 0,
  emitDy: 120,
  settleMs: 700,
  dir: DEFAULT_TEMPLATE_DIR,
});
console.error(`  ok: ${seedResult.ok}`);
console.error(`  cursorPosition: ${seedResult.cursorPosition ? `(${seedResult.cursorPosition.x},${seedResult.cursorPosition.y})` : 'null'}`);
console.error(`  templatePersisted: ${seedResult.templatePersisted}`);
console.error(`  reason: ${seedResult.reason}\n`);

if (!seedResult.ok || !seedResult.templatePersisted) {
  console.error('Seeding FAILED — see reason above. Templates NOT updated.');
  process.exit(1);
}

// Step 4: Verify fresh template against Phase 280 f023
console.error(`Step 4: Verify new templates against Phase 280 f023 (cursor known at ~(733, 770))`);
const f023Path = './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg';
const f023Buf = await fs.readFile(f023Path);
const f023Decoded = await decodeScreenshot(f023Buf);

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, undefined, null);
console.error(`  Loaded ${templates.length} templates (after re-seed)`);

const unhinted = findCursorByTemplateSet(f023Decoded, templates, { minScore: 0 });
console.error(`  Unhinted NCC (best anywhere, minScore=0):`);
console.error(`    ${unhinted ? `(${unhinted.position.x},${unhinted.position.y}) score=${unhinted.score.toFixed(3)} tplIdx=${unhinted.templateIndex}` : 'null'}`);

const prod = findCursorByTemplateSet(f023Decoded, templates, {});
console.error(`  Production-default NCC (minScore=0.83):`);
console.error(`    ${prod ? `(${prod.position.x},${prod.position.y}) score=${prod.score.toFixed(3)} tplIdx=${prod.templateIndex}` : 'null (sub-threshold)'}`);

const hinted = findCursorByTemplateSet(f023Decoded, templates, {
  expectedNear: { x: 733, y: 770 },
  expectedNearRadius: 100,
  minScore: 0,
});
console.error(`  Hinted NCC at (733,770) ±100:`);
if (hinted) {
  const dist = Math.hypot(hinted.position.x - 733, hinted.position.y - 770);
  console.error(`    (${hinted.position.x},${hinted.position.y}) score=${hinted.score.toFixed(3)} tplIdx=${hinted.templateIndex} dist=${dist.toFixed(0)}px`);
} else {
  console.error(`    null`);
}

console.error(`\n=== VERDICT ===`);
if (prod && Math.hypot(prod.position.x - 733, prod.position.y - 770) <= 35) {
  console.error('SUCCESS — NCC scores the real cursor ≥0.83 and lands within 35 px of ground truth.');
  console.error('Templates re-seeded successfully. Production click rate should lift dramatically.');
} else if (unhinted && unhinted.score >= 0.85) {
  console.error('PARTIAL — NCC scores well unhinted but production-threshold returned null.');
  console.error('Check the unhinted position vs ground truth.');
} else {
  console.error('NO LIFT — NCC still scores sub-threshold. Re-seed may have captured wrong cluster.');
  console.error('Consider rolling back from backup at ' + BACKUP_DIR);
}

process.exit(0);
