/**
 * Phase 290 verification: rerun cursor-shape-detect on Phase 286 frames
 * using the new cluster-bbox-aware scoring. Expectation: cursor wins
 * top-1 (or top-2 within locality gate) on visible-cursor frames.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';

interface Frame { path: string; cursorGt: { x: number; y: number }; label: string }
const FRAMES: Frame[] = [
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0005.jpg', cursorGt: { x: 970, y: 798 }, label: 'f0005 cursor right of Settings' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0007.jpg', cursorGt: { x: 934, y: 808 }, label: 'f0007 cursor over Settings' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0008.jpg', cursorGt: { x: 920, y: 815 }, label: 'f0008 cursor near Settings' },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0014.jpg', cursorGt: { x: 806, y: 839 }, label: 'f0014 mid-drift' },
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg', cursorGt: { x: 733, y: 777 }, label: 'phase280 f023' },
];

async function decodeRgb(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

function bench(label: string, hintRadius?: number, hintDist?: number) {
  console.error(`\n--- ${label} ---`);
  let cursorTop1Count = 0;
  let frameCount = 0;
  for (const frame of FRAMES) {
    const buf = readFileSync(frame.path);
    const decoded = sharpDecoded.get(frame.path)!;
    const rgb = decoded.rgb;
    const width = decoded.width;
    const height = decoded.height;
    const opts: { expectedNear?: { x: number; y: number }; expectedNearRadius?: number } = {};
    if (hintRadius !== undefined) {
      // Hint near cursor GT but offset by hintDist to simulate imperfect belief
      opts.expectedNear = { x: frame.cursorGt.x + (hintDist ?? 0), y: frame.cursorGt.y };
      opts.expectedNearRadius = hintRadius;
    }
    const cands = findCursorShapeCandidates(rgb, width, height, 10, opts);
    const cursorIdx = cands.findIndex(c => Math.hypot(c.centroidX - frame.cursorGt.x, c.centroidY - frame.cursorGt.y) < 30);
    const top3 = cands.slice(0, 3).map(c => `(${Math.round(c.centroidX)},${Math.round(c.centroidY)}) ${c.shapeScore.toFixed(2)}`).join(', ');
    console.error(`${path.basename(frame.path)}: cursor rank ${cursorIdx + 1}/${cands.length}; top3: ${top3}`);
    frameCount++;
    if (cursorIdx === 0) cursorTop1Count++;
  }
  console.error(`Cursor top-1: ${cursorTop1Count}/${frameCount}`);
}

const sharpDecoded = new Map<string, { rgb: Buffer; width: number; height: number }>();
const { readFileSync } = await import('fs');
for (const frame of FRAMES) {
  const buf = await fs.readFile(frame.path);
  sharpDecoded.set(frame.path, await decodeRgb(buf));
}

bench('unhinted (no locality gate)');
bench('hinted at GT, radius 200 (production default)', 200, 0);
bench('hinted 100 px off GT, radius 200 (imperfect belief)', 200, 100);
bench('hinted at GT, radius 100 (tight locality)', 100, 0);
process.exit(0);
