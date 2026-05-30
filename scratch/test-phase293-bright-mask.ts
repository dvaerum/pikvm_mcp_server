/**
 * Phase 293: validate that an INVERTED brightness mask catches the
 * iPadOS pointer-effect cursor (light gray over wallpaper).
 *
 * Phase 292 settled frames have the cursor as a LIGHT cluster (~100-
 * 200 brightness) over MEDIUM wallpaper (~50-100). The production
 * darkThreshold=100 catches wallpaper, not cursor. An inverted mask
 * (brightness > some threshold) should catch the cursor.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { findClusters, mergeClusters } from '../src/pikvm/cursor-detect.js';
import { shapeScoreFor } from '../src/pikvm/cursor-shape-detect.js';

async function decode(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

function findBrightClusters(rgb: Buffer, width: number, height: number, brightThr: number, minPx: number, maxPx: number) {
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    gray[i] = Math.round(rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114);
  }
  const mask: boolean[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) mask[i] = gray[i] > brightThr;
  const raw = findClusters(mask, width, height, minPx, maxPx, rgb, { keepMembers: true });
  const merged = mergeClusters(raw, 8);
  return merged;
}

const FRAMES = [
  // Phase 292: cursor barely moved, in pointer-effect-like state (light gray)
  { path: './data/phase292-postflight/2026-05-12_20-23-16/t05-settled.jpg', cursorVis: { x: 1080, y: 858 } },
  // Phase 286: cursor in motion (darker rendering on busy wallpaper)
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0007.jpg', cursorVis: { x: 934, y: 808 } },
  { path: './data/phase286-high-rate-vanishing/2026-05-12_06-11-58/f0014.jpg', cursorVis: { x: 806, y: 839 } },
  // Phase 280: cursor between Books and TV (over wallpaper)
  { path: './data/phase280-cursor-vanishing/2026-05-11_19-05-45/f023.jpg', cursorVis: { x: 733, y: 777 } },
];

const BRIGHT_THRESHOLDS = [120, 140];

for (const frame of FRAMES) {
  console.error(`\n=== ${frame.path} (cursor: ${frame.cursorVis.x},${frame.cursorVis.y}) ===`);
  const buf = await fs.readFile(frame.path);
  const { rgb, width, height } = await decode(buf);

  for (const brT of BRIGHT_THRESHOLDS) {
    console.error(`\n  brightThreshold=${brT}:`);
    const clusters = findBrightClusters(rgb, width, height, brT, 15, 250);
    // Sort by distance to true cursor, show clusters within 200 px
    const nearby = clusters
      .map((c) => ({ c, d: Math.hypot(c.centroidX - frame.cursorVis.x, c.centroidY - frame.cursorVis.y) }))
      .filter((x) => x.d < 200)
      .sort((a, b) => a.d - b.d);

    console.error(`    ${clusters.length} clusters total; ${nearby.length} within 200 px of true cursor`);
    for (const { c, d } of nearby.slice(0, 5)) {
      const bboxW = c.bboxMaxX - c.bboxMinX + 1;
      const bboxH = c.bboxMaxY - c.bboxMinY + 1;
      const aspect = bboxW / Math.max(1, bboxH);
      // Compute quadrants from members
      let qNW = 0, qNE = 0, qSW = 0, qSE = 0;
      if (c.members) {
        for (const idx of c.members) {
          const px = idx % width;
          const py = (idx - px) / width;
          if (px < c.centroidX && py < c.centroidY) qNW++;
          else if (px >= c.centroidX && py < c.centroidY) qNE++;
          else if (px < c.centroidX && py >= c.centroidY) qSW++;
          else qSE++;
        }
      }
      const qS = [qNW, qNE, qSW, qSE].sort((a, b) => b - a);
      const asym = qS[3] === 0 ? 0 : qS[0] / Math.max(1, qS[3]);
      const cxBb = (c.bboxMinX + c.bboxMaxX) / 2;
      const cyBb = (c.bboxMinY + c.bboxMaxY) / 2;
      const offset = Math.hypot(c.centroidX - cxBb, c.centroidY - cyBb);
      const score = shapeScoreFor(c.pixels, asym, offset, aspect);
      console.error(
        `    cluster at (${c.centroidX},${c.centroidY}) bbox=${bboxW}x${bboxH} px=${c.pixels} asym=${asym.toFixed(1)} off=${offset.toFixed(1)} dist=${d.toFixed(0)}px score=${score.toFixed(3)}`,
      );
    }
  }
}
process.exit(0);
