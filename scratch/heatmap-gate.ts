/** Production-faithful gate for the DUAL-HEAD crop detector (sharp/ONNX). Reports
 * presence (sigmoid) at each real gate point. REJECT->want<0.5, ACCEPT->want>0.5. */
import ort from 'onnxruntime-node'; import sharp from 'sharp';
const CROP=96,MEAN=[0.485,0.456,0.406],STD=[0.229,0.224,0.225];const sig=(z:number)=>1/(1+Math.exp(-z));
const BOOKS='scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
const MAPSICON='scratch/click-bench80-2026-07-20T07-01-52/MISS-t10-Books-frac0.01-rnull.jpg';
const GATE:[string,string,number,number,number][]=[
  ['REJ books-icon','scratch/hc13.jpg',760,819,0],['REJ books-edge','scratch/hc13.jpg',690,819,0],
  ['REJ maps-widget','scratch/hc13.jpg',1110,297,0],['REJ maps-app-icon','scratch/hc13.jpg',1162,570,0],
  ['REJ map-terrain','scratch/hc17.jpg',1218,186,0],
  ['ACC clean-cursor','scratch/clean-cursor.jpg',620,432,1],['ACC books-cursor',BOOKS,757,846,1],['ACC mapsicon-cursor',MAPSICON,1180,600,1]];
const ver=await ort.InferenceSession.create(process.argv[2]??'ml/crop-heatmap.onnx');
async function pres(f:string,cx:number,cy:number){
  const{data}=await sharp(f).extract({left:cx-48,top:cy-48,width:96,height:96}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const pl=96*96,inp=new Float32Array(3*pl);for(let i=0;i<pl;i++){inp[i]=(data[i*3]/255-MEAN[0])/STD[0];inp[pl+i]=(data[i*3+1]/255-MEAN[1])/STD[1];inp[2*pl+i]=(data[i*3+2]/255-MEAN[2])/STD[2];}
  const r=await ver.run({crop:new ort.Tensor('float32',inp,[1,3,96,96])});return sig((r.presence_logit.data as Float32Array)[0]);}
let ok=0,amin=1,rmax=0;const cells:string[]=[];
for(const[label,f,cx,cy,exp]of GATE){const p=await pres(f,cx,cy);const good=(p>0.5)===(exp===1);if(good)ok++;if(exp)amin=Math.min(amin,p);else rmax=Math.max(rmax,p);cells.push(`${label}=${p.toFixed(2)}${good?'':'X'}`);}
console.log(cells.join('  '));console.log(`=> ${ok}/${GATE.length} | accept-min=${amin.toFixed(2)} reject-max=${rmax.toFixed(2)} margin=${(amin-rmax).toFixed(2)}`);
