import ort from 'onnxruntime-node';
import sharp from 'sharp';
const CROP=96,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225];
const F='scratch/click-bench80-2026-07-20T07-01-52/MISS-t10-Books-frac0.01-rnull.jpg';
const sig=(z:number)=>1/(1+Math.exp(-z));
// iPad region (stable) + stride; batch ALL crops in ONE verifier inference
const REG={x:610,y:58,w:692,h:956}, STRIDE=48;
const ver=await ort.InferenceSession.create('ml/crop-verifier.onnx');
const raw=await sharp(F).removeAlpha().raw().toBuffer({resolveWithObject:true});
const {data:full,info}=raw; const FW=info.width;
const centers:{x:number,y:number}[]=[];
for(let cy=REG.y+CROP/2; cy<=REG.y+REG.h-CROP/2; cy+=STRIDE)
  for(let cx=REG.x+CROP/2; cx<=REG.x+REG.w-CROP/2; cx+=STRIDE)
    centers.push({x:Math.round(cx),y:Math.round(cy)});
const N=centers.length, pl=CROP*CROP;
const batch=new Float32Array(N*3*pl);
for(let n=0;n<N;n++){const left=centers[n].x-CROP/2,top=centers[n].y-CROP/2;
  for(let yy=0;yy<CROP;yy++)for(let xx=0;xx<CROP;xx++){const si=((top+yy)*FW+(left+xx))*3,di=yy*CROP+xx;
    batch[n*3*pl+di]=(full[si]/255-MEAN[0])/STD[0];batch[n*3*pl+pl+di]=(full[si+1]/255-MEAN[1])/STD[1];batch[n*3*pl+2*pl+di]=(full[si+2]/255-MEAN[2])/STD[2];}}
const t0=Date.now();
const r=await ver.run({crop:new ort.Tensor('float32',batch,[N,3,CROP,CROP])});
const dt=Date.now()-t0;
const logits=r.logit.data as Float32Array;
let bi=0;for(let i=1;i<N;i++)if(logits[i]>logits[bi])bi=i;
console.log(`grid ${N} crops (stride ${STRIDE}), batched verifier inference = ${dt}ms`);
console.log(`max verifier: (${centers[bi].x},${centers[bi].y}) score=${sig(logits[bi]).toFixed(3)}`);
const above=centers.map((c,i)=>({c,v:sig(logits[i])})).filter(o=>o.v>0.5);
console.log(`crops above 0.5: ${above.length} -> ${above.map(o=>`(${o.c.x},${o.c.y})=${o.v.toFixed(2)}`).join(' ')}`);
