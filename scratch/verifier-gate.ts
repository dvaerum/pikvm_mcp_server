/**
 * PRODUCTION-FAITHFUL verifier gate (sharp decode + ONNX, exactly the production
 * runCascade path) — replaces the Python trainer gate (PIL) which disagreed with
 * production (books-cursor 0.68 PIL vs 0.23 sharp/ONNX), so selection was optimising
 * the wrong signal. Scores the real-frame gate points for one or more verifier .onnx
 * models so we can SELECT and compare on production truth.
 * Usage: tsx verifier-gate.ts [model1.onnx model2.onnx ...]  (default crop-verifier.onnx)
 */
import ort from 'onnxruntime-node';
import sharp from 'sharp';
const CROP = 96, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const BOOKS = 'scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg';
const MAPSICON = 'scratch/click-bench80-2026-07-20T07-01-52/MISS-t10-Books-frac0.01-rnull.jpg';
// [label, frame, cx, cy, expected]  (1 = ACCEPT cursor present, 0 = REJECT no cursor)
const GATE: [string, string, number, number, number][] = [
  ['REJ books-icon', 'scratch/hc13.jpg', 760, 819, 0],
  ['REJ books-edge', 'scratch/hc13.jpg', 690, 819, 0],
  ['REJ maps-widget', 'scratch/hc13.jpg', 1110, 297, 0],
  ['REJ maps-app-icon', 'scratch/hc13.jpg', 1162, 570, 0],
  ['REJ map-terrain', 'scratch/hc17.jpg', 1218, 186, 0],
  ['ACC clean-cursor', 'scratch/clean-cursor.jpg', 620, 432, 1],
  ['ACC books-cursor', BOOKS, 757, 846, 1],
  ['ACC mapsicon-cursor', MAPSICON, 1180, 600, 1],
];
async function score(ver: ort.InferenceSession, f: string, cx: number, cy: number) {
  const { data } = await sharp(f).extract({ left: cx - 48, top: cy - 48, width: CROP, height: CROP }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pl = CROP * CROP, inp = new Float32Array(3 * pl);
  for (let i = 0; i < pl; i++) { inp[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0]; inp[pl + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1]; inp[2 * pl + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2]; }
  const r = await ver.run({ crop: new ort.Tensor('float32', inp, [1, 3, CROP, CROP]) });
  return sig((r.logit.data as Float32Array)[0]);
}
const models = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (models.length === 0) models.push('ml/crop-verifier.onnx');
for (const m of models) {
  const ver = await ort.InferenceSession.create(m);
  let accMin = 1, rejMax = 0, ok = 0;
  const cells: string[] = [];
  for (const [label, f, cx, cy, exp] of GATE) {
    const p = await score(ver, f, cx, cy);
    const good = (p > 0.5) === (exp === 1);
    if (good) ok++;
    if (exp === 1) accMin = Math.min(accMin, p); else rejMax = Math.max(rejMax, p);
    cells.push(`${label}=${p.toFixed(2)}${good ? '' : 'X'}`);
  }
  console.log(`\n${m}`);
  console.log('  ' + cells.join('  '));
  console.log(`  => ${ok}/${GATE.length} correct | accept-min=${accMin.toFixed(2)} reject-max=${rejMax.toFixed(2)} margin=${(accMin - rejMax).toFixed(2)}`);
}
