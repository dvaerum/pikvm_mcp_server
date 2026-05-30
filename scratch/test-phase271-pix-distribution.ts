/**
 * Phase 271: characterize the actual pixel-count distribution of
 * the iPad cursor as seen by findCursorByShape.
 *
 * Phase 269 found cursor scores 0.00 because:
 *   sizeFit = exp(-(pix-80)²/600)
 *
 * If pix is far from 80, sizeFit → 0. The cursor's TRUE pixel count
 * is unknown; we assumed ~80 (from Phase 104). If actual is 150-200,
 * the Gaussian is mistuned.
 *
 * Procedure:
 *   1. Post-home cursor at (~1063, 778) per Phase 265
 *   2. Take screenshot with keepalive
 *   3. Run findCursorByShape with locality hint at (1100, 780) radius 150
 *   4. Log the winning candidate's pixel count
 *   5. Small wiggle (10, 10) to refresh cursor render
 *   6. Repeat N=10
 *
 * Output: distribution of pixel counts. Tells us:
 *   - Mean and stddev of cursor pix
 *   - Whether 80 is the right peak for sizeFit
 *   - Whether the Gaussian variance (600) is too narrow
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
const ROOT = `./data/phase271-pix-dist/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 271 cursor pixel-count distribution at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

const HINT = { x: 1100, y: 780 };
const HINT_RADIUS = 150;
const N = 10;

interface Sample {
  i: number;
  pos: { x: number; y: number } | null;
  pix: number;
  score: number;
}
const samples: Sample[] = [];

for (let i = 1; i <= N; i++) {
  // Tiny wiggle in alternating direction to refresh cursor render
  // without moving it far. Net displacement zero across pairs.
  const dx = (i % 2 === 0) ? -5 : 5;
  const dy = (i % 2 === 0) ? -3 : 3;
  await client.mouseMoveRelative(dx, dy);
  await sleep(300);

  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}.jpg`, shot.buffer);
  const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = findCursorByShape(dec.data, dec.info.width, dec.info.height, {
    expectedNear: HINT,
    expectedNearRadius: HINT_RADIUS,
  });
  if (r) {
    samples.push({ i, pos: { x: Math.round(r.centroidX), y: Math.round(r.centroidY) }, pix: r.pixels, score: r.shapeScore });
    console.error(`  t${i.toString().padStart(2)}: (${samples[samples.length - 1].pos!.x},${samples[samples.length - 1].pos!.y}) pix=${r.pixels} score=${r.shapeScore.toFixed(3)}`);
  } else {
    samples.push({ i, pos: null, pix: 0, score: 0 });
    console.error(`  t${i.toString().padStart(2)}: (null)`);
  }
}

const valid = samples.filter(s => s.pos !== null);
if (valid.length > 0) {
  const pixes = valid.map(s => s.pix).sort((a, b) => a - b);
  const mean = pixes.reduce((a, b) => a + b, 0) / pixes.length;
  const median = pixes[Math.floor(pixes.length / 2)];
  const min = pixes[0];
  const max = pixes[pixes.length - 1];
  const variance = pixes.reduce((s, p) => s + (p - mean) ** 2, 0) / pixes.length;
  const stddev = Math.sqrt(variance);

  console.error(`\n=== PIXEL COUNT STATS (N=${valid.length}) ===`);
  console.error(`  min:    ${min}`);
  console.error(`  median: ${median}`);
  console.error(`  mean:   ${mean.toFixed(1)}`);
  console.error(`  max:    ${max}`);
  console.error(`  stddev: ${stddev.toFixed(1)}`);

  console.error(`\nCurrent sizeFit: exp(-(pix - 80)² / 600)`);
  console.error(`  Score for pix=${median}: ${Math.exp(-Math.pow(median - 80, 2) / 600).toExponential(2)}`);
  console.error(`  Score for pix=${mean.toFixed(0)}: ${Math.exp(-Math.pow(mean - 80, 2) / 600).toExponential(2)}`);

  // Recommendation: peak should be at median, variance = 4 * stddev²
  // (so 2-sigma covers most of the distribution at acceptable score)
  const recommendedPeak = Math.round(median);
  const recommendedVariance = Math.round(4 * variance);
  console.error(`\nRecommended sizeFit: exp(-(pix - ${recommendedPeak})² / ${recommendedVariance})`);
  console.error(`  Score for pix=${median}: ${Math.exp(-Math.pow(median - recommendedPeak, 2) / recommendedVariance).toExponential(2)}`);
}

console.error(`\nVisually inspect data/phase271-pix-dist/<run-id>/t*.jpg to confirm cursor positions match.`);
process.exit(0);
