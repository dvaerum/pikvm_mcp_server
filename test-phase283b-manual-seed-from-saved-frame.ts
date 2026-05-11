/**
 * Phase 283b: manually seed cursor template from a saved frame where
 * shape-detect already identified the cursor with high confidence.
 *
 * The live seedCursorTemplate path failed because motion-diff couldn't
 * find a cursor cluster (cursor faded / status-bar clock changes
 * dominated the diff). But Phase 280's f023 already has the cursor
 * visibly at ~(733, 770) with shape-detect score 2.919 — we can
 * extract a template directly from that frame.
 */
import { promises as fs } from 'fs';
import {
  decodeScreenshot,
  extractCursorTemplateDecoded,
  findCursorByTemplateSet,
  saveCursorTemplate,
} from './src/pikvm/cursor-detect.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import sharp from 'sharp';
import path from 'path';
import { VERSION } from './src/version.js';

console.error(`=== Phase 283b manual-seed from saved frame at v${VERSION} ===\n`);

// Seed source: Phase 280 f023 where shape-detect found cursor at (733, 777) score 2.919
const SEED_FRAMES = [
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg', expectedAt: { x: 733, y: 777 } },
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-04-06/f007.jpg', expectedAt: { x: 963, y: 777 } },
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-04-06/f008.jpg', expectedAt: { x: 948, y: 777 } },
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f017.jpg', expectedAt: { x: 819, y: 777 } },
];

// Step 1: clear existing templates (already cleared in phase283a, but be safe)
console.error(`Step 1: ensure ${DEFAULT_TEMPLATE_DIR} is empty`);
await fs.mkdir(DEFAULT_TEMPLATE_DIR, { recursive: true });
const existing = await fs.readdir(DEFAULT_TEMPLATE_DIR);
let cleared = 0;
for (const f of existing) {
  if (f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg')) {
    await fs.unlink(path.join(DEFAULT_TEMPLATE_DIR, f));
    cleared++;
  }
}
console.error(`  Cleared ${cleared} existing templates\n`);

// Step 2: extract a template from each seed frame
let extracted = 0;
for (const seed of SEED_FRAMES) {
  const buf = await fs.readFile(seed.path).catch(() => null);
  if (!buf) {
    console.error(`  SKIP ${seed.path} (not found)`);
    continue;
  }
  const decoded = await decodeScreenshot(buf);

  // Verify cursor is actually there using shape-detect
  const rgbObj = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const shape = findCursorByShape(rgbObj.data, rgbObj.info.width, rgbObj.info.height);
  if (!shape) {
    console.error(`  SKIP ${seed.path} — shape-detect found no candidate`);
    continue;
  }
  const distFromExpected = Math.hypot(shape.centroidX - seed.expectedAt.x, shape.centroidY - seed.expectedAt.y);
  console.error(`  ${seed.path.split('/').pop()}: shape-detect=(${Math.round(shape.centroidX)},${Math.round(shape.centroidY)}) score=${shape.shapeScore.toFixed(3)} dist-from-expected=${distFromExpected.toFixed(0)}`);

  if (distFromExpected > 50) {
    console.error(`    -> dist > 50 px; using expected position instead`);
  }
  const centre = distFromExpected <= 50
    ? { x: Math.round(shape.centroidX), y: Math.round(shape.centroidY) }
    : seed.expectedAt;

  // Extract a 24x24 template centred on the cursor
  const tpl = extractCursorTemplateDecoded(decoded, centre, 24);
  const stamp = String(Date.now() + extracted).slice(-10);
  const outPath = path.join(DEFAULT_TEMPLATE_DIR, `${stamp}.jpg`);
  await saveCursorTemplate(tpl, outPath);
  console.error(`    -> saved ${outPath}`);
  extracted++;
}
console.error(`\n  Extracted ${extracted} templates\n`);

if (extracted === 0) {
  console.error('FATAL: no templates extracted');
  process.exit(1);
}

// Step 3: verify
console.error(`Step 3: verify NCC against Phase 280 f023 with new templates`);
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, undefined, null);
console.error(`  Loaded ${templates.length} templates after seeding`);

const f023Buf = await fs.readFile('./data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg');
const f023Dec = await decodeScreenshot(f023Buf);

const unhinted = findCursorByTemplateSet(f023Dec, templates, { minScore: 0 });
console.error(`  Unhinted NCC (minScore=0):`);
console.error(`    ${unhinted ? `(${unhinted.position.x},${unhinted.position.y}) score=${unhinted.score.toFixed(3)} tplIdx=${unhinted.templateIndex}` : 'null'}`);

const prod = findCursorByTemplateSet(f023Dec, templates, {});
console.error(`  Production-default NCC (minScore=0.83):`);
console.error(`    ${prod ? `(${prod.position.x},${prod.position.y}) score=${prod.score.toFixed(3)} tplIdx=${prod.templateIndex}` : 'null'}`);

const hinted = findCursorByTemplateSet(f023Dec, templates, {
  expectedNear: { x: 733, y: 770 },
  expectedNearRadius: 100,
  minScore: 0,
});
console.error(`  Hinted NCC at (733,770) ±100:`);
if (hinted) {
  const dist = Math.hypot(hinted.position.x - 733, hinted.position.y - 770);
  console.error(`    (${hinted.position.x},${hinted.position.y}) score=${hinted.score.toFixed(3)} dist=${dist.toFixed(0)}px`);
} else {
  console.error(`    null`);
}

console.error(`\n=== VERDICT ===`);
if (prod && Math.hypot(prod.position.x - 733, prod.position.y - 770) <= 35) {
  console.error('SUCCESS — NCC scores real cursor ≥0.83 and lands within 35 px of ground truth.');
} else if (unhinted && unhinted.score >= 0.85) {
  console.error('PARTIAL — NCC scores well unhinted but production gate returned null/wrong.');
} else {
  console.error('NO LIFT — new templates don\'t correlate well either.');
}

process.exit(0);
