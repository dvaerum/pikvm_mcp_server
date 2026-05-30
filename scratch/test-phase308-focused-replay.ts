/**
 * Quick focused replay: run v0.5.234 detector on the specific frame
 * where v0.5.233 found the cursor at 7 px from Settings. Show top-10
 * with locality filter applied (radius 100 around target (905, 800)).
 * This tells me whether Phase 308's bright-bg penalty killed the
 * cursor cluster in this frame.
 */
import { promises as fs } from 'fs';
import { findCursorShapeCandidates } from '../src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';

const path = './data/phase308-instrumented/2026-05-13_04-29-06/r2_Settings_03.jpg';
const target = { x: 905, y: 800 };

const buf = await fs.readFile(path);
const decoded = await decodeScreenshot(buf);

// Global top-10
console.error('Global top-10 (no locality):');
const globalCands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 10);
for (let i = 0; i < globalCands.length; i++) {
  const c = globalCands[i];
  const dist = Math.hypot(c.centroidX - target.x, c.centroidY - target.y);
  console.error(`  ${i + 1}. (${Math.round(c.centroidX)},${Math.round(c.centroidY)}) px=${c.pixels} score=${c.shapeScore.toFixed(4)} dist=${dist.toFixed(0)}`);
}

// Locality top-10 (radius 100 around target)
console.error('\nLocality top-10 (radius 100 around target):');
const localCands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 10, {
  expectedNear: target,
  expectedNearRadius: 100,
});
for (let i = 0; i < localCands.length; i++) {
  const c = localCands[i];
  const dist = Math.hypot(c.centroidX - target.x, c.centroidY - target.y);
  console.error(`  ${i + 1}. (${Math.round(c.centroidX)},${Math.round(c.centroidY)}) px=${c.pixels} score=${c.shapeScore.toFixed(4)} dist=${dist.toFixed(0)}`);
}

process.exit(0);
