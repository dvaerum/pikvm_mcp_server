/**
 * Phase 256 v2: better-designed cursor-fade measurement.
 *
 * v1 used a tiny (50, 50) emit and the cursor wasn't visible in the
 * t0 reference shot at all. v2: emit a series of LARGE continuous
 * motions to ensure the cursor renders, screenshot to confirm visible,
 * then stop emitting and screenshot every 500 ms to find when it fades.
 *
 * The user observed ~7 sec visually. PiKVM HDMI capture may differ
 * from what's rendered on the iPad screen — both numbers are useful.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { decodeScreenshot, diffScreenshotsDecoded } from './src/pikvm/cursor-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase256-fade-v2';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 256 v2 cursor-fade at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

// Drive cursor with continuous emits to make sure it renders
console.error('Step 0: 10 continuous (100, 0) emits at 50ms pace');
for (let i = 0; i < 10; i++) {
  await client.mouseMoveRelative(-30, -30);
  await sleep(50);
}
// Final emit, then immediately capture
console.error('Step 1: final emit + immediate screenshot');
await client.mouseMoveRelative(40, 40);

// Capture at intervals AFTER the final emit
const tStart = Date.now();
const checkpoints = [50, 200, 500, 1000, 2000, 4000, 7000, 10000];
const frames: { t: number; buf: Buffer }[] = [];

for (const checkAt of checkpoints) {
  const sinceLast = Date.now() - tStart;
  if (sinceLast < checkAt) await sleep(checkAt - sinceLast);
  const shot = await client.screenshot();
  const t = Date.now() - tStart;
  frames.push({ t, buf: shot.buffer });
  await fs.writeFile(`${ROOT}/t-${t}ms.jpg`, shot.buffer);
  console.error(`  captured at t+${t}ms (target ${checkAt}ms)`);
}

// Now: pairwise motion-diff between consecutive frames. If cursor
// fades between frame N and N+1, the diff shows pixel changes ONLY
// at the cursor's last known position (small cluster ~80-90 px).
// If diff is dominated by widget animation = cursor not present in
// either frame OR present in both. Need visual inspection to distinguish
// the cases.
console.error('\nPairwise diffs between consecutive frames:');
for (let i = 1; i < frames.length; i++) {
  const a = await decodeScreenshot(frames[i - 1].buf);
  const b = await decodeScreenshot(frames[i].buf);
  const clusters = diffScreenshotsDecoded(a, b, {
    diffThreshold: 30,
    minClusterSize: 15,
    maxClusterSize: 500,  // higher to admit clock-widget motion for inspection
    mergeRadius: 20,
    brightnessFloor: 0,
    maxChannelDelta: 0,
  });
  const total = clusters.reduce((s, c) => s + c.pixels, 0);
  const labels = clusters
    .sort((x, y) => y.pixels - x.pixels)
    .slice(0, 3)
    .map(c => `(${Math.round(c.centroidX)},${Math.round(c.centroidY)}):${c.pixels}px`)
    .join(' ');
  console.error(
    `  t+${frames[i - 1].t}ms → t+${frames[i].t}ms: ${clusters.length} clusters, total=${total}px, top: ${labels || '(none)'}`,
  );
}

console.error('\nFiles for visual inspection:');
console.error(`  ${ROOT}/t-{${frames.map(f => f.t).join(',')}}ms.jpg`);
process.exit(0);
