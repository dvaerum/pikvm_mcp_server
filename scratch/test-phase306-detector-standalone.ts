/**
 * Phase 306: standalone cursor-shape-detect diagnostic on an iPad
 * kept unlocked throughout.
 *
 * Phase 305 was confounded by iPad autolock — null-detection captures
 * showed the lock screen. This bench:
 *
 *   1. Unlocks iPad ONCE at start.
 *   2. Between trials, emits a tiny non-edge wiggle to prevent
 *      autolock (Phase 187 keepalive pattern).
 *   3. Drives the cursor to a known position by SLAMMING to a chosen
 *      corner (cursor's position is then well-defined: at the corner).
 *   4. Takes a screenshot.
 *   5. Runs findCursorShapeCandidates(k=5) DIRECTLY on the frame.
 *      No moveToPixel, no wiggle-verify, no production pipeline.
 *   6. Saves the frame + a JSON sidecar with all top-5 candidates
 *      AND the expected cursor position (the slam corner).
 *
 * Then: visually inspect each frame to confirm cursor is at the
 * expected corner, and compare to detector's top-1 pick.
 *
 * Position diversity:
 *   - Trial A: cursor at bottom-right corner (slamToCorner 'bottom-right')
 *   - Trial B: cursor at top-left corner
 *   - Trial C: cursor mid-screen via emit from bottom-right corner
 *
 * Each trial × N=10 with two repetitions per Phase 237 variance rule.
 *
 * The detector either picks the cursor (DONE: integration is the bug)
 * or picks something else (DONE: detector needs work).
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { slamToCorner } from '../src/pikvm/ballistics.js';
import { findCursorShapeCandidates } from '../src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase306-detector/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 306 detector diagnostic at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const RESOLUTION = await client.getResolution();
console.error(`Resolution: ${RESOLUTION.width}x${RESOLUTION.height}`);

interface Cand {
  centroidX: number;
  centroidY: number;
  pixels: number;
  shapeScore: number;
}

interface TrialResult {
  trial: number;
  position: string;
  expectedNear: { x: number; y: number };
  topCandidates: Cand[];
  pickedDistanceFromExpected: number | null;
  pickedClassification: 'cursor' | 'wrong' | 'no-candidate';
}

async function antiLockWiggle() {
  // Small non-edge movement to keep iPad awake. 40 px box around current
  // belief, total displacement 0.
  await client.mouseMoveRelative(20, 0);
  await sleep(30);
  await client.mouseMoveRelative(0, 20);
  await sleep(30);
  await client.mouseMoveRelative(-20, 0);
  await sleep(30);
  await client.mouseMoveRelative(0, -20);
  await sleep(80);
}

async function runOneTrial(
  trialIdx: number,
  positionLabel: 'bottom-right' | 'top-left' | 'mid-screen',
): Promise<TrialResult> {
  await antiLockWiggle();

  let expectedNear: { x: number; y: number };

  if (positionLabel === 'bottom-right') {
    await slamToCorner(client, { corner: 'bottom-right', paceMs: 60 });
    // Cursor expected at lower-right of iPad active region. Use a tolerance:
    // we'll search anywhere in the bottom-right quadrant.
    expectedNear = { x: Math.round(RESOLUTION.width * 0.85), y: Math.round(RESOLUTION.height * 0.85) };
  } else if (positionLabel === 'top-left') {
    await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
    expectedNear = { x: Math.round(RESOLUTION.width * 0.15), y: Math.round(RESOLUTION.height * 0.15) };
  } else {
    // Mid-screen: slam to bottom-right then walk back to center via chunked emit
    await slamToCorner(client, { corner: 'bottom-right', paceMs: 60 });
    await sleep(300);
    // Walk left+up by ~400 px each via 20-mickey chunks
    for (let i = 0; i < 14; i++) {
      await client.mouseMoveRelative(-20, -20);
      await sleep(40);
    }
    expectedNear = { x: Math.round(RESOLUTION.width * 0.5), y: Math.round(RESOLUTION.height * 0.5) };
  }

  await sleep(500); // settle

  const shot = await client.screenshot();
  const tag = `t${trialIdx.toString().padStart(2, '0')}-${positionLabel}`;
  const jpgPath = path.join(ROOT, `${tag}.jpg`);
  await fs.writeFile(jpgPath, shot.buffer);

  // Decode + run detector with NO hint (we want to see what it picks
  // globally, not biased toward expectedNear).
  const decoded = await decodeScreenshot(shot.buffer);
  const cands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 5);

  // Annotate the screenshot with markers: cyan = expected, magenta = top-1,
  // yellow = other top-K.
  let annotated = sharp(shot.buffer);
  const marks: Array<{ x: number; y: number; color: { r: number; g: number; b: number }; label: string }> = [];
  marks.push({ x: expectedNear.x, y: expectedNear.y, color: { r: 0, g: 255, b: 255 }, label: 'EXP' });
  for (let i = 0; i < cands.length; i++) {
    const color = i === 0 ? { r: 255, g: 0, b: 255 } : { r: 255, g: 255, b: 0 };
    marks.push({
      x: Math.round(cands[i].centroidX),
      y: Math.round(cands[i].centroidY),
      color,
      label: `${i + 1}`,
    });
  }

  // Use sharp composite for crosshair markers
  const svgMarks = marks
    .map(
      (m) =>
        `<circle cx="${m.x}" cy="${m.y}" r="18" stroke="rgb(${m.color.r},${m.color.g},${m.color.b})" stroke-width="3" fill="none"/>` +
        `<text x="${m.x + 22}" y="${m.y + 5}" fill="rgb(${m.color.r},${m.color.g},${m.color.b})" font-size="22" font-family="monospace" font-weight="bold">${m.label}</text>`,
    )
    .join('');
  const svgBuf = Buffer.from(
    `<svg width="${decoded.width}" height="${decoded.height}" xmlns="http://www.w3.org/2000/svg">${svgMarks}</svg>`,
  );

  const annotatedPath = path.join(ROOT, `${tag}-annotated.png`);
  await annotated
    .composite([{ input: svgBuf, top: 0, left: 0 }])
    .png()
    .toFile(annotatedPath);

  // Classification: pick the cluster closest to expectedNear and see if
  // it's the top-1.
  let pickedDistanceFromExpected: number | null = null;
  let classification: 'cursor' | 'wrong' | 'no-candidate' = 'no-candidate';
  if (cands.length > 0) {
    const top1 = cands[0];
    pickedDistanceFromExpected = Math.hypot(top1.centroidX - expectedNear.x, top1.centroidY - expectedNear.y);
    // Allow generous tolerance — slam-to-corner is at edge of active region,
    // and the active region's edge in screenshot coords isn't exact.
    // Mid-screen target: cursor should be within ~150 px of screen center.
    const tolerance = positionLabel === 'mid-screen' ? 200 : 300;
    classification = pickedDistanceFromExpected <= tolerance ? 'cursor' : 'wrong';
  }

  return {
    trial: trialIdx,
    position: positionLabel,
    expectedNear,
    topCandidates: cands,
    pickedDistanceFromExpected,
    pickedClassification: classification,
  };
}

const N_PER_POSITION = 5;
const N_REPETITIONS = 2;

const allResults: TrialResult[] = [];

for (let rep = 1; rep <= N_REPETITIONS; rep++) {
  for (const pos of ['bottom-right', 'top-left', 'mid-screen'] as const) {
    console.error(`\n--- Rep ${rep}, position ${pos} ---`);
    for (let i = 1; i <= N_PER_POSITION; i++) {
      const trialIdx = (rep - 1) * N_PER_POSITION * 3 + i;
      const r = await runOneTrial(trialIdx, pos);
      allResults.push(r);
      const top1 = r.topCandidates[0];
      console.error(
        `  [${trialIdx}.${pos}] top1=${top1 ? `(${Math.round(top1.centroidX)},${Math.round(top1.centroidY)})pix=${top1.pixels}score=${top1.shapeScore.toFixed(3)}` : 'none'} ` +
        `dist=${r.pickedDistanceFromExpected !== null ? r.pickedDistanceFromExpected.toFixed(0) + 'px' : 'n/a'} ` +
        `class=${r.pickedClassification}`,
      );
    }
  }
}

// Aggregate
console.error('\n=== Aggregate ===');
for (const pos of ['bottom-right', 'top-left', 'mid-screen'] as const) {
  const subset = allResults.filter(r => r.position === pos);
  const cursorCount = subset.filter(r => r.pickedClassification === 'cursor').length;
  const wrongCount = subset.filter(r => r.pickedClassification === 'wrong').length;
  const noneCount = subset.filter(r => r.pickedClassification === 'no-candidate').length;
  console.error(`  ${pos}: cursor=${cursorCount}/${subset.length} wrong=${wrongCount} none=${noneCount}`);
}

await fs.writeFile(`${ROOT}/results.json`, JSON.stringify({ version: VERSION, resolution: RESOLUTION, results: allResults }, null, 2));
console.error(`\nFrames + annotations saved to ${ROOT}`);
console.error('NEXT: visually inspect *-annotated.png — cyan=expected, magenta=top-1, yellow=top-2..5');
process.exit(0);
