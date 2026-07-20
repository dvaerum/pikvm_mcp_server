import sharp from 'sharp'; import * as ort from 'onnxruntime-node'; import { promises as fs } from 'node:fs';
const IW=768,IH=480,HW=192,HH=120,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225],FW=1920,FH=1080;
const sig=(z:number)=>1/(1+Math.exp(-z));
const src='scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
const sess=await ort.InferenceSession.create('ml/cursor-v13.onnx');
const {data:rgb}=await sharp(src).resize(IW,IH,{fit:'fill',kernel:'cubic'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
const inp=new Float32Array(3*IW*IH),plane=IW*IH;
for(let y=0;y<IH;y++)for(let x=0;x<IW;x++){const s=(y*IW+x)*3,d=y*IW+x;inp[d]=(rgb[s]/255-MEAN[0])/STD[0];inp[plane+d]=(rgb[s+1]/255-MEAN[1])/STD[1];inp[2*plane+d]=(rgb[s+2]/255-MEAN[2])/STD[2];}
const r=await sess.run({frame:new ort.Tensor('float32',inp,[1,3,IH,IW])});
const hm=r.heatmap_logits.data as Float32Array; const presence=sig((r.presence_logit.data as Float32Array)[0]);
const toN=(hx:number,hy:number)=>({x:Math.round(hx/HW*FW),y:Math.round(hy/HH*FH)});
// NMS: greedily pick distinct peaks
const order=[...hm.keys()].sort((a,b)=>hm[b]-hm[a]);
const peaks:{x:number,y:number,c:number}[]=[]; const NMS=90;
for(const i of order){const hx=i%HW,hy=Math.floor(i/HW);const n=toN(hx,hy);
  if(peaks.some(p=>Math.hypot(p.x-n.x,p.y-n.y)<NMS))continue;
  peaks.push({...n,c:sig(hm[i])}); if(peaks.length>=8)break;}
// real cursor confidence (Books ~757,846), max in a small window
const at=(nx:number,ny:number,rad=5)=>{const cx=Math.round(nx/FW*HW),cy=Math.round(ny/FH*HH);let m=-1e9;for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){const hx=cx+dx,hy=cy+dy;if(hx<0||hy<0||hx>=HW||hy>=HH)continue;const v=hm[hy*HW+hx];if(v>m)m=v;}return sig(m);};
const realC=at(757,846);
console.log(`global presence = ${presence.toFixed(4)}`);
console.log(`REAL cursor (Books 757,846) = ${realC.toFixed(4)}`);
console.log(`--- model's top-8 DISTINCT "cursor" detections (NMS), ranked: ---`);
peaks.forEach((p,i)=>console.log(`  #${i+1}  (${p.x},${p.y})  conf=${p.c.toFixed(4)}`));
// annotate: arrow + label for each top peak + the real cursor
let svg=`<svg width="${FW}" height="${FH}"><defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#00e0ff"/></marker><marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="red"/></marker></defs>`;
// real cursor arrow (from a label box to the point)
svg+=`<rect x="300" y="1000" width="520" height="40" rx="6" fill="black" fill-opacity="0.75"/><text x="312" y="1028" font-size="24" fill="red" font-family="sans-serif">REAL cursor on Books: conf ${realC.toFixed(3)}</text>`;
svg+=`<line x1="560" y1="1000" x2="757" y2="875" stroke="red" stroke-width="4" marker-end="url(#ar)"/><circle cx="757" cy="846" r="30" fill="none" stroke="red" stroke-width="4"/>`;
peaks.forEach((p,i)=>{ svg+=`<circle cx="${p.x}" cy="${p.y}" r="26" fill="none" stroke="#00e0ff" stroke-width="4"/><rect x="${p.x+30}" y="${p.y-16}" width="150" height="30" rx="5" fill="black" fill-opacity="0.75"/><text x="${p.x+36}" y="${p.y+6}" font-size="20" fill="#00e0ff" font-family="sans-serif">#${i+1} ${p.c.toFixed(3)}</text>`; });
svg+=`</svg>`;
await sharp(src).composite([{input:Buffer.from(svg),top:0,left:0}]).jpeg({quality:88}).toFile('scratch/confidence-annotated.jpg');
console.log('wrote scratch/confidence-annotated.jpg');
