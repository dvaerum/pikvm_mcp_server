/**
 * Phase 306 replay: run findCursorShapeCandidates directly on the
 * Phase 305 lock-screen captures. The cursor is visibly present in
 * those frames; the detector should at minimum find it as one of
 * the top-K candidates. If it doesn't, the detector itself has a
 * real bug.
 *
 * No live iPad — pure replay against saved frames.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from './src/pikvm/cursor-detect.js';

const DIR = './data/null-detection-snapshots';
const files = await fs.readdir(DIR);
const jpgs = files.filter(f => f.endsWith('.jpg')).sort();

console.error(`Replaying detector against ${jpgs.length} frames from ${DIR}\n`);

for (const jpg of jpgs) {
  const buf = await fs.readFile(path.join(DIR, jpg));
  const decoded = await decodeScreenshot(buf);
  console.error(`\n=== ${jpg} (${decoded.width}x${decoded.height}) ===`);

  // Run dark-only and bright-also detector
  for (const useBright of [false, true]) {
    const opts = useBright ? { brightThreshold: 120 } : {};
    const cands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 10, opts);
    console.error(`  ${useBright ? 'dark+bright' : 'dark-only'} top-10:`);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      console.error(
        `    ${i + 1}. (${Math.round(c.centroidX)},${Math.round(c.centroidY)}) ` +
        `pixels=${c.pixels} score=${c.shapeScore.toFixed(4)}`,
      );
    }
  }
}

process.exit(0);
