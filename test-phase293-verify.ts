/**
 * Phase 293 verification: production findCursorByShape with the new
 * brightThreshold option set to 120.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';

interface Frame { path: string; cursorVis: { x: number; y: number }; label: string }

const FRAMES: Frame[] = [
  { path: './data/phase292-postflight/2026-05-12_20-23-16/t05-settled.jpg', cursorVis: { x: 1080, y: 858 }, label: 'phase292 t05 LIGHT cursor (pointer-effect)' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0005.jpg', cursorVis: { x: 970, y: 798 }, label: 'phase286 f0005 cursor right of Settings' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0007.jpg', cursorVis: { x: 934, y: 808 }, label: 'phase286 f0007 cursor over Settings' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0008.jpg', cursorVis: { x: 920, y: 815 }, label: 'phase286 f0008 cursor near Settings' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0014.jpg', cursorVis: { x: 806, y: 839 }, label: 'phase286 f0014 mid-drift' },
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg', cursorVis: { x: 733, y: 777 }, label: 'phase280 f023' },
];

async function decode(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

const RADIUS = Number(process.env.RADIUS ?? '100');
console.error('Comparing: dark-only (current production) vs dark+bright (Phase 293 new path)');
console.error(`Locality: radius ${RADIUS} from TRUE cursor position`);
console.error('');

let darkHit = 0, dualHit = 0;
for (const frame of FRAMES) {
  const buf = await fs.readFile(frame.path);
  const { rgb, width, height } = await decode(buf);

  const darkOnly = findCursorByShape(rgb, width, height, {
    expectedNear: frame.cursorVis,
    expectedNearRadius: RADIUS,
  });
  const dual = findCursorByShape(rgb, width, height, {
    expectedNear: frame.cursorVis,
    expectedNearRadius: RADIUS,
    brightThreshold: 120,
  });

  const darkDist = darkOnly ? Math.hypot(darkOnly.centroidX - frame.cursorVis.x, darkOnly.centroidY - frame.cursorVis.y) : Infinity;
  const dualDist = dual ? Math.hypot(dual.centroidX - frame.cursorVis.x, dual.centroidY - frame.cursorVis.y) : Infinity;

  if (darkDist <= 30) darkHit++;
  if (dualDist <= 30) dualHit++;

  console.error(`${path.basename(frame.path).padEnd(15)} | dark: ${darkOnly ? `(${Math.round(darkOnly.centroidX)},${Math.round(darkOnly.centroidY)}) d=${darkDist.toFixed(0)} s=${darkOnly.shapeScore.toFixed(2)}` : 'null'.padEnd(35)}   |   dual: ${dual ? `(${Math.round(dual.centroidX)},${Math.round(dual.centroidY)}) d=${dualDist.toFixed(0)} s=${dual.shapeScore.toFixed(2)}` : 'null'}`);
}
console.error(`\nWithin 30 px of truth: dark=${darkHit}/${FRAMES.length}  dual=${dualHit}/${FRAMES.length}`);
process.exit(0);
