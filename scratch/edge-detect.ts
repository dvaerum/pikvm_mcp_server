import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { readFileSync } from 'node:fs';
for (const [f, tx, ty] of [['scratch/edge-1010.jpg',960,1010],['scratch/edge-985.jpg',950,985]] as [string,number,number][]) {
  const r = await findCursorByV8FullFrame(readFileSync(f), 1920, 1080);
  const err = r ? Math.hypot(r.x-tx, r.y-ty) : NaN;
  console.log(`cursor@(${tx},${ty}): ${r?`DETECTED (${r.x},${r.y}) pres=${r.presence.toFixed(2)} err=${err.toFixed(0)}px`:'NULL (missed)'}`);
}
