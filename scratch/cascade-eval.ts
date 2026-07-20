/**
 * END-TO-END CASCADE eval: proposer (v14 full-frame heatmap) → top-K candidate
 * peaks (NMS) → crop-VERIFIER scores each 96px native crop → detection = the
 * candidate with the highest verifier score above threshold, else NULL.
 *
 * This is the real generalization test the single stage failed: on NO-CURSOR home
 * frames the cascade must return NULL (every candidate — Books icon, Maps widget,
 * every app icon — rejected by the verifier); on cursor frames it must detect near
 * the true cursor. Prints per-frame the top candidates with proposer peak + verifier
 * score so we can SEE what it considered and why it accepted/rejected.
 *
 * Usage: tsx cascade-eval.ts [proposer.onnx] [verifier.onnx]
 */
import ort from 'onnxruntime-node';
import sharp from 'sharp';

const IW = 768, IH = 480, HW = 192, HH = 120, CROP = 96;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const FW = 1920, FH = 1080;
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const K = 20, NMS = 70, VERIFY_THRESH = 0.5;

const PROPOSER = process.argv[2] ?? 'ml/cursor-v14-ep05.onnx';
const VERIFIER = process.argv[3] ?? 'ml/crop-verifier.onnx';

// frame, optional true cursor (native) — null = no cursor (cascade must return NULL)
const FRAMES: { path: string; cursor: { x: number; y: number } | null }[] = [
  { path: 'scratch/hc13.jpg', cursor: null },
  { path: 'scratch/hc15.jpg', cursor: null },
  { path: 'scratch/hc17.jpg', cursor: null },
  { path: 'scratch/hc18.jpg', cursor: null },
  { path: 'scratch/clean-cursor.jpg', cursor: { x: 620, y: 432 } },
  { path: 'scratch/instrumented-bench/MISS-t5-Settings-V8start_1110_297-V8fin_660_1026-PRE.jpg', cursor: { x: 757, y: 846 } },
];

async function proposerPeaks(sess: ort.InferenceSession, src: string) {
  const { data: rgb } = await sharp(src).resize(IW, IH, { fit: 'fill', kernel: 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * IW * IH), plane = IW * IH;
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const s = (y * IW + x) * 3, d = y * IW + x;
    inp[d] = (rgb[s] / 255 - MEAN[0]) / STD[0];
    inp[plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
    inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
  }
  const r = await sess.run({ frame: new ort.Tensor('float32', inp, [1, 3, IH, IW]) });
  const hm = r.heatmap_logits.data as Float32Array;
  const order = [...hm.keys()].sort((a, b) => hm[b] - hm[a]);
  const peaks: { x: number; y: number; peak: number }[] = [];
  for (const i of order) {
    const nx = Math.round((i % HW) / HW * FW), ny = Math.round(Math.floor(i / HW) / HH * FH);
    if (peaks.some((p) => Math.hypot(p.x - nx, p.y - ny) < NMS)) continue;
    peaks.push({ x: nx, y: ny, peak: sig(hm[i]) });
    if (peaks.length >= K) break;
  }
  return peaks;
}

async function verifyCrop(sess: ort.InferenceSession, src: string, cx: number, cy: number) {
  const left = Math.max(0, Math.min(FW - CROP, cx - CROP / 2));
  const top = Math.max(0, Math.min(FH - CROP, cy - CROP / 2));
  const { data: rgb } = await sharp(src).extract({ left, top, width: CROP, height: CROP }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * CROP * CROP), plane = CROP * CROP;
  for (let i = 0; i < CROP * CROP; i++) {
    inp[i] = (rgb[i * 3] / 255 - MEAN[0]) / STD[0];
    inp[plane + i] = (rgb[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    inp[2 * plane + i] = (rgb[i * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const r = await sess.run({ crop: new ort.Tensor('float32', inp, [1, 3, CROP, CROP]) });
  return sig((r.logit.data as Float32Array)[0]);
}

const prop = await ort.InferenceSession.create(PROPOSER);
const ver = await ort.InferenceSession.create(VERIFIER);
console.log(`proposer=${PROPOSER}  verifier=${VERIFIER}  K=${K} thresh=${VERIFY_THRESH}\n`);
let correct = 0;
for (const f of FRAMES) {
  const peaks = await proposerPeaks(prop, f.path);
  const scored = [];
  for (const p of peaks) scored.push({ ...p, v: await verifyCrop(ver, f.path, p.x, p.y) });
  scored.sort((a, b) => b.v - a.v);
  const best = scored[0];
  const detected = best.v >= VERIFY_THRESH ? best : null;
  const expect = f.cursor;
  let verdict: string;
  if (!expect) {
    const ok = detected === null;
    verdict = ok ? 'PASS (null)' : `FAIL (detected @${detected!.x},${detected!.y} v=${detected!.v.toFixed(2)})`;
    if (ok) correct++;
  } else {
    const ok = detected !== null && Math.hypot(detected.x - expect.x, detected.y - expect.y) < 80;
    verdict = ok ? `PASS (@${detected!.x},${detected!.y} v=${detected!.v.toFixed(2)})`
      : detected ? `FAIL (@${detected.x},${detected.y} v=${detected.v.toFixed(2)}, ${Math.round(Math.hypot(detected.x-expect.x,detected.y-expect.y))}px off)` : 'FAIL (null, missed cursor)';
    if (ok) correct++;
  }
  const top3 = scored.slice(0, 3).map((s) => `(${s.x},${s.y})p=${s.peak.toFixed(2)}/v=${s.v.toFixed(2)}`).join(' ');
  console.log(`${f.path.split('/').pop()!.padEnd(20)} ${expect ? 'CURSOR' : 'NO-CUR'}  ${verdict}`);
  console.log(`   top3: ${top3}`);
}
console.log(`\n=== ${correct}/${FRAMES.length} correct ===`);
