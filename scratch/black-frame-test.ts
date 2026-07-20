import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { readFileSync } from 'node:fs';
const r = await findCursorByV8FullFrame(readFileSync('scratch/black.jpg'), 1920, 1080);
console.log(r ? `FP @(${r.x},${r.y}) pres=${r.presence.toFixed(2)}` : 'null (correct — no cursor on black)');
