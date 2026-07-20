import { promises as fs } from 'node:fs';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
const frames = ['scratch/hc18.jpg','scratch/hc17.jpg','scratch/hc15.jpg','scratch/hc13.jpg'];
for (const f of frames) {
  try {
    const buf = await fs.readFile(f);
    // these are 1920x1080 full frames, no cursor visible
    const r = await findCursorByV8FullFrame(buf, 1920, 1080, { minPresence: 0.0 });
    if (r) console.log(`${f}: V8 detects (${Math.round(r.x)},${Math.round(r.y)}) presence=${r.presence.toFixed(3)} heatmapPeak=${r.heatmapPeak.toFixed(3)}  ${Math.abs(r.x-1110)<80&&Math.abs(r.y-297)<80?'← MAPS WIDGET FP':''}`);
    else console.log(`${f}: null (no detection)`);
  } catch(e){ console.log(`${f}: ${(e as Error).message.slice(0,60)}`); }
}
