/**
 * Phase 289: shape-detect diagnostic — score-component breakdown.
 *
 * Goal: identify the gap between cursor candidate and clock-widget FP
 * in shape-detect's ranking. Phase 286 found shape-detect locks onto
 * clock at 2.0-2.5 while cursor scored 0.3-1.5 on wallpaper.
 *
 * Re-runs shape-detect on saved Phase 280 / 286 frames with the
 * locality gate OFF and k=30. Reports per-candidate:
 *   pixels, asymmetry, centroidOffset, aspectRatio, chroma,
 *   sizeFit, asymFactor, offsetFactor, aspectFactor, chromaFactor,
 *   shapeScore, tag (cursor / clock-area / icon / unknown)
 *
 * Cursor ground truth is hard-coded per frame (visually verified
 * Phase 286 doc + visual inspection of f023).
 *
 * Output: a table sorted by shapeScore desc. Then a focused summary:
 *   "Cursor rank: 3 of 17 (score 0.84). Clock-area ranks: 1, 2 (scores
 *    2.1, 1.95)."
 *
 * This tells us which score components let the clock beat the cursor,
 * so the next phase can target the right discriminator.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { findClusters, mergeClusters } from './src/pikvm/cursor-detect.js';

interface Frame {
  path: string;
  cursorGt: { x: number; y: number };
  label: string;
}

// Frames where the cursor is plainly visible per visual inspection.
const FRAMES: Frame[] = [
  // f0005: cursor near right edge, just past Settings icon
  {
    path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0005.jpg',
    cursorGt: { x: 970, y: 798 },
    label: 'Phase 286 f0005 (cursor right of Settings)',
  },
  // f0007: cursor over Settings icon (Phase 286 doc says top-1 there)
  {
    path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0007.jpg',
    cursorGt: { x: 934, y: 808 },
    label: 'Phase 286 f0007 (cursor over Settings)',
  },
  // f0008: cursor still near Settings but clock won (per scan)
  {
    path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0008.jpg',
    cursorGt: { x: 920, y: 815 },
    label: 'Phase 286 f0008 (cursor near Settings, clock wins)',
  },
  // f0014: cursor mid-drift toward Books (cursor wins)
  {
    path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0014.jpg',
    cursorGt: { x: 806, y: 839 },
    label: 'Phase 286 f0014 (mid-drift, cursor wins)',
  },
  // f0020: cursor would be even farther left
  {
    path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0020.jpg',
    cursorGt: { x: -1, y: -1 },
    label: 'Phase 286 f0020 (cursor location unknown)',
  },
  // f0050: late frame, cursor may be at target area
  {
    path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0050.jpg',
    cursorGt: { x: -1, y: -1 },
    label: 'Phase 286 f0050',
  },
];

// Known iPad home-screen regions (rough, used only to tag candidates)
const REGIONS: { name: string; x1: number; y1: number; x2: number; y2: number }[] = [
  { name: 'clock-widget', x1: 580, y1: 90, x2: 740, y2: 220 },
  { name: 'notes-widget', x1: 710, y1: 100, x2: 850, y2: 210 },
  { name: 'maps-widget', x1: 850, y1: 100, x2: 1110, y2: 340 },
  { name: 'calendar-widget', x1: 580, y1: 220, x2: 850, y2: 350 },
  { name: 'weather-widget', x1: 580, y1: 350, x2: 850, y2: 620 },
  { name: 'status-bar', x1: 480, y1: 50, x2: 1180, y2: 80 },
  { name: 'dock', x1: 480, y1: 940, x2: 1180, y2: 1020 },
  { name: 'app-icon-row1', x1: 870, y1: 390, x2: 1080, y2: 480 }, // FaceTime, Files
  { name: 'app-icon-row2', x1: 870, y1: 520, x2: 1080, y2: 610 }, // Reminders, Maps
  { name: 'app-icon-row3', x1: 600, y1: 650, x2: 1080, y2: 740 }, // Home, Camera, AppStore, Games
  { name: 'app-icon-row4', x1: 600, y1: 780, x2: 950, y2: 870 }, // Books, TV, Settings
];

function regionTag(x: number, y: number, cursorGt: { x: number; y: number }): string {
  if (Math.hypot(x - cursorGt.x, y - cursorGt.y) < 25) return 'CURSOR';
  for (const r of REGIONS) {
    if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) return r.name;
  }
  return 'wallpaper';
}

// Re-implement findAllShapeCandidates inline so we can also dump
// the intermediate score components.
async function decodeRgb(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

interface Diag {
  x: number; y: number; pixels: number;
  asymmetry: number; centroidOffset: number; bboxAspectRatio: number; chroma: number;
  bboxW: number; bboxH: number; solidity: number; darkInScan: number;
  sizeFit: number; asymFactor: number; offsetFactor: number; aspectFactor: number; chromaFactor: number;
  shapeScore: number;
}

function analyze(rgb: Buffer, width: number, height: number, scanR: number = 25, darkThr: number = 100): Diag[] {
  const darkThreshold = darkThr;
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    gray[i] = Math.round(rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114);
  }
  const mask: boolean[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) mask[i] = gray[i] < darkThreshold;

  const raw = findClusters(mask, width, height, 15, 250, rgb);
  const merged = mergeClusters(raw, 8);

  const out: Diag[] = [];
  for (const c of merged) {
    const cx = Math.round(c.centroidX);
    const cy = Math.round(c.centroidY);
    const R = scanR;
    let minX = cx, maxX = cx, minY = cy, maxY = cy;
    let qNW = 0, qNE = 0, qSW = 0, qSE = 0;
    let sumR = 0, sumG = 0, sumB = 0, darkCount = 0;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= width) continue;
        if (!mask[y * width + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const ri = (y * width + x) * 3;
        sumR += rgb[ri]; sumG += rgb[ri + 1]; sumB += rgb[ri + 2]; darkCount++;
        if (dx < 0 && dy < 0) qNW++;
        else if (dx >= 0 && dy < 0) qNE++;
        else if (dx < 0 && dy >= 0) qSW++;
        else qSE++;
      }
    }
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const aspectRatio = bboxW / Math.max(1, bboxH);
    const quadMasses = [qNW, qNE, qSW, qSE].sort((a, b) => b - a);
    const asymmetry = quadMasses[3] === 0 ? 0 : quadMasses[0] / Math.max(1, quadMasses[3]);
    const bboxCenterX = (minX + maxX) / 2;
    const bboxCenterY = (minY + maxY) / 2;
    const centroidOffset = Math.hypot(c.centroidX - bboxCenterX, c.centroidY - bboxCenterY);
    let chroma = 0;
    if (darkCount > 0) {
      const mR = sumR / darkCount, mG = sumG / darkCount, mB = sumB / darkCount;
      chroma = Math.max(mR, mG, mB) - Math.min(mR, mG, mB);
    }
    const aspectPenalty = Math.abs(Math.log(Math.max(0.01, aspectRatio)));
    const sizeFit = Math.exp(-Math.pow(c.pixels - 80, 2) / 600);
    const cappedAsym = Math.min(asymmetry, 5);
    const cappedOffset = Math.min(centroidOffset, 10);
    const asymFactor = 1 + cappedAsym / 3;
    const offsetFactor = 1 + cappedOffset / 5;
    const aspectFactor = Math.exp(-aspectPenalty);
    const chromaFactor = Math.exp(-chroma / 20);
    const shapeScore = sizeFit * asymFactor * offsetFactor * aspectFactor * chromaFactor;
    out.push({
      x: Math.round(c.centroidX), y: Math.round(c.centroidY), pixels: c.pixels,
      asymmetry, centroidOffset, bboxAspectRatio: aspectRatio, chroma,
      bboxW, bboxH, solidity: darkCount / Math.max(1, bboxW * bboxH), darkInScan: darkCount,
      sizeFit, asymFactor, offsetFactor, aspectFactor, chromaFactor,
      shapeScore,
    });
  }
  out.sort((a, b) => b.shapeScore - a.shapeScore);
  return out;
}

const SCAN_R = Number(process.env.SCAN_R ?? '25');
const DARK_THR = Number(process.env.DARK_THR ?? '100');
console.error(`Scan radius: ${SCAN_R} px, dark threshold: ${DARK_THR}`);
for (const frame of FRAMES) {
  console.error(`\n=== ${frame.label} ===`);
  console.error(`Cursor GT: (${frame.cursorGt.x}, ${frame.cursorGt.y})`);
  const buf = await fs.readFile(frame.path);
  const { rgb, width, height } = await decodeRgb(buf);
  const diags = analyze(rgb, width, height, SCAN_R, DARK_THR);
  console.error(`${diags.length} candidates total`);
  console.error('rank | xy          | px  | bbox  | sol  | darkS | asym | off  | chroma | score | tag');
  console.error('-----|-------------|-----|-------|------|-------|------|------|--------|-------|----------');
  for (let i = 0; i < Math.min(10, diags.length); i++) {
    const d = diags[i];
    const tag = regionTag(d.x, d.y, frame.cursorGt);
    const line = [
      String(i + 1).padStart(4),
      `(${String(d.x).padStart(4)},${String(d.y).padStart(4)})`,
      String(d.pixels).padStart(4),
      `${String(d.bboxW).padStart(2)}x${String(d.bboxH).padStart(2)}`,
      d.solidity.toFixed(2).padStart(4),
      String(d.darkInScan).padStart(4),
      d.asymmetry.toFixed(1).padStart(5),
      d.centroidOffset.toFixed(1).padStart(4),
      d.chroma.toFixed(1).padStart(5),
      d.shapeScore.toFixed(3).padStart(5),
      tag,
    ].join(' | ');
    console.error(line);
  }
  if (frame.cursorGt.x > 0) {
    const cursorIdx = diags.findIndex(d => Math.hypot(d.x - frame.cursorGt.x, d.y - frame.cursorGt.y) < 30);
    if (cursorIdx >= 0) {
      const c = diags[cursorIdx];
      console.error(`\n  CURSOR rank ${cursorIdx + 1}: bbox=${c.bboxW}x${c.bboxH} sol=${c.solidity.toFixed(2)} darkScan=${c.darkInScan} asym=${c.asymmetry.toFixed(1)} offset=${c.centroidOffset.toFixed(1)} chroma=${c.chroma.toFixed(1)}`);
    } else {
      console.error(`\n  CURSOR NOT in candidate list (no cluster within 30 px of GT).`);
    }
  }
}
process.exit(0);
