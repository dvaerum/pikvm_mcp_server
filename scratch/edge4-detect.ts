import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { readFileSync } from 'node:fs';
const pts: [string,number,number][] = [['top',960,75],['bottom',960,1005],['left',628,500],['right',1275,500],['tl-corner',632,74],['br-corner',1272,1002]];
let ok=0;
for (const [n,tx,ty] of pts) {
  const r = await findCursorByV8FullFrame(readFileSync(`scratch/e-${n}.jpg`),1920,1080);
  const err = r?Math.hypot(r.x-tx,r.y-ty):NaN;
  const good = r!==null && err<40; if(good)ok++;
  console.log(`${n.padEnd(10)} cursor@(${tx},${ty}): ${r?`(${r.x},${r.y}) err=${err.toFixed(0)}px pres=${r.presence.toFixed(2)}`:'NULL'} ${good?'ok':'MISS'}`);
}
console.log(`=> ${ok}/${pts.length} edges/corners detected`);
