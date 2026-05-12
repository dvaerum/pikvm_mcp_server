/**
 * Phase 296: diagnose Books-target Phase 295 misses.
 *
 * Phase 295 Books (642, 810) was 3/20 = 15%. Hypothesis: cursor stays
 * stuck near home (1060, 780) due to emit rate-limiting; shape-detect
 * at p0 searches radius 100 around predictedPostOpen=(642, 810) and
 * doesn't see the home-stuck cursor 400+ px away.
 *
 * Method: N=5 trials, verbose. After moveToPixel return, save the
 * frame, then run an EXTRA shape-detect call unhinted to find the
 * cursor's actual position on the settled frame. Compare:
 *   - moveToPixel's finalDetectedPosition (what the algorithm thinks)
 *   - Unhinted shape-detect on settled frame (where cursor actually is)
 *   - Expected target (642, 810)
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = `./data/phase296-books-diag/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 296 Books diagnostic at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 642, y: 810 };
const N = 5;

async function decode(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  // Pre-frame
  const pre = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-pre.jpg`, pre.buffer);

  let r: Awaited<ReturnType<typeof moveToPixel>> | null = null;
  try {
    r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
  } catch (e) {
    console.error(`  moveToPixel threw: ${(e as Error).message.slice(0, 100)}`);
  }

  await sleep(800);
  // Settled post-frame
  const post = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-post.jpg`, post.buffer);

  // Algorithm's reported state
  const algo = r?.finalDetectedPosition;
  const algoR = r?.finalResidualPx;
  console.error(`  algo: ${algo ? `(${algo.x},${algo.y}) r=${algoR?.toFixed(0)}px` : 'null'}`);
  console.error(`  belief: (${client.belief.position.x.toFixed(0)},${client.belief.position.y.toFixed(0)})`);

  // Unhinted shape-detect: where is the cursor REALLY?
  const { rgb, width, height } = await decode(post.buffer);
  // Dark + bright top-5 candidates
  const cands = findCursorShapeCandidates(rgb, width, height, 5, { brightThreshold: 120 });
  console.error(`  Settled-frame top-5 candidates (dark+bright):`);
  for (let k = 0; k < cands.length; k++) {
    const c = cands[k];
    const distHome = Math.hypot(c.centroidX - 1060, c.centroidY - 780);
    const distTarget = Math.hypot(c.centroidX - TARGET.x, c.centroidY - TARGET.y);
    console.error(`    ${k + 1}. (${Math.round(c.centroidX)},${Math.round(c.centroidY)}) score=${c.shapeScore.toFixed(3)} px=${c.pixels} distHome=${distHome.toFixed(0)} distTarget=${distTarget.toFixed(0)}`);
  }

  // Diagnostic per-pass summary
  if (r) {
    console.error(`  passes (${r.diagnostics.length}):`);
    for (const d of r.diagnostics) {
      console.error(`    p${d.pass} ${d.mode.padEnd(9)} at=${d.detectedAt ? `(${d.detectedAt.x},${d.detectedAt.y})` : 'null'} r=${d.residualPx.toFixed(0)}px`);
    }
  }
}
process.exit(0);
