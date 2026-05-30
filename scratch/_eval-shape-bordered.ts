/**
 * Run cursor-shape-detect on bordered-cursor frames. Default
 * maxClusterPixels is 250 — bordered cursor clusters were 200-260 px
 * (from PA3), so it should fit but pass max-1 with the default. Also
 * try with bumped maxClusterPixels for safety.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorShapeCandidates, findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';

const FRAMES_DIR = 'data/eyeball-bordered-cursor-2026-05-27T17-33-59';

async function main() {
  const files = (await fs.readdir(FRAMES_DIR))
    .filter(f => f.endsWith('.jpg'))
    .sort();

  for (const file of files) {
    const fp = path.join(FRAMES_DIR, file);
    const jpg = await fs.readFile(fp);
    const dec = await decodeScreenshot(jpg);
    // Default maxClusterPixels=250 may be too tight for the bigger bordered
    // cursor; try 400 to be safe.
    // Phase 293: brightThreshold=200 catches the WHITE border around the
    // new bordered cursor. The dark-mask path misses it because the cursor
    // body is small and surrounded by bright white pixels.
    const cands = findCursorShapeCandidates(
      dec.rgb, dec.width, dec.height,
      5,
      { maxClusterPixels: 400, brightThreshold: 200 },
    );
    if (cands.length === 0) {
      console.log(`  ${file}: NO candidates`);
      continue;
    }
    const lines = cands.map((c, i) =>
      `    #${i + 1} (${Math.round(c.centroidX)},${Math.round(c.centroidY)}) score=${c.shapeScore.toFixed(3)} pixels=${c.pixels}`);
    console.log(`  ${file}:\n${lines.join('\n')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
