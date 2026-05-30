/**
 * Phase 193-A — diagnose why findClusters rejects the cursor.
 *
 * Loads a known frame-pair from the prior detection-truth bench
 * (where the cursor visibly moved from ~(1120,980) to ~(1060,895)
 * on a -60,-60 emit), runs the diff at multiple brightnessFloor
 * settings, and reports cluster counts and positions.
 *
 * Hypothesis: the default brightnessFloor of 170 rejects the dark
 * iPadOS cursor on the light wallpaper. Lower brightness floors
 * should admit the cursor cluster.
 *
 * No live iPad needed — pure analysis of saved frames.
 */

import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  decodeScreenshot,
  diffScreenshotsDecoded,
  diffPixels,
  findClusters,
  DEFAULT_DETECTION_CONFIG,
  type DetectionConfig,
} from '../src/pikvm/cursor-detect.js';

const FRAME_A = './data/detection-truth/03-A-pre-nw-60-60.jpg';
const FRAME_B_MARKED = './data/detection-truth/03-B-marked-nw-60-60.jpg';

// We need the unmarked version of frame B for honest diffing — use the
// trajectory bench's frame which doesn't have markers drawn on it.
// Actually, the marked version has SVG markers added that would corrupt
// the diff. We need to capture a fresh frame pair without markers.
// For now, let's read frame A unmodified (pre-emit, no markers ever)
// and use the marked frame B but understand the markers will be in the
// diff. Better: run the diagnostic with default brightness floor first
// to baseline, then adjust.
//
// Actually I'll use the saved frame A from -nw-60-60 and frame B
// from a different trial that doesn't have markers... no, all frame
// Bs have markers. Need to either:
//   a) Re-capture clean frame pair fresh
//   b) Strip markers from existing frames

// For now: use the existing frame B even with markers — markers are far
// from the cursor area so they shouldn't affect cursor cluster detection.
// We're looking for clusters at (1060, 895), markers were at (765, 786).

console.error(`Loading frame A: ${FRAME_A}`);
console.error(`Loading frame B: ${FRAME_B_MARKED}`);

const frameA = await decodeScreenshot(await fs.readFile(FRAME_A));
const frameB = await decodeScreenshot(await fs.readFile(FRAME_B_MARKED));
console.error(`Frames decoded: ${frameA.width}×${frameA.height}, ${frameB.width}×${frameB.height}`);

// Sanity: confirm dimensions match
if (frameA.width !== frameB.width || frameA.height !== frameB.height) {
  console.error('FRAME DIMENSIONS DIFFER — cannot diff');
  process.exit(1);
}

// Sweep brightnessFloor: 0, 50, 100, 130, 170 (default), 200
const floors = [0, 50, 100, 130, 170, 200];

interface ClusterReport {
  floor: number;
  diffPixelCount: number;
  clusterCount: number;
  clusters: Array<{ centroidX: number; centroidY: number; pixels: number }>;
}

const reports: ClusterReport[] = [];

for (const floor of floors) {
  const cfg: DetectionConfig = {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor: floor,
    // Loosen cluster filters too so we see the full picture
    minClusterSize: 1,
    maxClusterSize: 100000,
  };

  const diffMask = diffPixels(
    frameA.rgb,
    frameB.rgb,
    frameA.width,
    frameA.height,
    cfg.diffThreshold,
    cfg.brightnessFloor,
    cfg.maxChannelDelta,
    frameB.rgb,
  );
  const diffPixelCount = diffMask.reduce((s, b) => s + (b ? 1 : 0), 0);

  const clusters = findClusters(
    diffMask,
    frameA.width,
    frameA.height,
    cfg.minClusterSize,
    cfg.maxClusterSize,
    cfg.mergeRadius,
  );

  // Sort clusters by size descending so the biggest are first
  const sorted = [...clusters].sort((a, b) => b.pixels - a.pixels).slice(0, 15);

  reports.push({
    floor,
    diffPixelCount,
    clusterCount: clusters.length,
    clusters: sorted.map(c => ({
      centroidX: Math.round(c.centroidX),
      centroidY: Math.round(c.centroidY),
      pixels: c.pixels,
    })),
  });

  console.error(
    `\nbrightnessFloor=${floor.toString().padStart(3)}: diff=${diffPixelCount.toString().padStart(6)} px, ${clusters.length.toString().padStart(4)} clusters total`,
  );
  console.error(`  top 15 by size:`);
  for (const c of sorted) {
    const nearActualCursor = Math.abs(c.centroidX - 1060) < 30 && Math.abs(c.centroidY - 895) < 30;
    const marker = nearActualCursor ? '  ← NEAR ACTUAL CURSOR (1060, 895)' : '';
    console.error(`    (${c.centroidX.toString().padStart(4)}, ${c.centroidY.toString().padStart(4)}) ${c.pixels.toString().padStart(5)} px${marker}`);
  }
}

// Save the diff mask at a couple settings as a binary image so we can
// see WHICH pixels are flagged.
async function saveDiffMask(floor: number, mask: boolean[]): Promise<void> {
  const w = frameA.width;
  const h = frameA.height;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      rgb[i * 3] = 255;
      rgb[i * 3 + 1] = 255;
      rgb[i * 3 + 2] = 255;
    }
  }
  const out = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 70 })
    .toBuffer();
  const file = `./data/detection-truth/diff-mask-floor${floor}.jpg`;
  await fs.writeFile(file, out);
  console.error(`saved ${file}`);
}

// Save masks at floors 0 (everything that changed) and 170 (default)
for (const floor of [0, 170]) {
  const cfg: DetectionConfig = {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor: floor,
  };
  const diffMask = diffPixels(
    frameA.rgb,
    frameB.rgb,
    frameA.width,
    frameA.height,
    cfg.diffThreshold,
    cfg.brightnessFloor,
    cfg.maxChannelDelta,
    frameB.rgb,
  );
  await saveDiffMask(floor, diffMask);
}

await fs.writeFile('./data/detection-truth/findclusters-sweep.json', JSON.stringify(reports, null, 2));
console.error('\nDone. Inspect data/detection-truth/diff-mask-floor*.jpg + findclusters-sweep.json.');
process.exit(0);
