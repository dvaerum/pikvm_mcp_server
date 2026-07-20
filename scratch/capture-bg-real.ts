import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
const sleep=(m:number)=>new Promise(r=>setTimeout(r,m));
const DEV='CF2B815D-7960-5B60-987B-FA2DC9A65353';
const c=new PiKVMClient(loadConfig().pikvm);
await fs.mkdir('data/bg-real',{recursive:true});
const APPS:[string,string][]=[
  ['maps','com.apple.Maps'],['appstore','com.apple.AppStore'],['photos','com.apple.mobileslideshow'],
  ['files','com.apple.DocumentsApp'],['settings','com.apple.Preferences'],['books','com.apple.iBooks'],
  ['reminders','com.apple.reminders'],['calendar','com.apple.mobilecal'],['weather','com.apple.weather'],
  ['notes','com.apple.mobilenotes'],['news','com.apple.news'],['stocks','com.apple.stocks'],
  ['music','com.apple.Music'],['mail','com.apple.mobilemail'],['tv','com.apple.tv'],['clock','com.apple.mobiletimer'],
];
let ok=0;
for(const [name,bid] of APPS){
  try{ execSync(`xcrun devicectl device process launch --terminate-existing --device ${DEV} ${bid}`,{stdio:'pipe'}); }
  catch(e){ console.error(`${name}: launch failed`); continue; }
  await sleep(3800); // load; do NOT move mouse (cursor stays faded → cursor-free)
  const s=await c.screenshot();
  await fs.writeFile(`data/bg-real/${name}.jpg`, s.buffer);
  ok++; console.error(`captured ${name}`);
}
console.error(`\ncaptured ${ok}/${APPS.length} cursor-free app backgrounds → data/bg-real/`);
