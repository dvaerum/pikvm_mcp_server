import ort from 'onnxruntime-node';
import sharp from 'sharp';
const IW=768,IH=480,HW=192,HH=120,CROP=96,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225],FW=1920,FH=1080;
const sig=(z:number)=>1/(1+Math.exp(-z));
const F=process.argv[2], CX=+process.argv[3], CY=+process.argv[4];
async function inp(buf:Buffer,w:number,h:number,box?:any){let s=sharp(buf);if(box)s=s.extract(box);const{data}=await s.resize(w,h,{fit:'fill',kernel:'cubic'}).removeAlpha().raw().toBuffer({resolveWithObject:true});const pl=w*h,a=new Float32Array(3*pl);for(let i=0;i<pl;i++){a[i]=(data[i*3]/255-MEAN[0])/STD[0];a[pl+i]=(data[i*3+1]/255-MEAN[1])/STD[1];a[2*pl+i]=(data[i*3+2]/255-MEAN[2])/STD[2];}return a;}
const prop=await ort.InferenceSession.create('ml/cursor-v14-ep05.onnx');
const ver=await ort.InferenceSession.create('ml/crop-verifier.onnx');
const buf=await sharp(F).toBuffer();
const r=await prop.run({frame:new ort.Tensor('float32',await inp(buf,IW,IH),[1,3,IH,IW])});
const hm=r.heatmap_logits.data as Float32Array;
const order=[...hm.keys()].sort((a,b)=>hm[b]-hm[a]);const peaks:any[]=[];
for(const i of order){const nx=Math.round((i%HW)/HW*FW),ny=Math.round(Math.floor(i/HW)/HH*FH);if(peaks.some(p=>Math.hypot(p.x-nx,p.y-ny)<70))continue;peaks.push({x:nx,y:ny,peak:sig(hm[i])});if(peaks.length>=20)break;}
async function vscore(cx:number,cy:number){const left=Math.max(0,Math.min(FW-CROP,cx-CROP/2)),top=Math.max(0,Math.min(FH-CROP,cy-CROP/2));const cr=await ver.run({crop:new ort.Tensor('float32',await inp(buf,CROP,CROP,{left,top,width:CROP,height:CROP}),[1,3,CROP,CROP])});return sig((cr.logit.data as Float32Array)[0]);}
console.log('top proposer peaks + verifier scores:');
for(const p of peaks.slice(0,10)){const v=await vscore(p.x,p.y);const near=Math.hypot(p.x-CX,p.y-CY)<60?' <-- near TRUE cursor':'';console.log(`  (${p.x},${p.y}) proposer=${p.peak.toFixed(2)} verifier=${v.toFixed(3)}${near}`);}
console.log(`\nverifier score AT true cursor (${CX},${CY}) = ${(await vscore(CX,CY)).toFixed(3)}`);
const anyPeakNear=peaks.some(p=>Math.hypot(p.x-CX,p.y-CY)<60);
console.log(`proposer proposed a peak within 60px of true cursor? ${anyPeakNear}`);
