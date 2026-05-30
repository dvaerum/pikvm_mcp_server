// Run v11 directly on the SKIP frames, report heatmap_peak. The
// production pipeline rejects v11 results when peak < 0.2 and falls
// back to v1 (the borderless-cursor model that hallucinates the
// (1170, 558) static FP). Need to see whether v11 is below that gate.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const INPUT_W = 768, INPUT_H = 480;
const HEATMAP_W = 192, HEATMAP_H = 120;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const v11 = await ort.InferenceSession.create('ml/cursor-v11.onnx');

async function predict(jpegPath: string) {
  const { data: rgb } = await sharp(await fs.readFile(jpegPath))
    .resize(INPUT_W, INPUT_H, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * INPUT_W * INPUT_H);
  const plane = INPUT_W * INPUT_H;
  for (let y = 0; y < INPUT_H; y++) for (let x = 0; x < INPUT_W; x++) {
    const s = (y * INPUT_W + x) * 3;
    const d = y * INPUT_W + x;
    inp[0 * plane + d] = (rgb[s] / 255 - MEAN[0]) / STD[0];
    inp[1 * plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
    inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
  }
  const t = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await v11.run({ frame: t });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  // Apply sigmoid to heatmap to get probs; find peak (this is heatmapPeak).
  let peakProb = 0;
  for (let i = 0; i < heat.length; i++) {
    const p = 1 / (1 + Math.exp(-heat[i]));
    if (p > peakProb) peakProb = p;
  }
  const presence = 1 / (1 + Math.exp(-presLogit));
  return { peakProb, presence };
}

const ROOT = 'data/cursor-collect-v11-livebench-2026-05-30T10-24-10';
const scenes = ['settings', 'books', 'appstore', 'files'];
const HEATMAP_FLOOR = 0.2;
let nBelow = 0, nAbove = 0;
const all: number[] = [];
for (const sc of scenes) {
  const files = (await fs.readdir(path.join(ROOT, sc))).filter(f => f.endsWith('-pre.jpg')).sort();
  for (const f of files) {
    const r = await predict(path.join(ROOT, sc, f));
    all.push(r.peakProb);
    if (r.peakProb < HEATMAP_FLOOR) nBelow++; else nAbove++;
    const flag = r.peakProb < HEATMAP_FLOOR ? ' ← BELOW GATE (falls back to v1)' : '';
    console.log(`${sc}/${f}  heatmapPeak=${r.peakProb.toFixed(3)}  presence=${r.presence.toFixed(3)}${flag}`);
  }
}
console.log();
console.log(`Gate at peak >= ${HEATMAP_FLOOR}: ${nAbove}/${all.length} accept v11; ${nBelow}/${all.length} fall back to v1`);
const sorted = [...all].sort((a, b) => a - b);
console.log(`peak p25=${sorted[Math.floor(sorted.length * 0.25)].toFixed(3)}  p50=${sorted[Math.floor(sorted.length * 0.5)].toFixed(3)}  p75=${sorted[Math.floor(sorted.length * 0.75)].toFixed(3)}`);
