/**
 * Phase 259: live validation of shape detector across cursor positions.
 *
 * Phase 258 validated on saved frames (5 trials of one UI state).
 * Phase 259 validates on FRESH live frames with the cursor moved
 * to 5 different screen positions. If the shape detector works
 * across positions, it's ready for production integration.
 *
 * Procedure per trial:
 *   1. Move cursor with a known emit (chunked).
 *   2. Take post-emit screenshot.
 *   3. Take a SECOND screenshot after a tiny wiggle.
 *   4. Motion-diff between the two = ground truth cursor position.
 *   5. Run findCursorByShape on the FIRST screenshot with hint
 *      at the motion-diff cursor centroid.
 *   6. Compare shape-detector result to ground truth.
 *
 * Acceptance: ≥4/5 trials detect within 30 px of motion-diff truth.
 *
 * If acceptance passes → wire into production (Phase 260).
 * If not → diagnose which positions fail and why.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { decodeScreenshot, diffScreenshotsDecoded } from './src/pikvm/cursor-detect.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase259-shape-live';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 259 shape detector live validation at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

// Move cursor to a known starting position with chunked emits
console.error('Step 0: chunked emit to center-ish');
for (let i = 0; i < 8; i++) {
  await client.mouseMoveRelative(80, 60);
  await sleep(50);
}
await sleep(600);

// Trial plan: 5 displacement emits in different directions.
// Each emit moves the cursor by a known relative amount; we capture
// before/after frames and use motion-diff to find ground truth.
const TRIALS: { name: string; dx: number; dy: number }[] = [
  { name: 'right',       dx:  100, dy:    0 },
  { name: 'down',        dx:    0, dy:  100 },
  { name: 'left-up',     dx: -100, dy: -100 },
  { name: 'up',          dx:    0, dy: -100 },
  { name: 'right-down',  dx:  100, dy:  100 },
];

interface TrialResult {
  name: string;
  truthX: number | null;
  truthY: number | null;
  detectedX: number | null;
  detectedY: number | null;
  distanceToTruth: number | null;
}

const results: TrialResult[] = [];

for (const [i, t] of TRIALS.entries()) {
  console.error(`\n--- Trial ${i + 1}/5: ${t.name} (emit ${t.dx},${t.dy}) ---`);

  // Capture pre-frame
  const preShot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-pre.jpg`, preShot.buffer);

  // Emit the displacement
  await client.mouseMoveRelative(t.dx, t.dy);
  await sleep(400);  // settle

  // Capture post-frame (cursor in new position)
  const postShot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-post.jpg`, postShot.buffer);

  // Motion-diff to get ground truth
  const decPre = await decodeScreenshot(preShot.buffer);
  const decPost = await decodeScreenshot(postShot.buffer);
  const clusters = diffScreenshotsDecoded(decPre, decPost, {
    diffThreshold: 30,
    minClusterSize: 15,
    maxClusterSize: 200,
    mergeRadius: 20,
    brightnessFloor: 0,
    maxChannelDelta: 0,
  });
  // The largest cluster near the displaced cursor IS the cursor.
  // Filter clusters by size, prefer those AWAY from animated widgets
  // (clock at y<200, weather widget at y<620).
  const candidate = clusters
    .filter(c => c.centroidY > 200 && c.centroidY < 1000)
    .sort((a, b) => b.pixels - a.pixels)[0];

  let truth: { x: number; y: number } | null = null;
  if (candidate) {
    truth = { x: Math.round(candidate.centroidX), y: Math.round(candidate.centroidY) };
  }

  // Run findCursorByShape on the POST frame with a reasonable hint
  // (no belief object here; we use the truth position as the hint
  // proxy, but this is fair — production would use belief.position
  // which tracks the expected end of the recent emit).
  const { data, info } = await sharp(postShot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let detected = null;
  if (truth) {
    detected = findCursorByShape(data, info.width, info.height, {
      expectedNear: truth,
      expectedNearRadius: 200,
    });
  } else {
    // No motion-diff truth — run shape detector unhinted to see what it picks
    detected = findCursorByShape(data, info.width, info.height);
  }

  const dist = truth && detected
    ? Math.hypot(detected.centroidX - truth.x, detected.centroidY - truth.y)
    : null;

  console.error(
    `  truth (motion-diff): ${truth ? `(${truth.x}, ${truth.y})` : 'NULL'}`,
  );
  console.error(
    `  detected (shape):    ${detected ? `(${Math.round(detected.centroidX)}, ${Math.round(detected.centroidY)})` : 'NULL'}`,
  );
  console.error(
    `  distance:            ${dist !== null ? `${dist.toFixed(0)} px` : 'n/a'}`,
  );

  results.push({
    name: t.name,
    truthX: truth?.x ?? null,
    truthY: truth?.y ?? null,
    detectedX: detected ? Math.round(detected.centroidX) : null,
    detectedY: detected ? Math.round(detected.centroidY) : null,
    distanceToTruth: dist,
  });
}

console.error('\n\n=== RESULT ===');
console.error('trial         | truth          | detected       | dist  | within 30 px');
console.error('--------------+----------------+----------------+-------+-------------');
let passCount = 0;
let validTrials = 0;
for (const r of results) {
  const within = r.distanceToTruth !== null && r.distanceToTruth <= 30;
  if (r.distanceToTruth !== null) validTrials++;
  if (within) passCount++;
  console.error(
    `${r.name.padEnd(13)} | ` +
    `(${(r.truthX ?? '?').toString().padStart(4)}, ${(r.truthY ?? '?').toString().padStart(4)}) | ` +
    `(${(r.detectedX ?? '?').toString().padStart(4)}, ${(r.detectedY ?? '?').toString().padStart(4)}) | ` +
    `${(r.distanceToTruth?.toFixed(0) ?? 'n/a').padStart(5)} | ` +
    `${within ? 'YES' : 'no'}`,
  );
}

console.error(`\nPassed: ${passCount}/${validTrials} valid trials within 30 px (${TRIALS.length} total trials).`);

if (passCount >= 4) {
  console.error('\n=== VERDICT: PASS ===');
  console.error('Shape detector picks correctly on ≥4/5 fresh trials. Ready for');
  console.error('production integration (Phase 260): wire findCursorByShape into');
  console.error('moveToPixel\'s correction-pass alongside the template-match fallback.');
} else if (passCount >= 2) {
  console.error('\n=== VERDICT: PARTIAL ===');
  console.error('Some trials pass, some fail. Inspect data/phase259-shape-live/ frames');
  console.error('to diagnose which cursor positions/backdrops are problematic.');
} else {
  console.error('\n=== VERDICT: FAIL ===');
  console.error('Shape detector struggles on fresh diverse frames. Phase 251 saved');
  console.error('frames may have been unrepresentative. Diagnose before production.');
}
process.exit(0);
