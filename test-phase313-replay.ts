/**
 * Phase 313 replay: re-run findCursorByShape on Phase 312 frames
 * with v0.5.236's minimum-score gate. The 2 calendar-widget-FP
 * trials should now return null (score below 0.10 threshold).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from './src/pikvm/cursor-detect.js';

const DIR = './data/phase312-acceptance/2026-05-13_04-58-34';
const files = ['mid_above.jpg', 'mid_left.jpg', 'mid_below.jpg', 'mid_upleft.jpg', 'mid_upright.jpg'];

for (const f of files) {
  const buf = await fs.readFile(path.join(DIR, f));
  const decoded = await decodeScreenshot(buf);
  const r = findCursorByShape(decoded.rgb, decoded.width, decoded.height);
  const r0 = findCursorByShape(decoded.rgb, decoded.width, decoded.height, { minShapeScore: 0 });
  console.error(
    `${f.padEnd(20)} default(min=0.10): ${r ? `(${Math.round(r.centroidX)},${Math.round(r.centroidY)}) s=${r.shapeScore.toFixed(3)}` : 'NULL'} ` +
    `min=0: ${r0 ? `(${Math.round(r0.centroidX)},${Math.round(r0.centroidY)}) s=${r0.shapeScore.toFixed(3)}` : 'NULL'}`,
  );
}
