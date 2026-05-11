/**
 * Phase 261: DIFFERENTIAL motion-diff to separate cursor from
 * continuously-animated widgets.
 *
 * Phase 260 failed: clock-widget second-hand sweep produces more
 * local diff than the cursor's discrete wiggle. Need to subtract
 * baseline noise.
 *
 * Procedure (per trial):
 *   1. F0: pre-frame
 *   2. (no wiggle) sleep matching the post-wiggle interval
 *   3. F1: baseline-noise frame
 *   4. Emit wiggle
 *   5. F2: wiggle-response frame
 *   6. For each top-5 shape candidate at position P:
 *      noise = sum |F0 - F1| in 50x50 box around P
 *      response = sum |F1 - F2| in 50x50 box around P
 *      score = response - noise
 *   7. Pick the candidate with the highest differential score.
 *      Cursor: noise small, response large → high differential
 *      Clock:  noise ≈ response → near zero differential
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase261-differential';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 261 differential motion-diff at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

console.error('Step 0: gentle pre-position emit');
for (let i = 0; i < 4; i++) {
  await client.mouseMoveRelative(60, 40);
  await sleep(50);
}
await sleep(600);

const TRIALS = [
  { name: 'right',     dx: 50,  dy:   0 },
  { name: 'down',      dx:  0,  dy:  50 },
  { name: 'left',      dx: -50, dy:   0 },
  { name: 'up',        dx:  0,  dy: -50 },
  { name: 'diag',      dx: 40,  dy:  40 },
];

const BOX = 25;

function localDiff(
  a: Buffer, b: Buffer, width: number, height: number, cx: number, cy: number,
): number {
  let diff = 0;
  for (let dy = -BOX; dy <= BOX; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -BOX; dx <= BOX; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const o = (y * width + x) * 3;
      diff += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
    }
  }
  return diff;
}

interface Result {
  name: string;
  pickPos: { x: number; y: number } | null;
  pickIdx: number;
  pickDiff: number;
  candidates: { x: number; y: number; pix: number; noise: number; response: number; differential: number }[];
}

const results: Result[] = [];

for (const [i, t] of TRIALS.entries()) {
  console.error(`\n--- Trial ${i + 1}/5: ${t.name} (wiggle ${t.dx},${t.dy}) ---`);

  // F0: pre-frame (no wiggle yet)
  const f0Shot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-F0.jpg`, f0Shot.buffer);
  const f0 = await sharp(f0Shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // Wait the SAME interval we'll use for the post-wiggle capture
  await sleep(400);

  // F1: baseline-noise frame (still no wiggle)
  const f1Shot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-F1.jpg`, f1Shot.buffer);
  const f1 = await sharp(f1Shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // Shape candidates on F1 (more current than F0)
  const cands = findCursorShapeCandidates(f1.data, f1.info.width, f1.info.height, 5);
  if (cands.length === 0) {
    console.error('  No shape candidates');
    results.push({ name: t.name, pickPos: null, pickIdx: -1, pickDiff: 0, candidates: [] });
    continue;
  }

  // Emit wiggle
  await client.mouseMoveRelative(t.dx, t.dy);
  await sleep(400);

  // F2: wiggle-response frame
  const f2Shot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-F2.jpg`, f2Shot.buffer);
  const f2 = await sharp(f2Shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // Score each candidate by differential motion
  const W = f1.info.width;
  const H = f1.info.height;
  const scored = cands.map((c) => {
    const cx = Math.round(c.centroidX);
    const cy = Math.round(c.centroidY);
    const noise = localDiff(f0.data, f1.data, W, H, cx, cy);
    const response = localDiff(f1.data, f2.data, W, H, cx, cy);
    return {
      x: cx, y: cy, pix: c.pixels, noise, response, differential: response - noise,
    };
  });

  console.error(`  Candidates with differential scores:`);
  console.error(`  # | (x, y)        | pix | noise  | response | differential`);
  console.error(`  --+---------------+-----+--------+----------+--------------`);
  for (const [j, s] of scored.entries()) {
    console.error(
      `  ${j + 1} | (${s.x.toString().padStart(4)}, ${s.y.toString().padStart(4)}) | ` +
      `${s.pix.toString().padStart(3)} | ` +
      `${s.noise.toString().padStart(6)} | ` +
      `${s.response.toString().padStart(8)} | ` +
      `${s.differential.toString().padStart(12)}`,
    );
  }

  let bestIdx = 0;
  for (let j = 1; j < scored.length; j++) {
    if (scored[j].differential > scored[bestIdx].differential) bestIdx = j;
  }
  const pick = scored[bestIdx];
  console.error(`  → Pick: #${bestIdx + 1} at (${pick.x}, ${pick.y}) — differential=${pick.differential}`);

  results.push({
    name: t.name,
    pickPos: { x: pick.x, y: pick.y },
    pickIdx: bestIdx,
    pickDiff: pick.differential,
    candidates: scored,
  });
}

console.error('\n\n=== RESULT SUMMARY ===');
console.error('trial         | pick (x, y)    | differential');
console.error('--------------+----------------+-------------');
for (const r of results) {
  if (!r.pickPos) {
    console.error(`${r.name.padEnd(13)} | NO CANDIDATES`);
    continue;
  }
  console.error(
    `${r.name.padEnd(13)} | ` +
    `(${r.pickPos.x.toString().padStart(4)}, ${r.pickPos.y.toString().padStart(4)}) | ` +
    `${r.pickDiff.toString().padStart(11)}`,
  );
}

console.error('\nVISUAL VERIFICATION: inspect data/phase261-differential/t{N}-F{0,1,2}.jpg');
console.error('to confirm picks land on the cursor.');
process.exit(0);
