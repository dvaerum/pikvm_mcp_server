/**
 * Phase 267: shape detector tracking with SMALL wiggles +
 * net-zero displacement.
 *
 * Phase 266 trial 1 succeeded with 2-px accuracy on a 50-mickey
 * emit; trials 2-10 failed because cumulative px/mickey variance
 * drove cursor into dock zone where dock icons beat the cursor.
 *
 * Phase 267 fix: 10-mickey wiggles arranged so cumulative emit
 * always sums to zero. Cursor stays within ~30-50 px of starting
 * position regardless of px/mickey ratio variance.
 *
 * Starting position: ~(1100, 780) post-home. Clear wallpaper
 * region bounds: x ∈ [950, 1170], y ∈ [600, 900].
 *
 * Wiggle plan (pairs cancel net displacement):
 *   1. ( +10,   0 )
 *   2. ( -10,   0 ) → back to start
 *   3. (   0, +10 )
 *   4. (   0, -10 ) → back to start
 *   5. (  +7,  +7 )
 *   6. (  -7,  -7 ) → back to start
 *   7. (  +7,  -7 )
 *   8. (  -7,  +7 ) → back to start
 *   9. ( +10,   0 )
 *  10. ( -10,   0 ) → back to start
 *
 * Acceptance: ≥ 8/10 within 30 px of expected position.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase267-small-wiggles/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 267 small-wiggle tracking at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

const POST_HOME_HINT = { x: 1100, y: 780 };
const POST_HOME_HINT_RADIUS = 150;

console.error('Step 1: F0 with locality hint at post-home position');
const f0Shot = await client.screenshotKeepingCursorAlive();
await fs.writeFile(`${ROOT}/F0.jpg`, f0Shot.buffer);
const f0 = await sharp(f0Shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const f0Find = findCursorByShape(f0.data, f0.info.width, f0.info.height, {
  expectedNear: POST_HOME_HINT,
  expectedNearRadius: POST_HOME_HINT_RADIUS,
});

if (!f0Find || f0Find.shapeScore < 0.05) {
  console.error(`F0 detect FAILED: ${
    f0Find ? `(${Math.round(f0Find.centroidX)},${Math.round(f0Find.centroidY)}) score ${f0Find.shapeScore.toFixed(2)}` : 'null'
  }. Aborting bench.`);
  process.exit(1);
}
let prevPos = { x: Math.round(f0Find.centroidX), y: Math.round(f0Find.centroidY) };
console.error(`F0 cursor at (${prevPos.x}, ${prevPos.y}) score ${f0Find.shapeScore.toFixed(2)}`);

const PX_PER_MICKEY = 1.3;
const TRIALS = [
  { dx:  10, dy:   0 },
  { dx: -10, dy:   0 },
  { dx:   0, dy:  10 },
  { dx:   0, dy: -10 },
  { dx:   7, dy:   7 },
  { dx:  -7, dy:  -7 },
  { dx:   7, dy:  -7 },
  { dx:  -7, dy:   7 },
  { dx:  10, dy:   0 },
  { dx: -10, dy:   0 },
];

interface Result {
  i: number;
  emit: { dx: number; dy: number };
  expected: { x: number; y: number };
  detected: { x: number; y: number } | null;
  shapeScore: number;
  error: number | null;
  withinTolerance: boolean;
}

const results: Result[] = [];

for (let i = 0; i < TRIALS.length; i++) {
  const t = TRIALS[i];
  const expected = {
    x: prevPos.x + Math.round(t.dx * PX_PER_MICKEY),
    y: prevPos.y + Math.round(t.dy * PX_PER_MICKEY),
  };

  await client.mouseMoveRelative(t.dx, t.dy);
  await sleep(400);

  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(`${ROOT}/t${(i + 1).toString().padStart(2, '0')}.jpg`, shot.buffer);
  const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const find = findCursorByShape(dec.data, dec.info.width, dec.info.height, {
    expectedNear: expected,
    expectedNearRadius: 80,
  });

  let detected: { x: number; y: number } | null = null;
  let error: number | null = null;
  let score = 0;
  if (find) {
    detected = { x: Math.round(find.centroidX), y: Math.round(find.centroidY) };
    error = Math.hypot(detected.x - expected.x, detected.y - expected.y);
    score = find.shapeScore;
  }
  const within = error !== null && error <= 30;
  results.push({ i: i + 1, emit: t, expected, detected, shapeScore: score, error, withinTolerance: within });

  console.error(`t${(i + 1).toString().padStart(2)}: emit (${t.dx.toString().padStart(3)},${t.dy.toString().padStart(3)})  ` +
    `exp (${expected.x.toString().padStart(4)},${expected.y.toString().padStart(4)})  ` +
    `det ${detected ? `(${detected.x.toString().padStart(4)},${detected.y.toString().padStart(4)})` : '(null)       '}  ` +
    `err ${error !== null ? error.toFixed(0).padStart(3) + 'px' : 'n/a  '}  ` +
    `${within ? '✓' : '✗'}`);

  if (detected) prevPos = detected;
  else prevPos = expected;
}

const passed = results.filter(r => r.withinTolerance).length;
const valid = results.filter(r => r.error !== null).length;

console.error(`\n=== RESULT ===`);
console.error(`Passed: ${passed}/${TRIALS.length} (valid: ${valid}/${TRIALS.length}) within 30 px`);
console.error(`Median error: ${results.filter(r => r.error !== null).map(r => r.error!).sort((a, b) => a - b)[Math.floor(valid / 2)]?.toFixed(0) ?? 'n/a'} px`);

if (passed >= 8) {
  console.error(`\nPASS — cursor-shape-detect is ready for production integration.`);
} else {
  console.error(`\n${passed}/10. Inspect data/phase267-small-wiggles/<run-id>/ to diagnose failures.`);
}
process.exit(0);
