/**
 * Phase 301c: rate-limit probe with proper cursor localization.
 *
 * For each emit size: home, wake cursor with small wiggle, locate
 * cursor via wiggle-disambiguated shape-detect (try multiple
 * neighborhoods AROUND home position to bypass widget FPs). Then
 * emit, locate again, measure displacement.
 *
 * Method: instead of single shape-detect call, scan multiple radii
 * around home position. Find the candidate that MOVES with a 5-mickey
 * wiggle pre-test.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByShape, findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase301c-rate-limit/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 301c rate-limit probe at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

async function decodeFrom(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, w: info.width, h: info.height };
}

/**
 * Find cursor by wiggle-discriminating: take pre-frame, emit small
 * wiggle, take post-frame, find candidate that DISAPPEARED from pre
 * frame's location (real cursor moves with wiggle, static FPs don't).
 */
async function findCursorByWiggle(label: string): Promise<{ x: number; y: number } | null> {
  const pre = await client.screenshot();
  await fs.writeFile(`${ROOT}/${label}_pre.jpg`, pre.buffer);
  const preDec = await decodeFrom(pre.buffer);

  // Get top candidates in pre frame
  const preCands = findCursorShapeCandidates(preDec.rgb, preDec.w, preDec.h, 10);
  const preBright = findCursorShapeCandidates(preDec.rgb, preDec.w, preDec.h, 10, { brightThreshold: 120 });
  const allPre = [...preCands, ...preBright];

  // Wiggle
  await client.mouseMoveRelative(15, 5);
  await sleep(200);
  const post = await client.screenshot();
  await fs.writeFile(`${ROOT}/${label}_post.jpg`, post.buffer);
  const postDec = await decodeFrom(post.buffer);

  // Inverse wiggle to restore
  await client.mouseMoveRelative(-15, -5);
  await sleep(200);

  // For each pre candidate, check if it's still there in post (within 5 px).
  // The cursor MOVED with the wiggle so its initial position should be empty.
  // FP STAYED.
  const postCandsAt = (pos: { x: number; y: number }) => {
    const c1 = findCursorByShape(postDec.rgb, postDec.w, postDec.h, { expectedNear: pos, expectedNearRadius: 5 });
    const c2 = findCursorByShape(postDec.rgb, postDec.w, postDec.h, { expectedNear: pos, expectedNearRadius: 5, brightThreshold: 120 });
    return c1 || c2;
  };

  // The real cursor is the candidate that's GONE from its pre position in the post frame.
  for (const cand of allPre) {
    const stillThere = postCandsAt({ x: cand.centroidX, y: cand.centroidY });
    if (!stillThere) {
      // This cluster moved with the wiggle → real cursor
      return { x: Math.round(cand.centroidX), y: Math.round(cand.centroidY) };
    }
  }
  return null;
}

const SIZES = [10, 30, 100, 300];
const N_PER = 3;
interface Sample { mickeys: number; trial: number; pre: { x: number; y: number } | null; post: { x: number; y: number } | null; dxPx: number | null; ratio: number | null }
const samples: Sample[] = [];

for (const mickeys of SIZES) {
  for (let trial = 1; trial <= N_PER; trial++) {
    console.error(`\n--- ${mickeys} mickeys, trial ${trial} ---`);
    await ipadGoHome(client, { forceHomeViaSwipe: true });
    await sleep(1500);

    const pre = await findCursorByWiggle(`m${mickeys}_t${trial}_findpre`);
    console.error(`  cursor before emit: ${pre ? `(${pre.x},${pre.y})` : 'NOT FOUND'}`);

    await client.mouseMoveRelative(-mickeys, 0);
    await sleep(600);

    const post = await findCursorByWiggle(`m${mickeys}_t${trial}_findpost`);
    console.error(`  cursor after emit: ${post ? `(${post.x},${post.y})` : 'NOT FOUND'}`);

    if (pre && post) {
      const dxPx = pre.x - post.x;
      const ratio = dxPx / mickeys;
      console.error(`  dx=${dxPx} px, ratio=${ratio.toFixed(2)} px/mickey (expected ~1.4)`);
      samples.push({ mickeys, trial, pre, post, dxPx, ratio });
    } else {
      samples.push({ mickeys, trial, pre, post, dxPx: null, ratio: null });
    }
  }
}

console.error(`\n=== SUMMARY ===`);
for (const s of samples) {
  const p = s.pre ? `(${s.pre.x},${s.pre.y})` : 'null';
  const q = s.post ? `(${s.post.x},${s.post.y})` : 'null';
  const dx = s.dxPx !== null ? s.dxPx.toString() : 'n/a';
  const r = s.ratio !== null ? s.ratio.toFixed(2) : 'n/a';
  console.error(`  ${s.mickeys.toString().padStart(3)} m, t${s.trial}: pre=${p} post=${q} dx=${dx} ratio=${r}`);
}

console.error(`\n=== AGGREGATE ===`);
for (const m of SIZES) {
  const v = samples.filter(s => s.mickeys === m && s.ratio !== null).map(s => s.ratio as number);
  if (v.length === 0) { console.error(`  ${m} mickeys: ALL FAILED`); continue; }
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.error(`  ${m} mickeys: ratio mean=${mean.toFixed(2)} (n=${v.length}/${N_PER})`);
}

await fs.writeFile(`${ROOT}/samples.json`, JSON.stringify(samples, null, 2));
process.exit(0);
