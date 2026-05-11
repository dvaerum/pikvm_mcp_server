/**
 * Phase 280: diagnose WHY and WHEN the cursor disappears during a
 * far-target chunked move.
 *
 * Hypothesis from Phase 279 frame-by-frame: by the final pass of an
 * unsuccessful far-target move, the cursor is no longer visible on
 * screen. Three competing causes:
 *
 *   1. Stationary fade — Phase 256 says fade time ≥10s. A multi-pass
 *      move could exceed that.
 *   2. Edge clamp / off-screen drift — cursor lands at edge and
 *      iPadOS hides it.
 *   3. Dock pointer-effect snap — cursor enters dock row and warps
 *      into an icon hit-area.
 *
 * Methodology:
 *   - unlock + home (cursor lands at far-right ~1180, 805)
 *   - emit 30 small left-chunks (-20 mickeys each) toward far target
 *     direction
 *   - BETWEEN every chunk: take a raw screenshot (no wake nudge) and
 *     run unhinted findCursorByShape across the entire frame
 *   - after the 30 chunks: take 20 more raw screenshots over 2s (no
 *     emit between them) to observe whether the cursor fades over
 *     stationary time
 *   - save every frame + a CSV timeline of (frameIdx, cursorX,
 *     cursorY, shapeScore, pixels) so we can map vanishing to a
 *     specific instant
 *
 * Output classifies the failure:
 *   - Gradual score-drop over stationary frames → fade
 *   - Sudden disappearance at a specific chunk → clamp/snap
 *   - Persistent visibility but moved off into bottom-right corner
 *     → edge-clamp without iPadOS hiding it
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

const ROOT_BASE = './data/phase280-cursor-vanishing';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `${ROOT_BASE}/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface FrameLog {
  frameIdx: number;
  phase: 'pre' | 'mid' | 'still';
  chunkIdx: number;     // -1 for still phase
  cursorX: number | null;
  cursorY: number | null;
  shapeScore: number | null;
  pixels: number | null;
  msFromStart: number;
}

console.error(`=== Phase 280 cursor-vanishing diagnostic at v${VERSION} ===`);
console.error(`Root: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);

const log: FrameLog[] = [];
const tStart = Date.now();

// Phase 280-v2: match PRODUCTION screenshot behaviour. Phase 216's
// `takeRawScreenshot` does a ±1 px wake nudge before capture; that's
// what motion-diff and shape-detect see during real moveToPixel runs.
// Use the wake-aware variant here so the diagnostic measures the same
// conditions Phase 279's failing trials experienced.
const USE_WAKE = process.env.PHASE280_NO_WAKE !== '1';
console.error(`Wake-nudge: ${USE_WAKE ? 'ENABLED (matches production)' : 'DISABLED (raw)'}\n`);

async function snapAndDetect(frameIdx: number, phase: FrameLog['phase'], chunkIdx: number) {
  const shot = USE_WAKE
    ? await client.screenshotKeepingCursorAlive()
    : await client.screenshot();
  await fs.writeFile(`${ROOT}/f${frameIdx.toString().padStart(3, '0')}.jpg`, shot.buffer);

  const dec = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const cand = findCursorByShape(dec.data, dec.info.width, dec.info.height);

  const entry: FrameLog = {
    frameIdx,
    phase,
    chunkIdx,
    cursorX: cand ? Math.round(cand.centroidX) : null,
    cursorY: cand ? Math.round(cand.centroidY) : null,
    shapeScore: cand ? Math.round(cand.shapeScore * 1000) / 1000 : null,
    pixels: cand ? cand.pixels : null,
    msFromStart: Date.now() - tStart,
  };
  log.push(entry);

  const cursorTxt = entry.cursorX !== null
    ? `(${entry.cursorX},${entry.cursorY}) score=${entry.shapeScore} px=${entry.pixels}`
    : 'MISSING';
  console.error(
    `  f${frameIdx.toString().padStart(3, '0')} [${phase}] chunk=${chunkIdx.toString().padStart(2)} ` +
    `t=${entry.msFromStart.toString().padStart(5)}ms  ${cursorTxt}`,
  );
}

let frameIdx = 0;
const CHUNK_COUNT = 30;
const CHUNK_MICKEYS = -20; // leftward
const PRE_EMIT_SLEEP_MS = 100;
const POST_EMIT_SLEEP_MS = 200;

console.error(`Phase 1: chunked emit + screenshot per chunk (${CHUNK_COUNT} chunks of ${CHUNK_MICKEYS}x mickeys)\n`);

// Baseline frame before any emit
await snapAndDetect(frameIdx++, 'pre', 0);

for (let chunkIdx = 1; chunkIdx <= CHUNK_COUNT; chunkIdx++) {
  await client.mouseMoveRelative(CHUNK_MICKEYS, 0);
  await sleep(POST_EMIT_SLEEP_MS);
  await snapAndDetect(frameIdx++, 'mid', chunkIdx);
}

console.error(`\nPhase 2: still period — 20 screenshots over 2s, no emit between them\n`);

const STILL_FRAMES = 20;
const STILL_INTERVAL_MS = 100;
for (let i = 1; i <= STILL_FRAMES; i++) {
  await snapAndDetect(frameIdx++, 'still', -1);
  if (i < STILL_FRAMES) await sleep(STILL_INTERVAL_MS);
}

// Write timeline CSV
const csv = [
  'frameIdx,phase,chunkIdx,cursorX,cursorY,shapeScore,pixels,msFromStart',
  ...log.map(e => `${e.frameIdx},${e.phase},${e.chunkIdx},${e.cursorX ?? ''},${e.cursorY ?? ''},${e.shapeScore ?? ''},${e.pixels ?? ''},${e.msFromStart}`),
].join('\n');
await fs.writeFile(`${ROOT}/timeline.csv`, csv);

// Aggregate: find first 'missing' frame and last 'visible' frame
const visible = log.filter(e => e.cursorX !== null);
const missing = log.filter(e => e.cursorX === null);
const lastVisible = visible[visible.length - 1] ?? null;
const firstMissing = missing.find(m => lastVisible !== null && m.frameIdx > lastVisible.frameIdx) ?? null;

console.error(`\n\n=== AGGREGATE ===`);
console.error(`Version:  ${VERSION}`);
console.error(`Total frames: ${log.length}`);
console.error(`Visible:  ${visible.length}/${log.length}`);
console.error(`Missing:  ${missing.length}/${log.length}`);

if (lastVisible) {
  console.error(`\nLast visible frame: f${lastVisible.frameIdx} [${lastVisible.phase}] chunk=${lastVisible.chunkIdx}`);
  console.error(`  position: (${lastVisible.cursorX},${lastVisible.cursorY}) score=${lastVisible.shapeScore}`);
  console.error(`  t=${lastVisible.msFromStart}ms`);
}
if (firstMissing) {
  console.error(`\nFirst missing after visible: f${firstMissing.frameIdx} [${firstMissing.phase}] chunk=${firstMissing.chunkIdx}`);
  console.error(`  t=${firstMissing.msFromStart}ms`);
  if (lastVisible) {
    console.error(`  gap-from-last-visible: ${firstMissing.msFromStart - lastVisible.msFromStart}ms`);
  }
}

// Score-trend analysis on visible frames
if (visible.length >= 3) {
  const scores = visible.map(v => v.shapeScore!);
  const first3avg = scores.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const last3avg = scores.slice(-3).reduce((a, b) => a + b, 0) / 3;
  console.error(`\nScore trend (visible frames only):`);
  console.error(`  first 3 frames avg score: ${first3avg.toFixed(3)}`);
  console.error(`  last 3 frames avg score:  ${last3avg.toFixed(3)}`);
  console.error(`  trend: ${last3avg < first3avg * 0.7 ? 'DECLINING (consistent with fade)' : 'stable (rules out fade)'}`);
}

// Classify
console.error(`\n=== CLASSIFICATION ===`);
if (missing.length === 0) {
  console.error('Cursor never vanished — cannot reproduce Phase 279 finding.');
} else if (firstMissing && firstMissing.phase === 'still') {
  console.error('Cursor visible during emits but vanishes in still period → FADE');
} else if (firstMissing && firstMissing.phase === 'mid' && lastVisible && lastVisible.cursorX !== null) {
  const movedDuringVanish = Math.abs(firstMissing.chunkIdx - lastVisible.chunkIdx);
  if (movedDuringVanish === 1) {
    if (lastVisible.cursorY > 900) {
      console.error('Cursor vanished suddenly while crossing into dock area → DOCK SNAP');
    } else if (lastVisible.cursorX < 50 || lastVisible.cursorX > 1230 || lastVisible.cursorY < 50 || lastVisible.cursorY > 1010) {
      console.error('Cursor vanished suddenly at screen edge → EDGE CLAMP');
    } else {
      console.error('Cursor vanished suddenly mid-screen → unexpected; inspect frames');
    }
  } else {
    console.error('Cursor vanished gradually across multiple chunks → possible fade-during-emit');
  }
}

console.error(`\nFull frame set: ${ROOT}`);
console.error(`Timeline CSV:   ${ROOT}/timeline.csv`);
process.exit(0);
