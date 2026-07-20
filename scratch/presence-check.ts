/** Presence distribution: V8 presence when the REAL cursor is at each icon
 * position (via one-shot), vs the known Maps-widget FP (0.83-0.89). If real
 * detections stay >=~0.95, a minPresence gate ~0.92 rejects the FP safely. */
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { planAxisEmits, EMIT_CURVE_X, FULL_REPORT_PX, Y_SCALE } from '../src/pikvm/curve-mover.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const CURVE_Y = EMIT_CURVE_X.map(([m,p])=>[m,p*Y_SCALE] as const) as unknown as ReadonlyArray<readonly [number,number]>;
const TARGETS:[string,number,number][]=[['FaceTime',1027,435],['Files',1162,435],['Reminders',1027,570],['Maps',1162,570],['AppStore',1027,702],['Games',1162,702],['Books',757,837],['Settings',1027,837],['clear-mid',900,650],['clear-right',1250,500]];
async function main(){
  const c=new PiKVMClient(loadConfig().pikvm);
  await ipadGoHome(c); await sleep(1500);
  const v8=async()=>{const s=await c.screenshot({quality:80});const r=await findCursorByV8FullFrame(s.buffer,s.screenshotWidth,s.screenshotHeight);return r?{x:Math.round(r.x),y:Math.round(r.y),p:r.presence}:null;};
  console.error('REAL-cursor V8 presence at each position (place via one-shot, then detect):');
  const ps:number[]=[];
  for(const [name,tx,ty] of TARGETS){
    const cur=await v8(); if(!cur){console.error(`${name}: pre-detect null`);continue;}
    for(const e of planAxisEmits(tx-cur.x,FULL_REPORT_PX,EMIT_CURVE_X)){await c.mouseMoveRelative(e,0);await sleep(110);}
    for(const e of planAxisEmits(ty-cur.y,FULL_REPORT_PX*Y_SCALE,CURVE_Y)){await c.mouseMoveRelative(0,e);await sleep(110);}
    await sleep(300);
    const d=await v8();
    if(d){ps.push(d.p);console.error(`${name} (aim ${tx},${ty}): V8=(${d.x},${d.y}) presence=${d.p.toFixed(3)}  ${Math.hypot(d.x-tx,d.y-ty)<40?'ON-TARGET(real)':'OFF(maybe FP)'}`);}
    else console.error(`${name}: null`);
  }
  const s=[...ps].sort((a,b)=>a-b);
  console.error(`\nreal-cursor presence: min=${s[0]?.toFixed(3)} median=${s[Math.floor(s.length/2)]?.toFixed(3)} max=${s[s.length-1]?.toFixed(3)}`);
  console.error(`Maps-widget FP presence was 0.83-0.89. Gate viable if real min >> 0.89.`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
