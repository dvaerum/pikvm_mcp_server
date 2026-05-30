/**
 * Phase 308 replay: re-run findCursorShapeCandidates on the saved
 * Phase 308 v0.5.233 bench frames with v0.5.234's bright-bg penalty
 * active. Compare top-1 picks before vs after.
 *
 * No live iPad — pure replay against saved frames.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { findCursorShapeCandidates } from '../src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';

const DIR = process.argv[2] || './data/phase308-instrumented/2026-05-13_04-29-06';
const files = (await fs.readdir(DIR)).filter(f => /^r\d_.+\.jpg$/.test(f)).sort();

console.error(`Replaying detector against ${files.length} frames from ${DIR}\n`);

interface Result {
  file: string;
  top1: { x: number; y: number; pixels: number; score: number } | null;
}

const results: Result[] = [];
for (const f of files) {
  const buf = await fs.readFile(path.join(DIR, f));
  const decoded = await decodeScreenshot(buf);
  const cands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 3);
  const top = cands[0];
  results.push({
    file: f,
    top1: top ? { x: Math.round(top.centroidX), y: Math.round(top.centroidY), pixels: top.pixels, score: top.shapeScore } : null,
  });
  console.error(`  ${f.padEnd(30)} top1=${top ? `(${Math.round(top.centroidX)},${Math.round(top.centroidY)}) px=${top.pixels} s=${top.shapeScore.toFixed(3)}` : 'none'}`);
}

// How many picked calendar "13" widget at (619, 261) ±10 px?
const widgetFP = results.filter(r => r.top1 && Math.abs(r.top1.x - 619) <= 10 && Math.abs(r.top1.y - 261) <= 10);
console.error(`\n=== Summary ===`);
console.error(`Frames picking calendar widget "13" (~619, 261) as top-1: ${widgetFP.length}/${results.length}`);
process.exit(0);
