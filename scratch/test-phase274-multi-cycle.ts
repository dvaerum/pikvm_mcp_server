/**
 * Phase 274: multi-cycle averaged shape detection.
 *
 * Cron preference 2 explicitly lists "multi-cycle averaging" as an
 * acceptable cursor-shape-detect improvement. Phase 272 found that
 * a single-frame shape-detect can produce confident-wrong dock-area
 * picks (trial 1: shape agreed with motion-diff at (774, 960) dock).
 *
 * Multi-cycle hypothesis: capture 5 screenshots in rapid succession,
 * run shape on each. If the cursor's TRUE position is consistent
 * but TRANSIENT noise (dock animation, fade artefacts, etc.) varies
 * across frames, the median position filters out noise.
 *
 * Procedure:
 *   1. Move cursor to far target (757, 832) via moveToPixel
 *   2. Take 5 screenshots in rapid succession (300 ms apart)
 *   3. Run findCursorByShape with locality hint on each frame
 *   4. Compute median X and Y of the 5 returned positions
 *   5. Compare median to each single-frame answer
 *
 * Outputs whether multi-cycle would have provided a different (better)
 * answer than any single frame.
 *
 * Single-cycle outcome from Phase 272 (3 trials):
 *   T1: (774, 960) — dock area, confident-wrong
 *   T2: (771, 766) — correct cursor area, 67 px residual
 *   T3: (774, 766) — correct cursor area, 68 px residual
 *
 * If multi-cycle median in T1 differs from (774, 960) and converges
 * toward (771, 766) area, multi-cycle is a real improvement.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase274-multi-cycle/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 274 multi-cycle median at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 757, y: 832 };
const N_TRIALS = 3;
const N_FRAMES_PER_TRIAL = 5;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

for (let i = 1; i <= N_TRIALS; i++) {
  console.error(`\n========== Trial ${i}/${N_TRIALS} ==========`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  // Move via production moveToPixel (single-cycle as production does)
  let moveDetected: { x: number; y: number } | null = null;
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    if (r.finalDetectedPosition) {
      moveDetected = { x: r.finalDetectedPosition.x, y: r.finalDetectedPosition.y };
    }
  } catch (e) {
    console.error(`  moveToPixel threw: ${(e as Error).message.slice(0, 100)}`);
  }
  console.error(`  moveToPixel final: ${moveDetected ? `(${moveDetected.x},${moveDetected.y})` : 'null'}`);

  // Now: 5 rapid screenshots, each with keepalive
  const positions: { x: number; y: number; score: number }[] = [];
  for (let f = 1; f <= N_FRAMES_PER_TRIAL; f++) {
    const shot = await client.screenshotKeepingCursorAlive();
    await fs.writeFile(`${ROOT}/t${i}-f${f}.jpg`, shot.buffer);
    const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = findCursorByShape(dec.data, dec.info.width, dec.info.height, {
      expectedNear: moveDetected ?? TARGET,
      expectedNearRadius: 150,
    });
    if (r) {
      positions.push({ x: Math.round(r.centroidX), y: Math.round(r.centroidY), score: r.shapeScore });
    } else {
      positions.push({ x: NaN, y: NaN, score: 0 });
    }
    await sleep(300);
  }

  console.error(`  5 single-frame shape detections (hint at ${moveDetected ? `move-final` : 'TARGET'}):`);
  for (const [j, p] of positions.entries()) {
    console.error(`    f${j + 1}: ${isNaN(p.x) ? '(null)         ' : `(${p.x.toString().padStart(4)},${p.y.toString().padStart(4)}) s${p.score.toFixed(3)}`}`);
  }

  const validXs = positions.filter(p => !isNaN(p.x)).map(p => p.x);
  const validYs = positions.filter(p => !isNaN(p.y)).map(p => p.y);
  if (validXs.length >= 1) {
    const mx = Math.round(median(validXs));
    const my = Math.round(median(validYs));
    const meanX = Math.round(validXs.reduce((a, b) => a + b, 0) / validXs.length);
    const meanY = Math.round(validYs.reduce((a, b) => a + b, 0) / validYs.length);
    const rangeX = Math.max(...validXs) - Math.min(...validXs);
    const rangeY = Math.max(...validYs) - Math.min(...validYs);

    console.error(`  ${validXs.length}/${N_FRAMES_PER_TRIAL} frames returned a candidate`);
    console.error(`  median: (${mx}, ${my})  mean: (${meanX}, ${meanY})  range: ${rangeX}×${rangeY} px`);

    const medianResidual = Math.hypot(mx - TARGET.x, my - TARGET.y);
    const singleResidual = !isNaN(positions[0].x)
      ? Math.hypot(positions[0].x - TARGET.x, positions[0].y - TARGET.y)
      : null;
    console.error(`  residual to target: median=${medianResidual.toFixed(0)} px, single-frame[1]=${singleResidual !== null ? singleResidual.toFixed(0) : 'n/a'} px`);

    // Does the median differ meaningfully from any single-frame answer?
    const medianVsSingleFrame = positions.map(p =>
      isNaN(p.x) ? null : Math.hypot(p.x - mx, p.y - my)
    );
    console.error(`  median vs each frame: ${medianVsSingleFrame.map(d => d !== null ? d.toFixed(0) + ' px' : 'n/a').join(', ')}`);
  }
}

console.error(`\n=== INTERPRETATION ===`);
console.error(`If 5/5 frames per trial returned positions within ~5 px of each other:`);
console.error(`  → multi-cycle adds nothing (positions are stable across frames)`);
console.error(`If frames varied by 30+ px range:`);
console.error(`  → multi-cycle median could help filter transient noise`);
console.error(`If trial-1-style dock-area picks were filtered by median:`);
console.error(`  → ship multi-cycle in production fallback`);
console.error(`\nFrames saved to ${ROOT} for visual inspection.`);
process.exit(0);
