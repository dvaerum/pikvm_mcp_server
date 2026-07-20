import sharp from 'sharp'; import * as ort from 'onnxruntime-node';
const IW=768,IH=480,HW=192,HH=120,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225],FW=1920,FH=1080;
const sig=(z:number)=>1/(1+Math.exp(-z));
const sess=await ort.InferenceSession.create('ml/cursor-v13.onnx');
const {data:rgb}=await sharp('scratch/clean-cursor.jpg').resize(IW,IH,{fit:'fill',kernel:'cubic'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
const inp=new Float32Array(3*IW*IH),plane=IW*IH;
for(let y=0;y<IH;y++)for(let x=0;x<IW;x++){const s=(y*IW+x)*3,d=y*IW+x;inp[d]=(rgb[s]/255-MEAN[0])/STD[0];inp[plane+d]=(rgb[s+1]/255-MEAN[1])/STD[1];inp[2*plane+d]=(rgb[s+2]/255-MEAN[2])/STD[2];}
const r=await sess.run({frame:new ort.Tensor('float32',inp,[1,3,IH,IW])});
const hm=r.heatmap_logits.data as Float32Array; const presence=sig((r.presence_logit.data as Float32Array)[0]);
const at=(nx:number,ny:number,rad=4)=>{const cx=Math.round(nx/FW*HW),cy=Math.round(ny/FH*HH);let m=-1e9;for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){const hx=cx+dx,hy=cy+dy;if(hx<0||hy<0||hx>=HW||hy>=HH)continue;const v=hm[hy*HW+hx];if(v>m)m=v;}return sig(m);};
console.log(`CLEAN frame: presence=${presence.toFixed(4)}  cursor@(900,650)=${at(900,650).toFixed(4)}  map@(1110,297)=${at(1110,297).toFixed(4)}`);
const idx=[...hm.keys()].sort((a,b)=>hm[b]-hm[a]).slice(0,3);
for(const i of idx){const hx=i%HW,hy=Math.floor(i/HW);console.log(`  top peak (${Math.round(hx/HW*FW)},${Math.round(hy/HH*FH)}): ${sig(hm[i]).toFixed(4)}`);}
