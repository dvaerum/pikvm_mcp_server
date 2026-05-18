/**
 * Measure the iPad's ambient screen-motion noise floor.
 *
 * Takes 30 screenshots over ~60s with NO input between captures, then
 * computes pairwise changedFraction between (a) adjacent pairs and
 * (b) longer-spaced pairs. Output tells us:
 *   - the noise floor for the bench's success metric
 *   - whether clock-tick-class changes dominate the noise
 *   - what % threshold cleanly separates "ambient" from "real click"
 *
 * Output: data/ambient-noise/frame-NN.jpg + summary printed to stdout.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { verifyClickByDiff } from './src/pikvm/click-verify.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const N_FRAMES = 30;
const INTERVAL_MS = 2000;

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/ambient-noise';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('settling iPad to home screen, then capturing baseline frames...');
await ipadGoHome(client);
await new Promise(r => setTimeout(r, 2000));

const frames: Buffer[] = [];
const timestamps: number[] = [];
for (let i = 0; i < N_FRAMES; i++) {
  const shot = await client.screenshot();
  frames.push(shot.buffer);
  timestamps.push(Date.now());
  await fs.writeFile(
    path.join(ROOT, `frame-${String(i).padStart(2, '0')}.jpg`),
    shot.buffer,
  );
  console.error(`  frame ${i + 1}/${N_FRAMES} at t=${(Date.now() - timestamps[0]) / 1000}s`);
  if (i < N_FRAMES - 1) await new Promise(r => setTimeout(r, INTERVAL_MS));
}

console.error('\ncomputing changedFraction for adjacent pairs (~2s apart)...');
const adjacentDeltas: { i: number; delta: number; dtSec: number }[] = [];
for (let i = 0; i < N_FRAMES - 1; i++) {
  const v = await verifyClickByDiff(frames[i], frames[i + 1], { minChangedFraction: 0.001 });
  const dt = (timestamps[i + 1] - timestamps[i]) / 1000;
  adjacentDeltas.push({ i, delta: v.changedFraction, dtSec: dt });
}

console.error('computing changedFraction for ~30s-spaced pairs (clock-tick zone)...');
const wideDeltas: { i: number; j: number; delta: number; dtSec: number }[] = [];
for (let i = 0; i < N_FRAMES; i++) {
  for (let j = i + 14; j < N_FRAMES; j += 14) {
    const v = await verifyClickByDiff(frames[i], frames[j], { minChangedFraction: 0.001 });
    const dt = (timestamps[j] - timestamps[i]) / 1000;
    wideDeltas.push({ i, j, delta: v.changedFraction, dtSec: dt });
  }
}

const stats = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return {
    n,
    min: s[0],
    p25: s[Math.floor(n * 0.25)],
    median: s[Math.floor(n / 2)],
    p75: s[Math.floor(n * 0.75)],
    p95: s[Math.floor(n * 0.95)],
    max: s[n - 1],
  };
};

const adjStats = stats(adjacentDeltas.map(d => d.delta));
const wideStats = stats(wideDeltas.map(d => d.delta));

console.error('\n=== Ambient noise floor ===');
console.error(`Adjacent pairs (~${INTERVAL_MS / 1000}s apart, n=${adjStats.n}):`);
console.error(`  min=${(adjStats.min * 100).toFixed(3)}%  p25=${(adjStats.p25 * 100).toFixed(3)}%  median=${(adjStats.median * 100).toFixed(3)}%  p75=${(adjStats.p75 * 100).toFixed(3)}%  p95=${(adjStats.p95 * 100).toFixed(3)}%  max=${(adjStats.max * 100).toFixed(3)}%`);
console.error(`\n~30s-spaced pairs (clock-tick zone, n=${wideStats.n}):`);
console.error(`  min=${(wideStats.min * 100).toFixed(3)}%  p25=${(wideStats.p25 * 100).toFixed(3)}%  median=${(wideStats.median * 100).toFixed(3)}%  p75=${(wideStats.p75 * 100).toFixed(3)}%  p95=${(wideStats.p95 * 100).toFixed(3)}%  max=${(wideStats.max * 100).toFixed(3)}%`);

// Save the highest-delta wide pair for visual inspection
const worst = [...wideDeltas].sort((a, b) => b.delta - a.delta)[0];
if (worst) {
  console.error(`\nWorst wide-pair: frames ${worst.i} → ${worst.j} (${worst.dtSec.toFixed(1)}s gap), delta=${(worst.delta * 100).toFixed(2)}%`);
  console.error(`  Look at ${ROOT}/frame-${String(worst.i).padStart(2, '0')}.jpg vs frame-${String(worst.j).padStart(2, '0')}.jpg`);
}

// Save adjacent and wide deltas as JSONL for further analysis
const logPath = path.join(ROOT, 'deltas.jsonl');
const lines: string[] = [];
for (const d of adjacentDeltas) lines.push(JSON.stringify({ kind: 'adjacent', ...d }));
for (const d of wideDeltas) lines.push(JSON.stringify({ kind: 'wide', ...d }));
await fs.writeFile(logPath, lines.join('\n') + '\n');
console.error(`\nDeltas: ${logPath}`);
console.error(`Frames: ${ROOT}/frame-*.jpg`);
