/** #41 — how fast does the learner actually reach its FIRST update?
 * Drives long-axis moves (the qualifying kind) and polls status until an update
 * fires, reporting moves-to-first-update + the windowSE trajectory. Moves only. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const R={x:616,y:56,w:680,h:968}, M=40;
const PROFILE=(process.argv[2]??'long') as 'long'|'mixed';
const MAX=Number(process.argv[3]??40);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const tx=(r:any)=>((r.content.find((c:any)=>c.type==='text')?.text??'') as string);
async function main(){
  const tr=new StdioClientTransport({command:'./node_modules/.bin/tsx',args:['src/index.ts','--target','ipad'],env:{...process.env} as Record<string,string>});
  const c=new Client({name:'speed',version:'0'},{capabilities:{}}); await c.connect(tr);
  const st=async()=>JSON.parse(tx(await c.callTool({name:'pikvm_mover_scale_status',arguments:{}})));
  const top=R.y+M, bot=R.y+R.h-M, lef=R.x+M, rig=R.x+R.w-M, cx=Math.round(R.x+R.w/2), cy=Math.round(R.y+R.h/2);
  const pts = PROFILE==='long'
    ? [{x:cx,y:top},{x:cx,y:bot},{x:lef,y:cy},{x:rig,y:cy}]                    // ~890px Y, ~600px X
    : [{x:cx,y:top},{x:cx,y:cy},{x:cx+102,y:cy+71},{x:cx,y:bot},{x:cx-102,y:cy}];
  let firstY:number|null=null, firstX:number|null=null;
  for(let i=1;i<=MAX;i++){
    const p=pts[(i-1)%pts.length];
    await c.callTool({name:'pikvm_mouse_move_to',arguments:{x:p.x,y:p.y}}); await sleep(120);
    const s=await st();
    if(firstY===null && s.y.lastUpdate){firstY=i;}
    if(firstX===null && s.x.lastUpdate){firstX=i;}
    if(i%4===0||firstY===i||firstX===i)
      console.error(`move ${String(i).padStart(3)}  y:acc=${s.y.accepted} SE=${s.y.windowSE===null?'  -  ':(100*s.y.windowSE).toFixed(2)+'%'} applied=${s.y.applied.toFixed(4)}${s.y.lastUpdate?' *UPD*':''}   x:acc=${s.x.accepted} SE=${s.x.windowSE===null?'  -  ':(100*s.x.windowSE).toFixed(2)+'%'} applied=${s.x.applied.toFixed(4)}${s.x.lastUpdate?' *UPD*':''}`);
    if(firstY!==null&&firstX!==null) break;
  }
  const f=await st();
  console.error(`\n=== PROFILE=${PROFILE} ===`);
  console.error(`  first Y update after ${firstY??'>'+MAX} moves ; first X update after ${firstX??'>'+MAX} moves`);
  console.error(`  final applied  Y ${f.y.applied.toFixed(4)} (default ${f.y.shippedDefault})  X ${f.x.applied.toFixed(4)}`);
  console.error(`  accepted Y ${f.y.accepted}/${f.y.seen}  X ${f.x.accepted}/${f.x.seen}`);
  await c.close(); process.exit(0);
}
main().catch(e=>{console.error('FATAL: '+e);process.exit(2);});
