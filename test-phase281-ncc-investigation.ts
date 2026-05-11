/**
 * Phase 281: investigate why NCC (template-match) fails on
 * far-target frames.
 *
 * cursor-shape-detect is the FALLBACK detector. NCC is the primary.
 * Phase 280 found that the shape-detect fallback returns widget FPs
 * (clock face at 1.5+ score). But why is NCC, the primary, also
 * failing? If NCC found the real cursor at >= 0.83 score, shape-
 * detect would never be called for these frames.
 *
 * For each saved frame from Phase 280, run NCC at production
 * settings:
 *   - Unhinted full-frame search (whole frame, minScore=0): what's
 *     the best match anywhere?
 *   - Production-default (minScore=0.83): does it return null or a
 *     match? If a match, where?
 *   - Cursor-hinted (expectedNear set to the known cursor position):
 *     does it find the cursor with a strong locality prior?
 *
 * Classify each frame:
 *   - "NCC works when given a hint" → fix is in the hint-providing
 *     pipeline upstream
 *   - "NCC sub-threshold even unhinted" → template is stale,
 *     re-seeding would help
 *   - "NCC scores a widget higher than the real cursor" → same FP
 *     problem as shape-detect; the fix is in the NCC scoring, not
 *     just shape-detect
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import { findCursorByTemplateSet, decodeScreenshot } from './src/pikvm/cursor-detect.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

console.error(`=== Phase 281 NCC investigation at v${VERSION} ===\n`);

// Load production cursor templates (no validate, no maxAge)
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, undefined, null);
console.error(`Loaded ${templates.length} templates from ${DEFAULT_TEMPLATE_DIR}\n`);
if (templates.length === 0) {
  console.error('No templates available — re-seed and retry.');
  process.exit(2);
}

// Test frames: a curated set from Phase 280's run 2026-05-11_19-05-45
// where we know what the actual cursor looked like.
// f023: shape-detect saw cursor at (733, 777) score 2.919 — REAL cursor
//       was visually confirmed at ~(733, 770) above TV icon
// f024: shape-detect saw cursor at (719, 777) score 0.326 — REAL cursor
//       likely still nearby, score dropped
// f025: shape-detect saw (618, 260) score 0.334 — clock-area
// f033: shape-detect saw (627, 149) score 1.63 — CLOCK FACE FP
const PHASE280_RUN = './data/phase280-cursor-vanishing/2026-05-11_19-05-45';
const TEST_CASES = [
  { frame: 'f023.jpg', actualCursorAt: { x: 733, y: 770 }, note: 'cursor visible above TV icon' },
  { frame: 'f024.jpg', actualCursorAt: { x: 720, y: 770 }, note: 'cursor still nearby (score dropped)' },
  { frame: 'f025.jpg', actualCursorAt: null, note: 'shape-detect picked clock-area, cursor uncertain' },
  { frame: 'f033.jpg', actualCursorAt: null, note: 'shape-detect picked CLOCK FACE (FP)' },
  { frame: 'f045.jpg', actualCursorAt: null, note: 'late still-period, clock-area pick' },
];

interface FrameResult {
  frame: string;
  note: string;
  actualCursorAt: { x: number; y: number } | null;
  // Unhinted, minScore=0 — what's the absolute best NCC match anywhere?
  unhinted: { x: number; y: number; score: number; templateIdx: number } | null;
  // Production-default (minScore=0.83, no hint) — what production calls return when hint goes stale
  productionDefault: { x: number; y: number; score: number; templateIdx: number } | null;
  // Hinted at actualCursorAt (when known): does NCC find the cursor there?
  hinted: { x: number; y: number; score: number; templateIdx: number } | null;
  // Shape-detect output for comparison
  shape: { x: number; y: number; score: number; pixels: number } | null;
}

const results: FrameResult[] = [];

for (const tc of TEST_CASES) {
  const path = `${PHASE280_RUN}/${tc.frame}`;
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch {
    console.error(`SKIP ${tc.frame}: file not found at ${path}`);
    continue;
  }

  const decoded = await decodeScreenshot(buf);
  const rgbObj = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // 1. Unhinted, minScore=0 (best NCC match anywhere on frame)
  const unhinted = findCursorByTemplateSet(decoded, templates, { minScore: 0 });

  // 2. Production-default settings (minScore=0.83, no hint)
  const prod = findCursorByTemplateSet(decoded, templates, {});

  // 3. Hinted (if we know where cursor is)
  let hinted: FrameResult['hinted'] = null;
  if (tc.actualCursorAt) {
    const h = findCursorByTemplateSet(decoded, templates, {
      expectedNear: tc.actualCursorAt,
      expectedNearRadius: 100,
      minScore: 0,
    });
    if (h) hinted = { x: h.position.x, y: h.position.y, score: h.score, templateIdx: h.templateIndex };
  }

  // 4. Shape-detect for comparison
  const shape = findCursorByShape(rgbObj.data, rgbObj.info.width, rgbObj.info.height);

  const r: FrameResult = {
    frame: tc.frame,
    note: tc.note,
    actualCursorAt: tc.actualCursorAt,
    unhinted: unhinted ? { x: unhinted.position.x, y: unhinted.position.y, score: unhinted.score, templateIdx: unhinted.templateIndex } : null,
    productionDefault: prod ? { x: prod.position.x, y: prod.position.y, score: prod.score, templateIdx: prod.templateIndex } : null,
    hinted,
    shape: shape ? { x: shape.centroidX, y: shape.centroidY, score: shape.shapeScore, pixels: shape.pixels } : null,
  };
  results.push(r);

  console.error(`--- ${tc.frame} — ${tc.note} ---`);
  if (tc.actualCursorAt) {
    console.error(`  Ground truth cursor: (${tc.actualCursorAt.x},${tc.actualCursorAt.y})`);
  } else {
    console.error(`  Ground truth: unclear (visual inspection needed)`);
  }
  console.error(`  Unhinted NCC (best anywhere, minScore=0):`);
  console.error(
    `    ${r.unhinted ? `(${r.unhinted.x},${r.unhinted.y}) score=${r.unhinted.score.toFixed(3)} tplIdx=${r.unhinted.templateIdx}` : 'null'}`,
  );
  console.error(`  Production-default NCC (minScore=0.83, no hint):`);
  console.error(
    `    ${r.productionDefault ? `(${r.productionDefault.x},${r.productionDefault.y}) score=${r.productionDefault.score.toFixed(3)} tplIdx=${r.productionDefault.templateIdx}` : 'null (sub-threshold)'}`,
  );
  if (r.hinted) {
    console.error(
      `  Hinted NCC at (${tc.actualCursorAt!.x},${tc.actualCursorAt!.y}) ±100:`,
    );
    console.error(
      `    (${r.hinted.x},${r.hinted.y}) score=${r.hinted.score.toFixed(3)} tplIdx=${r.hinted.templateIdx}`,
    );
    const distFromTruth = Math.hypot(r.hinted.x - tc.actualCursorAt!.x, r.hinted.y - tc.actualCursorAt!.y);
    console.error(`    distance from ground truth: ${distFromTruth.toFixed(0)} px`);
  }
  console.error(`  Shape-detect (for comparison):`);
  console.error(
    `    ${r.shape ? `(${Math.round(r.shape.x)},${Math.round(r.shape.y)}) score=${r.shape.score.toFixed(3)} px=${r.shape.pixels}` : 'null'}`,
  );
  console.error('');
}

await fs.writeFile(
  `${PHASE280_RUN}/ncc-investigation.json`,
  JSON.stringify(results, null, 2),
);

// Aggregate observations
console.error(`=== AGGREGATE ===\n`);
const ncc_unhinted_clock_picks = results.filter(r => r.unhinted && r.unhinted.y < 300 && r.unhinted.x > 400 && r.unhinted.x < 800).length;
const ncc_prod_returns_match = results.filter(r => r.productionDefault !== null).length;
const ncc_prod_returns_null = results.filter(r => r.productionDefault === null).length;
const ncc_hinted_succeeds = results.filter(r => r.hinted && r.actualCursorAt && Math.hypot(r.hinted.x - r.actualCursorAt.x, r.hinted.y - r.actualCursorAt.y) <= 35).length;
const ncc_hinted_tested = results.filter(r => r.actualCursorAt !== null).length;

console.error(`NCC unhinted picks in clock-widget area (y<300 and 400<x<800): ${ncc_unhinted_clock_picks}/${results.length}`);
console.error(`NCC at production default (minScore=0.83) returns match: ${ncc_prod_returns_match}/${results.length}`);
console.error(`NCC at production default returns null (sub-threshold):   ${ncc_prod_returns_null}/${results.length}`);
console.error(`NCC with cursor-locality hint finds real cursor (≤35 px): ${ncc_hinted_succeeds}/${ncc_hinted_tested}`);
console.error(`\nFull JSON: ${PHASE280_RUN}/ncc-investigation.json`);

process.exit(0);
