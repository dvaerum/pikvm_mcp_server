import ort from 'onnxruntime-node'; import sharp from 'sharp';
const CROP=96,HM=24,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225];const sig=(z:number)=>1/(1+Math.exp(-z));
const REG={x:610,y:58,w:692,h:956},STRIDE=48,half=48;
const ver=await ort.InferenceSession.create('ml/crop-heatmap.onnx');
const {data:full,info}=await sharp('scratch/dock-fail.jpg').removeAlpha().raw().toBuffer({resolveWithObject:true});
const FW=info.width;
const axis=(lo:number,hi:number,fmax:number)=>{const raw=[];for(let v=lo;v<hi;v+=STRIDE)raw.push(v);raw.push(hi);const s=new Set<number>(),o:number[]=[];for(const v of raw){const c=Math.round(Math.max(half,Math.min(fmax-half,v)));if(!s.has(c)){s.add(c);o.push(c);}}return o;};
const ys=axis(REG.y,REG.y+REG.h,info.height),xs=axis(REG.x,REG.x+REG.w,FW);
const centers:{x:number,y:number}[]=[];for(const cy of ys)for(const cx of xs)centers.push({x:cx,y:cy});
const N=centers.length,pl=CROP*CROP,batch=new Float32Array(N*3*pl);
for(let n=0;n<N;n++){const left=Math.max(0,Math.min(FW-CROP,centers[n].x-half)),top=Math.max(0,Math.min(info.height-CROP,centers[n].y-half));for(let yy=0;yy<CROP;yy++)for(let xx=0;xx<CROP;xx++){const si=((top+yy)*FW+(left+xx))*3,di=yy*CROP+xx;batch[n*3*pl+di]=(full[si]/255-MEAN[0])/STD[0];batch[n*3*pl+pl+di]=(full[si+1]/255-MEAN[1])/STD[1];batch[n*3*pl+2*pl+di]=(full[si+2]/255-MEAN[2])/STD[2];}}
const r=await ver.run({crop:new ort.Tensor('float32',batch,[N,3,CROP,CROP])});
const pres=r.presence_logit.data as Float32Array;let bi=0;for(let i=1;i<N;i++)if(pres[i]>pres[bi])bi=i;
console.log(`grid ${N} crops, max presence=${sig(pres[bi]).toFixed(3)} at (${centers[bi].x},${centers[bi].y})`);
const above=centers.map((c,i)=>({c,p:sig(pres[i])})).filter(o=>o.p>0.3).sort((a,b)=>b.p-a.p).slice(0,5);
console.log('top presence:', above.map(o=>`(${o.c.x},${o.c.y})=${o.p.toFixed(2)}`).join(' '));
