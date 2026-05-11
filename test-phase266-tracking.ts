/**
 * Phase 266: verify shape detector tracks cursor across multiple
 * small emit-displacements when cursor is visible.
 *
 * Phase 265 found post-home cursor at (1150, 780) with shape
 * detector score 2.58 — works when cursor is in the frame.
 * This bench pre-positions cursor to mid-screen via LEFT-DOWN
 * emits, then runs 10 trials of small displacements. For each:
 *   - Emit displacement
 *   - Capture frame, run shape detector with locality hint
 *   - Verify detected position ≈ previous detected + (emit × pxRatio)
 *
 * Acceptance: ≥8/10 trials track within 30 px of expected
 * position. If yes → ready for production integration.
 *
 * Pre-position recipe (informed by Phase 265):
 *   - Cursor starts at (~1150, 780) after forceHomeViaSwipe
 *   - Emit (-310, -180) chunked → land cursor at ~(840, 600)
 *   - Visual check: F0 must show cursor at ~(840, 600)
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase266-tracking/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 266 displacement-tracking bench at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

console.error('Step 1: take F0 via screenshotKeepingCursorAlive + locality hint');
// Phase 265 found post-home cursor lands at (1150, 780).
// screenshotKeepingCursorAlive does a ±1px wake nudge before
// capturing — empirically refreshes the dimmed cursor that
// settled out during the 1500ms post-home wait.
//
// Phase 266 fix: use the known post-home position as a locality
// HINT for F0 detection. Without a hint, the clock widget's
// hour hand at (~628, 151) scores higher than the cursor at
// (~1150, 780), and the bench anchors to the wrong feature.
const POST_HOME_HINT = { x: 1100, y: 780 };
const POST_HOME_HINT_RADIUS = 150;

const f0Shot = await client.screenshotKeepingCursorAlive();
await fs.writeFile(`${ROOT}/F0-pre-trials.jpg`, f0Shot.buffer);
const f0 = await sharp(f0Shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const f0Find = findCursorByShape(f0.data, f0.info.width, f0.info.height, {
  expectedNear: POST_HOME_HINT,
  expectedNearRadius: POST_HOME_HINT_RADIUS,
});

// Phase 266 finding: a hinted cursor can score as low as 0.10 when
// the cursor renders dim (few dark-threshold pixels) — the position
// is still correct. Below 0.05 = no real candidate; above = trust
// the position with the locality hint.
if (!f0Find || f0Find.shapeScore < 0.05) {
  console.error(`PRE-POSITION FAILED: shape detector found ${
    f0Find ? `(${Math.round(f0Find.centroidX)}, ${Math.round(f0Find.centroidY)}) score ${f0Find.shapeScore.toFixed(2)}` : 'nothing'
  }. Cursor probably not visible. Aborting bench.`);
  process.exit(1);
}
console.error(`  Cursor found at (${Math.round(f0Find.centroidX)}, ${Math.round(f0Find.centroidY)}) score ${f0Find.shapeScore.toFixed(2)}`);

let prevPos = { x: Math.round(f0Find.centroidX), y: Math.round(f0Find.centroidY) };

// Phase 192 cursor-belief uses ~1.3 px/mickey as default iPad ratio.
// We'll use that for predicting where the cursor should be after
// each emit. Real ratio varies; tolerance of 30 px covers it.
const PX_PER_MICKEY = 1.3;

// 10 trial emits. Mix of directions to keep cursor in mid-screen.
const TRIALS = [
  { dx:  50, dy:   0 },
  { dx:   0, dy:  50 },
  { dx: -50, dy:   0 },
  { dx:   0, dy: -50 },
  { dx:  40, dy:  40 },
  { dx: -40, dy: -40 },
  { dx:  60, dy: -30 },
  { dx: -60, dy:  30 },
  { dx:  30, dy:  60 },
  { dx: -30, dy: -60 },
];

interface TrialResult {
  i: number;
  emit: { dx: number; dy: number };
  expected: { x: number; y: number };
  detected: { x: number; y: number } | null;
  shapeScore: number;
  error: number | null;
  withinTolerance: boolean;
}

const results: TrialResult[] = [];

for (let i = 0; i < TRIALS.length; i++) {
  const t = TRIALS[i];
  const expected = {
    x: prevPos.x + Math.round(t.dx * PX_PER_MICKEY),
    y: prevPos.y + Math.round(t.dy * PX_PER_MICKEY),
  };

  console.error(`\n--- Trial ${i + 1}/${TRIALS.length}: emit (${t.dx},${t.dy}); ` +
    `expected ≈ (${expected.x}, ${expected.y}) ---`);

  await client.mouseMoveRelative(t.dx, t.dy);
  await sleep(400);

  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(`${ROOT}/t${(i + 1).toString().padStart(2, '0')}-post.jpg`, shot.buffer);
  const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const find = findCursorByShape(dec.data, dec.info.width, dec.info.height, {
    expectedNear: expected,
    expectedNearRadius: 100,
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
  results.push({
    i: i + 1,
    emit: t,
    expected,
    detected,
    shapeScore: score,
    error,
    withinTolerance: within,
  });

  console.error(`  detected ${detected ? `(${detected.x}, ${detected.y}) score ${score.toFixed(2)}` : 'NULL'} ` +
    `error=${error !== null ? error.toFixed(0) + ' px' : 'n/a'} ${within ? '✓' : '✗'}`);

  // Update prevPos for next trial — use DETECTED if available
  // (better tracking than relying on px/mickey prediction).
  if (detected) {
    prevPos = detected;
  } else {
    prevPos = expected;
  }
}

console.error('\n\n=== RESULT SUMMARY ===');
console.error('trial | emit         | expected         | detected         | error  | shape   | within 30');
console.error('------+--------------+------------------+------------------+--------+---------+----------');
for (const r of results) {
  console.error(
    `  ${r.i.toString().padStart(2)}  | ` +
    `(${r.emit.dx.toString().padStart(3)}, ${r.emit.dy.toString().padStart(3)}) | ` +
    `(${r.expected.x.toString().padStart(4)}, ${r.expected.y.toString().padStart(4)})   | ` +
    `${r.detected ? `(${r.detected.x.toString().padStart(4)}, ${r.detected.y.toString().padStart(4)})  ` : '(null)         '} | ` +
    `${r.error !== null ? r.error.toFixed(0).padStart(5) + ' px' : ' n/a   '} | ` +
    `${r.shapeScore.toFixed(2).padStart(6)} | ` +
    `${r.withinTolerance ? 'YES' : 'no'}`,
  );
}

const passed = results.filter(r => r.withinTolerance).length;
const valid = results.filter(r => r.error !== null).length;

console.error(`\nPassed: ${passed}/${TRIALS.length} (valid: ${valid}/${TRIALS.length})`);
console.error(`If ≥ 8/10 within 30 px → cursor-shape-detect is ready for production integration.`);

if (passed >= 8) {
  console.error(`\n=== VERDICT: PASS ===`);
  console.error(`cursor-shape-detect tracks cursor displacements reliably.`);
  console.error(`Next: wire findCursorByShape into moveToPixel's correction-pass`);
  console.error(`as a fallback when NCC returns null.`);
} else if (passed >= 5) {
  console.error(`\n=== VERDICT: PARTIAL ===`);
  console.error(`${passed}/10 — promising but inconsistent. Run bench again, then`);
  console.error(`diagnose the ${10 - passed} failures.`);
} else {
  console.error(`\n=== VERDICT: FAIL ===`);
  console.error(`Only ${passed}/10 trials tracked correctly. Inspect screenshots`);
  console.error(`for failed trials — is cursor visible? Is detector picking icons?`);
}
process.exit(0);
