import sharp from 'sharp';
const src='scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
const svg=`<svg width="1920" height="1080">
  <circle cx="757" cy="846" r="45" fill="none" stroke="red" stroke-width="5"/>
  <rect x="470" y="905" width="640" height="70" rx="8" fill="black" fill-opacity="0.7"/>
  <text x="485" y="935" font-size="26" fill="red" font-family="sans-serif">REAL cursor is HERE (on Books icon)</text>
  <text x="485" y="965" font-size="24" fill="white" font-family="sans-serif">model heatmap score here = 0.0012 (misses it)</text>
  <circle cx="1110" cy="297" r="45" fill="none" stroke="#00ff66" stroke-width="5"/>
  <rect x="1180" y="150" width="620" height="70" rx="8" fill="black" fill-opacity="0.7"/>
  <text x="1195" y="180" font-size="26" fill="#00ff66" font-family="sans-serif">v13 SAID cursor is here (Maps widget)</text>
  <text x="1195" y="210" font-size="24" fill="white" font-family="sans-serif">model heatmap score here = 0.9991 (false positive)</text>
</svg>`;
await sharp(src).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toFile('scratch/miss-annotated.jpg');
console.log('wrote scratch/miss-annotated.jpg');
