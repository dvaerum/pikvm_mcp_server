/**
 * Phase 293: probe whether cursor-shape-detect can find the cursor
 * when the locality hint is CORRECTLY centered, on Phase 292 settled
 * frames.
 *
 * Phase 292 showed shape-detect picks dock-FP at (783, 961) when
 * locality is at belief.position. But belief was drifted by motion-
 * diff false positives. The question: if locality were centered on
 * the cursor's TRUE position (visually verified from frames), would
 * shape-detect find it?
 *
 * If yes → fixing locality hint (don't trust bogus belief) would
 * unblock cursor-shape-detect.
 * If no → the cursor is genuinely not a shape-detect candidate
 * (pointer-effect snap / fade), no scoring fix can help.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  findCursorByShape,
  findCursorShapeCandidates,
} from './src/pikvm/cursor-shape-detect.js';

// Visually verified cursor positions in Phase 292 settled frames.
// Open each t0X-settled.jpg and approximate the dark arrow position.
// Frames where I can identify the cursor (others may have faded).
interface Frame {
  path: string;
  cursorVis: { x: number; y: number } | 'faded' | 'unknown';
  note: string;
}

const PH292_DIR = './data/phase292-postflight/2026-05-12_20-23-16';
const FRAMES: Frame[] = [
  { path: `${PH292_DIR}/t01-settled.jpg`, cursorVis: 'unknown', note: '' },
  { path: `${PH292_DIR}/t02-settled.jpg`, cursorVis: 'unknown', note: '' },
  { path: `${PH292_DIR}/t05-settled.jpg`, cursorVis: { x: 1075, y: 858 }, note: 'visually identified — small arrow right of Settings, slightly below' },
  { path: `${PH292_DIR}/t10-settled.jpg`, cursorVis: 'unknown', note: '' },
];

async function decode(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

for (const frame of FRAMES) {
  const name = path.basename(frame.path);
  console.error(`\n=== ${name} (cursor: ${typeof frame.cursorVis === 'string' ? frame.cursorVis : `(${frame.cursorVis.x},${frame.cursorVis.y})`}) ===`);
  console.error(frame.note ? `  ${frame.note}` : '');

  const buf = await fs.readFile(frame.path);
  const { rgb, width, height } = await decode(buf);

  // 1. Unhinted top-10
  const unhinted = findCursorShapeCandidates(rgb, width, height, 10);
  console.error('  Unhinted top-10:');
  for (let i = 0; i < unhinted.length; i++) {
    const c = unhinted[i];
    console.error(`    ${i + 1}. (${Math.round(c.centroidX)},${Math.round(c.centroidY)}) score=${c.shapeScore.toFixed(3)} px=${c.pixels}`);
  }

  // 2. If cursorVis known: hinted at true cursor position with radius 100
  if (typeof frame.cursorVis !== 'string') {
    const hinted = findCursorByShape(rgb, width, height, {
      expectedNear: frame.cursorVis,
      expectedNearRadius: 100,
    });
    console.error(`  Hinted at TRUE cursor (${frame.cursorVis.x},${frame.cursorVis.y}) r=100:`);
    if (hinted) {
      const dist = Math.hypot(hinted.centroidX - frame.cursorVis.x, hinted.centroidY - frame.cursorVis.y);
      console.error(`    pick: (${Math.round(hinted.centroidX)},${Math.round(hinted.centroidY)}) score=${hinted.shapeScore.toFixed(3)} dist=${dist.toFixed(0)}px`);
    } else {
      console.error('    null — no candidate within 100 px of true cursor');
    }
    // Also try wider locality
    const wideHinted = findCursorByShape(rgb, width, height, {
      expectedNear: frame.cursorVis,
      expectedNearRadius: 50,
    });
    console.error(`  Hinted at TRUE cursor r=50:`);
    if (wideHinted) {
      const dist = Math.hypot(wideHinted.centroidX - frame.cursorVis.x, wideHinted.centroidY - frame.cursorVis.y);
      console.error(`    pick: (${Math.round(wideHinted.centroidX)},${Math.round(wideHinted.centroidY)}) score=${wideHinted.shapeScore.toFixed(3)} dist=${dist.toFixed(0)}px`);
    } else {
      console.error('    null — no candidate within 50 px of true cursor');
    }
  }
}
process.exit(0);
