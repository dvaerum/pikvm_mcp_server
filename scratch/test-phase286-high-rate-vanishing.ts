/**
 * Phase 286: high-rate cursor-vanishing diagnostic.
 *
 * Question to answer: when the cursor disappears during a far-target
 * chunked move, IS IT
 *   (a) gradual fade (iPadOS stationary timeout)
 *   (b) sudden clamp/off-screen at an edge
 *   (c) sudden mid-screen snap (dock pointer-effect or similar)
 * ?
 *
 * Methodology:
 *   - unlock + home (cursor at far-right after swipe, ~1180,805)
 *   - drift toward target (757, 832) via small ~25 mickey chunks
 *   - between each chunk: take a screenshot AND run BOTH detectors
 *     (shape-detect unhinted + NCC against current template set with
 *     a wide locality hint that follows the previous detection)
 *   - log every frame: timestamp, emit_index, shape position+score,
 *     ncc position+score, both vs the predicted ballistic position
 *   - save every frame + JSON timeline + a markdown summary
 *
 * Classification rules (from the timeline):
 *   - Cursor "vanishes" = both detectors disagree with each other and
 *     with the ballistic prediction by > 100 px, OR shape returns null
 *   - Gradual fade: shape score declines steadily over multiple frames
 *     while the cursor is reported at a stationary position
 *   - Edge clamp: cursor is reported at x >= 1180 OR y >= 990 for
 *     multiple frames, then becomes undetectable
 *   - Dock snap: cursor enters y in [900, 1000] band and detector
 *     output suddenly shifts to a discrete (icon-centric) position
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import {
  decodeScreenshot,
  findCursorByTemplateSet,
} from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT_BASE = './data/phase286-high-rate-vanishing';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `${ROOT_BASE}/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const TARGET = { x: 757, y: 832 }; // far target — Books
const CHUNK_MICKEYS = 25; // small chunks for fine-grained tracking
const SLEEP_BETWEEN_EMITS_MS = 80; // ~12 fps

console.error(`=== Phase 286 high-rate vanishing diagnostic at v${VERSION} ===\n`);
console.error(`Root: ${ROOT}`);
console.error(`Target: (${TARGET.x}, ${TARGET.y}) — Books, far`);
console.error(`Chunk: ${CHUNK_MICKEYS} mickeys`);
console.error(`Sleep between emits: ${SLEEP_BETWEEN_EMITS_MS}ms\n`);

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, undefined, null);
console.error(`Loaded ${templates.length} cursor templates\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1200);
console.error('Unlocked + homed\n');

interface FrameLog {
  frameIdx: number;
  emitIdx: number;
  msFromStart: number;
  totalMickeysX: number;
  totalMickeysY: number;
  shape: { x: number; y: number; score: number; pixels: number } | null;
  ncc: { x: number; y: number; score: number; tplIdx: number } | null;
  agreementPx: number | null; // distance between shape and ncc when both present
}
const log: FrameLog[] = [];

// Start with cursor at right edge ~(1180, 805). Drive toward target
// (757, 832) via small chunks. Track every frame.
const dxPerChunk = -CHUNK_MICKEYS; // leftward
const dyPerChunk = +CHUNK_MICKEYS / 4; // small downward bias toward target y

let totalDx = 0;
let totalDy = 0;
let frameIdx = 0;
let lastKnownPosition: { x: number; y: number } | null = null;

// Predicted cursor position after N emits — used as locality hint.
// Assume ~1.4 px/mickey (typical iPad ratio). Start position ~(1180, 805).
function predictedPosition(dxTotal: number, dyTotal: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1240, Math.round(1180 + dxTotal * 1.4))),
    y: Math.max(0, Math.min(1000, Math.round(805 + dyTotal * 1.4))),
  };
}

const tStart = Date.now();

async function snap(emitIdx: number): Promise<void> {
  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(path.join(ROOT, `f${frameIdx.toString().padStart(4, '0')}.jpg`), shot.buffer);

  const rgb = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = await decodeScreenshot(shot.buffer);

  const shape = findCursorByShape(rgb.data, rgb.info.width, rgb.info.height);
  const predicted = predictedPosition(totalDx, totalDy);
  const hint = lastKnownPosition ?? predicted;
  const nccRaw = findCursorByTemplateSet(decoded, templates, {
    expectedNear: hint,
    expectedNearRadius: 200, // generous so we can see what NCC finds
    minScore: 0,
  });

  const shapePos = shape
    ? { x: Math.round(shape.centroidX), y: Math.round(shape.centroidY), score: Math.round(shape.shapeScore * 1000) / 1000, pixels: shape.pixels }
    : null;
  const nccPos = nccRaw
    ? { x: nccRaw.position.x, y: nccRaw.position.y, score: Math.round(nccRaw.score * 1000) / 1000, tplIdx: nccRaw.templateIndex }
    : null;

  let agreement: number | null = null;
  if (shapePos && nccPos) {
    agreement = Math.round(Math.hypot(shapePos.x - nccPos.x, shapePos.y - nccPos.y));
  }

  // Update lastKnownPosition only when both agree closely OR shape has
  // very high score with sensible position.
  if (agreement !== null && agreement <= 50) {
    lastKnownPosition = { x: shapePos!.x, y: shapePos!.y };
  } else if (shapePos && shapePos.score >= 1.5 && shapePos.y > 400 && shapePos.y < 1000) {
    // shape-detect alone if confident and not in clock-widget area
    lastKnownPosition = { x: shapePos.x, y: shapePos.y };
  }

  const entry: FrameLog = {
    frameIdx,
    emitIdx,
    msFromStart: Date.now() - tStart,
    totalMickeysX: totalDx,
    totalMickeysY: totalDy,
    shape: shapePos,
    ncc: nccPos,
    agreementPx: agreement,
  };
  log.push(entry);

  const shapeTxt = shapePos
    ? `s=(${shapePos.x},${shapePos.y})/${shapePos.score}/p${shapePos.pixels}`
    : 's=null';
  const nccTxt = nccPos ? `n=(${nccPos.x},${nccPos.y})/${nccPos.score}` : 'n=null';
  const agreeTxt = agreement !== null ? `agree=${agreement}` : '       ';

  console.error(
    `  f${frameIdx.toString().padStart(3, '0')}@e${emitIdx.toString().padStart(2, '0')} t=${entry.msFromStart.toString().padStart(5)}ms tot=(${totalDx},${totalDy}) pred=(${predicted.x},${predicted.y}) ${shapeTxt.padEnd(30)} ${nccTxt.padEnd(20)} ${agreeTxt}`,
  );

  frameIdx++;
}

console.error('Phase A: baseline frame before any emit');
await snap(0);

console.error('\nPhase B: rapid chunked drift toward far target');
const TOTAL_EMITS = 40;
for (let i = 1; i <= TOTAL_EMITS; i++) {
  await client.mouseMoveRelative(dxPerChunk, dyPerChunk);
  totalDx += dxPerChunk;
  totalDy += dyPerChunk;
  await sleep(SLEEP_BETWEEN_EMITS_MS);
  await snap(i);
}

console.error('\nPhase C: still period — 20 frames over ~2s, no emits');
const STILL_FRAMES = 20;
for (let i = 1; i <= STILL_FRAMES; i++) {
  await snap(TOTAL_EMITS); // emitIdx stays at TOTAL_EMITS
  if (i < STILL_FRAMES) await sleep(100);
}

await fs.writeFile(path.join(ROOT, 'timeline.json'), JSON.stringify(log, null, 2));

const csv = [
  'frameIdx,emitIdx,msFromStart,totalMickeysX,totalMickeysY,shapeX,shapeY,shapeScore,shapePixels,nccX,nccY,nccScore,nccTplIdx,agreementPx',
  ...log.map(e => `${e.frameIdx},${e.emitIdx},${e.msFromStart},${e.totalMickeysX},${e.totalMickeysY},${e.shape?.x ?? ''},${e.shape?.y ?? ''},${e.shape?.score ?? ''},${e.shape?.pixels ?? ''},${e.ncc?.x ?? ''},${e.ncc?.y ?? ''},${e.ncc?.score ?? ''},${e.ncc?.tplIdx ?? ''},${e.agreementPx ?? ''}`),
].join('\n');
await fs.writeFile(path.join(ROOT, 'timeline.csv'), csv);

// === Classification ===
console.error('\n\n=== CLASSIFICATION ===');

// Define "cursor confidently tracked" as: shape & ncc agree within 50 px
// AND both have non-null positions.
const tracked = log.filter(e => e.agreementPx !== null && e.agreementPx <= 50);
const lost = log.filter(e => e.agreementPx === null || e.agreementPx > 100);

console.error(`Total frames: ${log.length}`);
console.error(`Tracked (s+n agree ≤50px): ${tracked.length}`);
console.error(`Lost (no agreement >100px): ${lost.length}`);

if (tracked.length > 0) {
  const lastTracked = tracked[tracked.length - 1];
  console.error(`\nLast tracked frame: f${lastTracked.frameIdx} @ emit ${lastTracked.emitIdx}, t=${lastTracked.msFromStart}ms`);
  console.error(`  Cursor position: shape=(${lastTracked.shape!.x},${lastTracked.shape!.y}) ncc=(${lastTracked.ncc!.x},${lastTracked.ncc!.y})`);
  console.error(`  Distance from target: ${Math.hypot(lastTracked.shape!.x - TARGET.x, lastTracked.shape!.y - TARGET.y).toFixed(0)} px`);

  // What happens AFTER the last tracked frame?
  const afterLastTracked = log.filter(e => e.frameIdx > lastTracked.frameIdx);
  if (afterLastTracked.length > 0) {
    const nextTransition = afterLastTracked[0];
    console.error(`\nFirst frame AFTER loss: f${nextTransition.frameIdx} @ emit ${nextTransition.emitIdx}, t=${nextTransition.msFromStart}ms`);
    const gapMs = nextTransition.msFromStart - lastTracked.msFromStart;
    console.error(`  Gap since last tracked: ${gapMs}ms`);
    if (gapMs < 200 && lastTracked.shape && (lastTracked.shape.y >= 900 || lastTracked.shape.x >= 1200 || lastTracked.shape.x <= 50)) {
      console.error(`  → SUDDEN at edge/dock: cursor was at (${lastTracked.shape.x},${lastTracked.shape.y}) — likely EDGE CLAMP or DOCK SNAP`);
    } else if (gapMs < 200) {
      console.error(`  → SUDDEN mid-screen: cursor was at (${lastTracked.shape.x},${lastTracked.shape.y}) — likely DOCK POINTER-EFFECT SNAP or detector flake`);
    } else {
      console.error(`  → GRADUAL: ${gapMs}ms gap suggests progressive fade or multi-frame detector confusion`);
    }
  }

  // Score trend on shape-detect over tracked frames
  if (tracked.length >= 5) {
    const firstN = tracked.slice(0, Math.min(5, tracked.length)).map(t => t.shape!.score);
    const lastN = tracked.slice(-Math.min(5, tracked.length)).map(t => t.shape!.score);
    const firstAvg = firstN.reduce((a, b) => a + b, 0) / firstN.length;
    const lastAvg = lastN.reduce((a, b) => a + b, 0) / lastN.length;
    console.error(`\nShape-score trend over tracked frames:`);
    console.error(`  first ${firstN.length} avg: ${firstAvg.toFixed(3)}`);
    console.error(`  last ${lastN.length} avg: ${lastAvg.toFixed(3)}`);
    if (lastAvg < firstAvg * 0.5) {
      console.error(`  → Score halved — consistent with FADE`);
    } else if (lastAvg > firstAvg * 0.7) {
      console.error(`  → Score stable — rules out fade as primary cause`);
    } else {
      console.error(`  → Modest decline — ambiguous`);
    }
  }
} else {
  console.error('No tracked frames — cursor never confidently localized. Either templates broken or iPad in unexpected state.');
}

console.error(`\nFrame set: ${ROOT}`);
console.error(`Timeline CSV: ${ROOT}/timeline.csv`);
process.exit(0);
