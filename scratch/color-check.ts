import sharp from 'sharp';
async function sample(path: string, cx: number, cy: number, label: string) {
  const win = 24;
  const { data, info } = await sharp(path).extract({ left: Math.round(cx-win/2), top: Math.round(cy-win/2), width: win, height: win }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels; let R=0,G=0,B=0,orange=0,n=info.width*info.height;
  let maxOrange=0;
  for (let i=0;i<n;i++){ const r=data[i*ch],g=data[i*ch+1],b=data[i*ch+2]; R+=r;G+=g;B+=b;
    // "orange-ish": high R, R clearly > B, G between
    const isOrange = r>150 && (r-b)>70 && g<r*0.9 && g>b;
    if(isOrange){orange++; const s=(r-b); if(s>maxOrange)maxOrange=s;}
  }
  console.log(`${label} @(${cx},${cy}): meanRGB=(${(R/n).toFixed(0)},${(G/n).toFixed(0)},${(B/n).toFixed(0)})  orange_frac=${(orange/n*100).toFixed(0)}%  peakOrangeStrength=${maxOrange}`);
}
// cursor (orange) on Books in the PRE frame; Maps-widget FP location on home
const pre='scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
await sample(pre, 757, 837, 'REAL CURSOR (on Books)');
await sample(pre, 1110, 297, 'MAPS-WIDGET-FP-loc (in same frame)');
await sample('scratch/hc17.jpg', 1110, 297, 'MAPS-WIDGET-FP-loc (home, no cursor)');
await sample('scratch/hc17.jpg', 900, 650, 'clear wallpaper (no cursor)');
