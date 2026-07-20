import ort from 'onnxruntime-node';
import sharp from 'sharp';
const CROP=96,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225];
const sig=(z:number)=>1/(1+Math.exp(-z));
const REG={x:610,y:58,w:692,h:956}, STRIDE=40;
const ver=await ort.InferenceSession.create(process.argv[2]??'ml/crop-verifier.onnx');
async function grid(F:string){
  const {data:full,info}=await sharp(F).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const FW=info.width;const centers:{x:number,y:number}[]=[];
  for(let cy=REG.y+CROP/2;cy<=REG.y+REG.h-CROP/2;cy+=STRIDE)for(let cx=REG.x+CROP/2;cx<=REG.x+REG.w-CROP/2;cx+=STRIDE)centers.push({x:Math.round(cx),y:Math.round(cy)});
  const N=centers.length,pl=CROP*CROP,batch=new Float32Array(N*3*pl);
  for(let n=0;n<N;n++){const left=centers[n].x-CROP/2,top=centers[n].y-CROP/2;for(let yy=0;yy<CROP;yy++)for(let xx=0;xx<CROP;xx++){const si=((top+yy)*FW+(left+xx))*3,di=yy*CROP+xx;batch[n*3*pl+di]=(full[si]/255-MEAN[0])/STD[0];batch[n*3*pl+pl+di]=(full[si+1]/255-MEAN[1])/STD[1];batch[n*3*pl+2*pl+di]=(full[si+2]/255-MEAN[2])/STD[2];}}
  const r=await ver.run({crop:new ort.Tensor('float32',batch,[N,3,CROP,CROP])});
  const lo=r.logit.data as Float32Array;let bi=0;for(let i=1;i<N;i++)if(lo[i]>lo[bi])bi=i;
  const above=centers.map((c,i)=>({c,v:sig(lo[i])})).filter(o=>o.v>0.5).sort((a,b)=>b.v-a.v);
  return {N,max:sig(lo[bi]),at:centers[bi],above};
}
for(const [f,label] of [['scratch/hc13.jpg','NO-CURSOR'],['scratch/hc15.jpg','NO-CURSOR'],['scratch/hc17.jpg','NO-CURSOR'],['scratch/hc18.jpg','NO-CURSOR'],['scratch/click-bench80-2026-07-20T07-01-52/MISS-t10-Books-frac0.01-rnull.jpg','CURSOR-ON-MAPS-ICON']]){
  const g=await grid(f);
  const verdict = label==='NO-CURSOR' ? (g.max<0.5?'PASS (null)':`FAIL FP @${g.at.x},${g.at.y}=${g.max.toFixed(2)}`) : (g.max>=0.5?`DETECT @${g.at.x},${g.at.y}=${g.max.toFixed(2)}`:'FAIL (missed)');
  console.log(`${label.padEnd(20)} ${f.split('/').pop()!.slice(0,18).padEnd(19)} max=${g.max.toFixed(3)} @(${g.at.x},${g.at.y})  above0.5=${g.above.length}  -> ${verdict}`);
}
