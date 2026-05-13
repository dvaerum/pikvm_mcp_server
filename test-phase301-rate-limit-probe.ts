/**
 * Phase 301: directly test whether iPad input rate-limiting is real.
 *
 * Method: from home position, emit mickey-counts of varying size and
 * measure actual cursor displacement via shape-detect. Compute
 * px/mickey for each emit size. If the ratio is similar across small
 * and large emits, no rate-limit. If large emits show much smaller
 * px/mickey than small emits, rate-limit is real.
 *
 * Test sizes: 10, 30, 100, 300 mickeys (all X-axis, leftward = negative)
 * N=3 each.
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase301-rate-limit/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 301 rate-limit probe at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

async function locateCursor(label: string): Promise<{ x: number; y: number } | null> {
  // Use both dark and bright masks to find cursor.
  const shot = await client.screenshot();
  await fs.writeFile(`${ROOT}/${label}.jpg`, shot.buffer);
  const { data, info } = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let pick = findCursorByShape(data, info.width, info.height);
  if (!pick || pick.shapeScore < 0.1) {
    const bright = findCursorByShape(data, info.width, info.height, { brightThreshold: 120 });
    if (bright && (!pick || bright.shapeScore > pick.shapeScore)) pick = bright;
  }
  return pick && pick.shapeScore >= 0.05 ? { x: Math.round(pick.centroidX), y: Math.round(pick.centroidY) } : null;
}

const MICKEY_SIZES = [10, 30, 100, 300];
const N_PER_SIZE = 3;

interface Sample { mickeys: number; trial: number; from: { x: number; y: number } | null; to: { x: number; y: number } | null; dxPx: number | null; pxPerMickey: number | null }
const samples: Sample[] = [];

for (const mickeys of MICKEY_SIZES) {
  for (let trial = 1; trial <= N_PER_SIZE; trial++) {
    console.error(`\n--- ${mickeys} mickeys, trial ${trial} ---`);
    // Re-home cursor for consistent start
    await ipadGoHome(client, { forceHomeViaSwipe: true });
    await sleep(1500);
    // Wiggle to ensure cursor is visible
    await client.mouseMoveRelative(5, 5);
    await sleep(300);
    await client.mouseMoveRelative(-5, -5);
    await sleep(500);

    const from = await locateCursor(`m${mickeys}_t${trial}_pre`);
    if (!from) {
      console.error(`  could not locate cursor pre-emit`);
      samples.push({ mickeys, trial, from: null, to: null, dxPx: null, pxPerMickey: null });
      continue;
    }
    console.error(`  cursor at (${from.x},${from.y}) before emit`);

    // Emit leftward (negative X) so we move toward known wallpaper region.
    await client.mouseMoveRelative(-mickeys, 0);
    await sleep(500); // settle

    const to = await locateCursor(`m${mickeys}_t${trial}_post`);
    if (!to) {
      console.error(`  could not locate cursor post-emit (${mickeys} mickeys may have moved it to non-detectable area)`);
      samples.push({ mickeys, trial, from, to: null, dxPx: null, pxPerMickey: null });
      continue;
    }
    const dxPx = from.x - to.x; // positive if cursor moved left as expected
    const pxPerMickey = dxPx / mickeys;
    console.error(`  cursor at (${to.x},${to.y}) after emit`);
    console.error(`  delta: ${dxPx} px (expected ~${(mickeys * 1.4).toFixed(0)} px if ratio=1.4)`);
    console.error(`  px/mickey: ${pxPerMickey.toFixed(2)}`);
    samples.push({ mickeys, trial, from, to, dxPx, pxPerMickey });
  }
}

console.error(`\n=== SUMMARY ===`);
console.error('mickeys | trial | from        | to          | dx_px | px/mickey');
for (const s of samples) {
  const f = s.from ? `(${s.from.x},${s.from.y})` : 'null';
  const t = s.to ? `(${s.to.x},${s.to.y})` : 'null';
  const dx = s.dxPx !== null ? s.dxPx.toString() : 'n/a';
  const r = s.pxPerMickey !== null ? s.pxPerMickey.toFixed(2) : 'n/a';
  console.error(`${s.mickeys.toString().padStart(7)} | ${s.trial.toString().padStart(5)} | ${f.padEnd(11)} | ${t.padEnd(11)} | ${dx.padStart(5)} | ${r}`);
}

// Aggregate per mickey-size
console.error(`\n=== AGGREGATE (px/mickey by emit size) ===`);
for (const mickeys of MICKEY_SIZES) {
  const valid = samples.filter(s => s.mickeys === mickeys && s.pxPerMickey !== null);
  const ratios = valid.map(s => s.pxPerMickey as number);
  const mean = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : NaN;
  const min = ratios.length > 0 ? Math.min(...ratios) : NaN;
  const max = ratios.length > 0 ? Math.max(...ratios) : NaN;
  console.error(`  ${mickeys} mickeys: ${valid.length}/${N_PER_SIZE} valid, px/mickey mean=${mean.toFixed(2)} (min=${min.toFixed(2)}, max=${max.toFixed(2)})`);
}

await fs.writeFile(`${ROOT}/samples.json`, JSON.stringify(samples, null, 2));
console.error(`\nIf px/mickey stays similar across 10/30/100/300 mickey emits → no rate-limit.`);
console.error(`If 300-mickey emit shows much lower px/mickey than 10/30 → rate-limit is real.`);
process.exit(0);
