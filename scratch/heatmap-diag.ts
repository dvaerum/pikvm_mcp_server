import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
const IW=768, IH=480, HW=192, HH=120, MEAN=[0.485,0.456,0.406], STD=[0.229,0.224,0.225];
const sig=(z:number)=>1/(1+Math.exp(-z));
async function run(path:string){
  const sess=await ort.InferenceSession.create('ml/cursor-v13.onnx');
  const {data:rgb}=await sharp(path).resize(IW,IH,{fit:'fill',kernel:'cubic'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const inp=new Float32Array(3*IW*IH), plane=IW*IH;
  for(let y=0;y<IH;y++)for(let x=0;x<IW;x++){const s=(y*IW+x)*3,d=y*IW+x;
    inp[d]=(rgb[s]/255-MEAN[0])/STD[0];inp[plane+d]=(rgb[s+1]/255-MEAN[1])/STD[1];inp[2*plane+d]=(rgb[s+2]/255-MEAN[2])/STD[2];}
  const r=await sess.run({frame:new ort.Tensor('float32',inp,[1,3,IH,IW])});
  const hm=r.heatmap_logits.data as Float32Array;
  const presence=sig((r.presence_logit.data as Float32Array)[0]);
  // frame is 1920x1080
  const FW=1920,FH=1080;
  const at=(nx:number,ny:number,rad=3)=>{ // max sigmoid in a small window around native (nx,ny)
    const cx=Math.round(nx/FW*HW), cy=Math.round(ny/FH*HH); let m=-1e9,mx=cx,my=cy;
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){const hx=cx+dx,hy=cy+dy;if(hx<0||hy<0||hx>=HW||hy>=HH)continue;const v=hm[hy*HW+hx];if(v>m){m=v;mx=hx;my=hy;}}
    return {v:sig(m), nx:Math.round(mx/HW*FW), ny:Math.round(my/HH*FH)};
  };
  // top-5 peaks
  const idx=[...hm.keys()].sort((a,b)=>hm[b]-hm[a]).slice(0,5);
  console.log(`FRAME: ${path}`);
  console.log(`  global presence = ${presence.toFixed(4)}`);
  const maps=at(1110,297); const cur=at(757,846);
  console.log(`  heatmap @ MAPS widget (1110,297): ${maps.v.toFixed(4)}  (peak near ${maps.nx},${maps.ny})`);
  console.log(`  heatmap @ REAL cursor on Books (757,846): ${cur.v.toFixed(4)}  (peak near ${cur.nx},${cur.ny})`);
  console.log(`  TOP-5 heatmap peaks (native x,y : confidence):`);
  for(const i of idx){const hx=i%HW,hy=Math.floor(i/HW);console.log(`    (${Math.round(hx/HW*FW)},${Math.round(hy/HH*FH)}) : ${sig(hm[i]).toFixed(4)}`);}
}
await run('scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg');
