import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { planAxisEmits, EMIT_CURVE_X, FULL_REPORT_PX, Y_SCALE } from '../src/pikvm/curve-mover.js';
const sleep=(m:number)=>new Promise(r=>setTimeout(r,m));
const CY=EMIT_CURVE_X.map(([m,p])=>[m,p*Y_SCALE] as const) as unknown as ReadonlyArray<readonly[number,number]>;
const c=new PiKVMClient(loadConfig().pikvm);
const v8=async()=>{const s=await c.screenshot({quality:80});const r=await findCursorByV8FullFrame(s.buffer,s.screenshotWidth,s.screenshotHeight);return r?{x:Math.round(r.x),y:Math.round(r.y)}:null;};
// place cursor on CLEAN wallpaper at (900,650) via one-shot
const cur=await v8(); if(cur){const T={x:900,y:650};
  for(const e of planAxisEmits(T.x-cur.x,FULL_REPORT_PX,EMIT_CURVE_X)){await c.mouseMoveRelative(e,0);await sleep(110);}
  for(const e of planAxisEmits(T.y-cur.y,FULL_REPORT_PX*Y_SCALE,CY)){await c.mouseMoveRelative(0,e);await sleep(110);}}
await sleep(300);
const s=await c.screenshot(); await fs.writeFile('scratch/clean-cursor.jpg',s.buffer);
console.log('saved scratch/clean-cursor.jpg (cursor aimed at clean wallpaper 900,650)');
