/**
 * Check what real cursor scores look like across all our saved
 * frames where cursor is known to be present. Confirms that the
 * 0.10 threshold doesn't filter real cursors.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from './src/pikvm/cursor-detect.js';

const FRAMES: { path: string; hint: { x: number; y: number }; note: string }[] = [
  { path: './data/phase251-topk/trial1.jpg', hint: { x: 1063, y: 778 }, note: 'Phase 251 t1' },
  { path: './data/phase251-topk/trial2.jpg', hint: { x: 1063, y: 778 }, note: 'Phase 251 t2' },
  { path: './data/phase251-topk/trial3.jpg', hint: { x: 1063, y: 778 }, note: 'Phase 251 t3' },
  { path: './data/phase251-topk/trial4.jpg', hint: { x: 1063, y: 778 }, note: 'Phase 251 t4' },
  { path: './data/phase251-topk/trial5.jpg', hint: { x: 1063, y: 778 }, note: 'Phase 251 t5' },
  { path: './data/phase312-acceptance/2026-05-13_04-58-34/mid_left.jpg', hint: { x: 1007, y: 777 }, note: 'Phase 312 mid_left' },
  { path: './data/phase312-acceptance/2026-05-13_04-58-34/mid_upleft.jpg', hint: { x: 1026, y: 653 }, note: 'Phase 312 mid_upleft' },
  { path: './data/phase312-acceptance/2026-05-13_04-58-34/mid_above.jpg', hint: { x: 1150, y: 633 }, note: 'Phase 312 mid_above' },
];

for (const f of FRAMES) {
  try {
    const buf = await fs.readFile(f.path);
    const decoded = await decodeScreenshot(buf);
    // No threshold, with locality hint where cursor visually confirmed to be
    const r = findCursorByShape(decoded.rgb, decoded.width, decoded.height, {
      expectedNear: f.hint,
      expectedNearRadius: 30,
      minShapeScore: 0,
    });
    console.error(`${f.note.padEnd(25)} ${r ? `(${Math.round(r.centroidX)},${Math.round(r.centroidY)}) score=${r.shapeScore.toFixed(4)} pixels=${r.pixels}` : 'NULL'}`);
  } catch (e) {
    console.error(`${f.note}: ERROR ${(e as Error).message}`);
  }
}
