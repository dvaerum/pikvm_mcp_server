/**
 * Phase 264: make cursor-shape-detect actually work, via larger
 * motion verification.
 *
 * Phase 260 motion verification used a 50-px wiggle. The clock
 * minute-hand sweep over 400 ms (~2.4°, ~few px) produced more
 * local pixel-diff than the 50-px cursor wiggle (24-33k vs 33-41k
 * for clock).
 *
 * Phase 264: use a 200-px wiggle. The cursor moves visibly across
 * the screen; the clock can only sweep a few pixels in the same
 * interval. Local pixel-diff around the cursor's pre-position
 * should be ~10× larger than around any widget.
 *
 * If this works (≥4/5 trials pick the correct cursor candidate),
 * ship cursor-shape-detect as a production hybrid:
 *   1. Shape detector → top-5 candidates
 *   2. Large-motion verification → pick the one that moves
 *
 * If it doesn't work, the shape detector idea probably can't be
 * salvaged without ML or some other significant architectural move.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorShapeCandidates, type ShapeCandidate } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase264-large-motion/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 264 large-motion verification at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

// Gentle pre-position to a known mid-screen area
console.error('Step 0: gentle pre-position emit');
for (let i = 0; i < 4; i++) {
  await client.mouseMoveRelative(60, 40);
  await sleep(50);
}
await sleep(600);

const TRIALS = [
  { name: 'big-right', dx:  200, dy:    0 },
  { name: 'big-down',  dx:    0, dy:  200 },
  { name: 'big-left',  dx: -200, dy:    0 },
  { name: 'big-up',    dx:    0, dy: -200 },
  { name: 'big-diag',  dx:  150, dy:  150 },
];

const BOX = 40; // larger box for the larger cursor footprint after big motion

interface Result {
  name: string;
  pickIdx: number;
  pickPos: { x: number; y: number };
  pickDiff: number;
  runnerUpDiff: number;
  margin: number;
  candidates: { x: number; y: number; pix: number; localDiff: number }[];
}

const results: Result[] = [];

for (const [i, t] of TRIALS.entries()) {
  console.error(`\n--- Trial ${i + 1}/5: ${t.name} (wiggle ${t.dx},${t.dy}) ---`);

  // F1: pre-frame
  const preShot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-pre.jpg`, preShot.buffer);
  const pre = await sharp(preShot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // Find shape candidates on pre-frame
  const cands = findCursorShapeCandidates(pre.data, pre.info.width, pre.info.height, 5);
  if (cands.length === 0) {
    console.error('  No shape candidates — skip');
    continue;
  }

  // Emit LARGE wiggle. Chunked to respect PiKVM ±127 mickey limit
  // per call. Each call moves a fraction of the total; total = 200
  // ish in the direction.
  const sgnX = Math.sign(t.dx);
  const sgnY = Math.sign(t.dy);
  const absX = Math.abs(t.dx);
  const absY = Math.abs(t.dy);
  const stepX = absX === 0 ? 0 : Math.min(80, absX);
  const stepY = absY === 0 ? 0 : Math.min(80, absY);
  let remX = absX, remY = absY;
  while (remX > 0 || remY > 0) {
    const dx = sgnX * Math.min(stepX, remX);
    const dy = sgnY * Math.min(stepY, remY);
    await client.mouseMoveRelative(dx, dy);
    remX -= Math.abs(dx);
    remY -= Math.abs(dy);
    await sleep(40);
  }
  await sleep(400);  // settle

  // F2: post-frame after big motion
  const postShot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-post.jpg`, postShot.buffer);
  const post = await sharp(postShot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // For each candidate, compute local pixel diff in 80x80 box
  // around its pre-position
  const W = pre.info.width;
  const H = pre.info.height;
  const scored = cands.map((c) => {
    const cx = Math.round(c.centroidX);
    const cy = Math.round(c.centroidY);
    let diff = 0;
    for (let dy = -BOX; dy <= BOX; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -BOX; dx <= BOX; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const o = (y * W + x) * 3;
        diff += Math.abs(pre.data[o] - post.data[o]) +
                Math.abs(pre.data[o + 1] - post.data[o + 1]) +
                Math.abs(pre.data[o + 2] - post.data[o + 2]);
      }
    }
    return { x: cx, y: cy, pix: c.pixels, localDiff: diff };
  });

  console.error('  # | (x, y)        | pix | local diff   (80x80 box)');
  for (const [j, s] of scored.entries()) {
    console.error(
      `  ${j + 1} | (${s.x.toString().padStart(4)}, ${s.y.toString().padStart(4)}) | ` +
      `${s.pix.toString().padStart(3)} | ${s.localDiff.toLocaleString().padStart(10)}`,
    );
  }

  scored.sort((a, b) => b.localDiff - a.localDiff);
  const pick = scored[0];
  const runnerUp = scored[1] ?? { localDiff: 0 };
  const margin = pick.localDiff - runnerUp.localDiff;
  console.error(
    `  → Pick (largest local diff): (${pick.x}, ${pick.y}) — ` +
    `diff=${pick.localDiff.toLocaleString()}, runner-up=${runnerUp.localDiff.toLocaleString()}, margin=${margin.toLocaleString()}`,
  );

  results.push({
    name: t.name,
    pickIdx: 0,
    pickPos: { x: pick.x, y: pick.y },
    pickDiff: pick.localDiff,
    runnerUpDiff: runnerUp.localDiff,
    margin,
    candidates: scored,
  });
}

console.error('\n\n=== RESULT SUMMARY ===');
console.error('trial      | pick (x, y)    | local diff   | runner-up    | margin');
console.error('-----------+----------------+--------------+--------------+-------');
for (const r of results) {
  console.error(
    `${r.name.padEnd(10)} | ` +
    `(${r.pickPos.x.toString().padStart(4)}, ${r.pickPos.y.toString().padStart(4)}) | ` +
    `${r.pickDiff.toLocaleString().padStart(12)} | ` +
    `${r.runnerUpDiff.toLocaleString().padStart(12)} | ` +
    `${r.margin.toLocaleString().padStart(6)}`,
  );
}

console.error('\nVISUAL VERIFICATION:');
console.error(`Inspect ${ROOT}/t{N}-{pre,post}.jpg`);
console.error('For each trial, the pre-frame cursor should be at the picked (x, y).');
console.error('Confident picks have margin > 100,000 (clear winner vs runner-up).');

const confident = results.filter(r => r.margin > 100000).length;
console.error(`\nHigh-confidence picks (margin > 100k): ${confident}/${results.length}`);
process.exit(0);
