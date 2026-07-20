import ort from 'onnxruntime-node'; import sharp from 'sharp';
const MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225];const sig=(z:number)=>1/(1+Math.exp(-z));
const ver=await ort.InferenceSession.create('ml/crop-heatmap.onnx');
const F='scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
async function p(cx:number,cy:number){const{data}=await sharp(F).extract({left:cx-48,top:cy-48,width:96,height:96}).removeAlpha().raw().toBuffer({resolveWithObject:true});const pl=96*96,inp=new Float32Array(3*pl);for(let i=0;i<pl;i++){inp[i]=(data[i*3]/255-MEAN[0])/STD[0];inp[pl+i]=(data[i*3+1]/255-MEAN[1])/STD[1];inp[2*pl+i]=(data[i*3+2]/255-MEAN[2])/STD[2];}const r=await ver.run({crop:new ort.Tensor('float32',inp,[1,3,96,96])});return sig((r.presence_logit.data as Float32Array)[0]);}
console.log('DUAL-HEAD presence vs crop offset from books-cursor (757,846) — must stay >0.5 for grid to work:');
for(const d of [0,12,24,36,44]){console.log(`  ${String(d).padStart(2)}px  +x=${(await p(757+d,846)).toFixed(2)} -x=${(await p(757-d,846)).toFixed(2)} +y=${(await p(757,846+d)).toFixed(2)} -y=${(await p(757,846-d)).toFixed(2)}`);}
