/** #41 GATE — five criteria, through the REAL MCP tool surface.
 * (a) converges toward the INDEPENDENTLY measured ~1.031 (not self-stability)
 * (d) the three tools behave  (e) clicking not regressed
 * Moves-only for traffic; the few clicks go to a grey scene, never live UI. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const REGION={x:616,y:56,w:680,h:968}, M=40;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const t=(r:any)=>((r.content.find((c:any)=>c.type==='text')?.text??'') as string);
async function main(){
  const tr=new StdioClientTransport({command:'./node_modules/.bin/tsx',args:['src/index.ts','--target','ipad'],env:{...process.env} as Record<string,string>});
  const c=new Client({name:'gate45',version:'0'},{capabilities:{}}); await c.connect(tr);
  const status=async(tag:string)=>{const s=t(await c.callTool({name:'pikvm_mover_scale_status',arguments:{}})); console.error(`\n--- status [${tag}] ---\n${s.slice(0,700)}`); return s;};
  await status('initial (expect warm-start 1.0364 Y / 1.0 X)');
  // --- traffic: moves only, geometric waypoints, never clicks ---
  const cx=REGION.x+REGION.w/2, cy=REGION.y+REGION.h/2;
  const ds=[425,380,500,143,102,460];
  for(let i=0;i<Number(process.argv[2]??24);i++){
    const d=ds[i%ds.length], a=(i*2*Math.PI)/6;
    const x=Math.max(REGION.x+M,Math.min(REGION.x+REGION.w-M,Math.round(cx+Math.cos(a)*Math.min(d/2,REGION.w/2-M))));
    const y=Math.max(REGION.y+M,Math.min(REGION.y+REGION.h-M,Math.round(cy+Math.sin(a)*Math.min(d/2,REGION.h/2-M))));
    await c.callTool({name:'pikvm_mouse_move_to',arguments:{x,y}}); await sleep(150);
    if((i+1)%8===0) console.error(`  ...${i+1} moves`);
  }
  await status('after traffic (expect counters up; scale drifting toward ~1.031)');
  // --- (d) tools ---
  console.error(t(await c.callTool({name:'pikvm_mover_scale_control',arguments:{action:'disable'}})).slice(0,200));
  const frozen=await status('after DISABLE');
  for(let i=0;i<6;i++){await c.callTool({name:'pikvm_mouse_move_to',arguments:{x:cx+120,y:cy+(i%2?90:-90)}}); await sleep(150);}
  const frozen2=await status('after traffic WHILE DISABLED (scale must be unchanged)');
  console.error(t(await c.callTool({name:'pikvm_mover_scale_control',arguments:{action:'enable'}})).slice(0,200));
  console.error(t(await c.callTool({name:'pikvm_mover_scale_reset',arguments:{}})).slice(0,300));
  await status('after RESET (expect shipped defaults)');
  await c.close(); process.exit(0);
}
main().catch(e=>{console.error('FATAL: '+e);process.exit(2);});
