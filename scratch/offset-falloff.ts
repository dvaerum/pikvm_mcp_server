import ort from 'onnxruntime-node'; import sharp from 'sharp';
const CROP=96,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225];
const sig=(z:number)=>1/(1+Math.exp(-z));
const M=process.argv[2]??'ml/crop-verifier-v6.onnx';
const F='scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
const ver=await ort.InferenceSession.create(M);
async function s(cx:number,cy:number){
  const {data}=await sharp(F).extract({left:cx-48,top:cy-48,width:96,height:96}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const pl=96*96,inp=new Float32Array(3*pl);
  for(let i=0;i<pl;i++){inp[i]=(data[i*3]/255-MEAN[0])/STD[0];inp[pl+i]=(data[i*3+1]/255-MEAN[1])/STD[1];inp[2*pl+i]=(data[i*3+2]/255-MEAN[2])/STD[2];}
  const r=await ver.run({crop:new ort.Tensor('float32',inp,[1,3,96,96])});
  return sig((r.logit.data as Float32Array)[0]);
}
console.log(`${M} — books-cursor score vs offset from (757,846):`);
for(const d of [0,8,16,24,32]){
  const r=await s(757+d,846), l=await s(757-d,846), u=await s(757,846-d), dn=await s(757,846+d);
  console.log(`  ${String(d).padStart(2)}px  +x=${r.toFixed(2)} -x=${l.toFixed(2)} +y=${dn.toFixed(2)} -y=${u.toFixed(2)}`);
}
