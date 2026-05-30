/**
 * Phase 301b: rate-limit probe using motion-diff (not standalone
 * shape-detect, which gets fooled by widget FPs on a static frame).
 *
 * Strategy: Take pre-emit screenshot. Emit N mickeys. Take post-emit
 * screenshot. Run detectMotion to find the cluster pair (cursor's
 * before + after position). That cluster pair gives the true
 * displacement caused by the emit.
 *
 * Sizes: 10, 30, 100, 300 mickeys.
 * For each size, N=3 trials. Re-home between trials.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { detectMotion } from '../src/pikvm/move-to.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase301b-rate-limit/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 301b rate-limit motion-diff probe at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const SIZES = [10, 30, 100, 300];
const N_PER = 3;
const HOME = { x: 1060, y: 780 }; // typical post-home cursor position

interface Sample { mickeys: number; trial: number; pre: { x: number; y: number } | null; post: { x: number; y: number } | null; dxPx: number | null; ratio: number | null; mode: string | null; reason: string }
const samples: Sample[] = [];

for (const mickeys of SIZES) {
  for (let trial = 1; trial <= N_PER; trial++) {
    console.error(`\n--- ${mickeys} mickeys, trial ${trial} ---`);
    await ipadGoHome(client, { forceHomeViaSwipe: true });
    await sleep(1500);

    // Pre-emit screenshot
    const preShot = await client.screenshot();
    await fs.writeFile(`${ROOT}/m${mickeys}_t${trial}_pre.jpg`, preShot.buffer);
    const preDec = await decodeScreenshot(preShot.buffer);

    // Expected cursor: home position
    // Expected post position: home + (-mickeys * 1.4, 0)
    const expectedStart = HOME;
    const expectedEnd = { x: HOME.x - mickeys * 1.4, y: HOME.y };

    // Emit leftward
    await client.mouseMoveRelative(-mickeys, 0);
    await sleep(500);

    // Post-emit screenshot
    const postShot = await client.screenshot();
    await fs.writeFile(`${ROOT}/m${mickeys}_t${trial}_post.jpg`, postShot.buffer);
    const postDec = await decodeScreenshot(postShot.buffer);

    // Motion-diff
    const result = detectMotion(
      preDec,
      postDec,
      expectedStart,
      expectedEnd,
      { x: -mickeys, y: 0 },
      200, // generous preWindow
      Math.max(200, mickeys * 2), // postWindow scaled to emit size
      false, // verbose
      8, // clusterMin
      90, // clusterMax
      100, // brightnessFloor
    );

    if (result.ok) {
      const dxPx = result.preCandidate.centroidX - result.postCandidate.centroidX;
      const ratio = dxPx / mickeys;
      console.error(`  motion-diff: pre=(${Math.round(result.preCandidate.centroidX)},${Math.round(result.preCandidate.centroidY)}) post=(${Math.round(result.postCandidate.centroidX)},${Math.round(result.postCandidate.centroidY)})`);
      console.error(`  dx=${dxPx.toFixed(0)} px (expected ~${(mickeys * 1.4).toFixed(0)})  ratio=${ratio.toFixed(2)} px/mickey`);
      samples.push({ mickeys, trial, pre: { x: Math.round(result.preCandidate.centroidX), y: Math.round(result.preCandidate.centroidY) }, post: { x: Math.round(result.postCandidate.centroidX), y: Math.round(result.postCandidate.centroidY) }, dxPx, ratio, mode: 'motion', reason: '' });
    } else {
      console.error(`  motion-diff FAILED: ${result.reason}`);
      samples.push({ mickeys, trial, pre: null, post: null, dxPx: null, ratio: null, mode: 'failed', reason: result.reason });
    }
  }
}

console.error(`\n=== SUMMARY ===`);
console.error('mickeys | trial | pre         | post        | dx_px | ratio | mode');
for (const s of samples) {
  const p = s.pre ? `(${s.pre.x},${s.pre.y})` : 'null';
  const q = s.post ? `(${s.post.x},${s.post.y})` : 'null';
  const dx = s.dxPx !== null ? s.dxPx.toFixed(0) : 'n/a';
  const r = s.ratio !== null ? s.ratio.toFixed(2) : 'n/a';
  console.error(`${s.mickeys.toString().padStart(7)} | ${s.trial.toString().padStart(5)} | ${p.padEnd(11)} | ${q.padEnd(11)} | ${dx.padStart(5)} | ${r.padStart(5)} | ${s.mode}`);
}

console.error(`\n=== AGGREGATE px/mickey ===`);
for (const mickeys of SIZES) {
  const valid = samples.filter(s => s.mickeys === mickeys && s.ratio !== null);
  const ratios = valid.map(s => s.ratio as number);
  if (ratios.length === 0) {
    console.error(`  ${mickeys} mickeys: ALL FAILED`);
    continue;
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  console.error(`  ${mickeys} mickeys: ${valid.length}/${N_PER} valid, ratio mean=${mean.toFixed(2)} (min=${min.toFixed(2)}, max=${max.toFixed(2)})`);
}

console.error(`\nInterpretation:`);
console.error(`  - If ratio similar (e.g. 1.3-1.5) across all sizes → NO rate-limit; cursor moves proportionally.`);
console.error(`  - If 300-mickey ratio is MUCH lower than 10/30 → rate-limit confirmed.`);
console.error(`  - If motion-diff fails for big emits → cursor went off-screen or wasn't detected (different problem).`);

await fs.writeFile(`${ROOT}/samples.json`, JSON.stringify(samples, null, 2));
process.exit(0);
