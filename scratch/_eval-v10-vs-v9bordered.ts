/**
 * Run both v9-bordered.onnx and v10.onnx on the v10 val-manifest frames,
 * compare to the human-verified labels, and report median distance per
 * model. This is the apples-to-apples test of whether retraining on
 * human (tip) labels improved over the orange-moved (centroid) labels.
 *
 * Eval frames: data/cursor-collect batches frame-NNN jpgs
 * Labels: human-verified (visible cursor, tip position).
 *
 * Uses the same input pipeline as production cursor-ml-detect.ts:
 * resize 1920x1080 → 768x480, ImageNet normalization, full-frame heatmap
 * argmax for prediction.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const INPUT_W = 768;
const INPUT_H = 480;
const HEATMAP_W = 192;
const HEATMAP_H = 120;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function loadInput(p: string, frameWPx: number, frameHPx: number): Promise<Float32Array> {
  const { data: rgb } = await sharp(await fs.readFile(p))
    .resize(INPUT_W, INPUT_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * INPUT_W * INPUT_H);
  const plane = INPUT_W * INPUT_H;
  for (let y = 0; y < INPUT_H; y++) {
    for (let x = 0; x < INPUT_W; x++) {
      const s = (y * INPUT_W + x) * 3;
      const d = y * INPUT_W + x;
      inp[0 * plane + d] = (rgb[s] / 255 - MEAN[0]) / STD[0];
      inp[1 * plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
      inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return inp;
}

async function predict(
  session: ort.InferenceSession,
  imgPath: string,
  origW: number,
  origH: number,
): Promise<{ x: number; y: number; presence: number }> {
  const inp = await loadInput(imgPath, origW, origH);
  const tensor = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await session.run({ frame: tensor });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < heat.length; i++) {
    if (heat[i] > bestLogit) { bestLogit = heat[i]; bestIdx = i; }
  }
  // Map heatmap (192x120) back to original frame (1920x1080).
  const hmX = bestIdx % HEATMAP_W;
  const hmY = Math.floor(bestIdx / HEATMAP_W);
  return {
    x: (hmX / HEATMAP_W) * origW,
    y: (hmY / HEATMAP_H) * origH,
    presence: 1 / (1 + Math.exp(-presLogit)),
  };
}

async function main() {
  const v9 = await ort.InferenceSession.create('ml/cursor-v9-bordered.onnx');
  const v10 = await ort.InferenceSession.create('ml/cursor-v10.onnx');
  console.log('loaded both ONNX models');

  const valLines = (await fs.readFile('ml/cursor-v10-val-manifest.jsonl', 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log(`val manifest: ${valLines.length} frames\n`);

  const distsV9: number[] = [];
  const distsV10: number[] = [];
  const v10Wins: number[] = []; // diff = v9 dist - v10 dist (>0 means v10 better)

  for (const v of valLines) {
    if (!v.cursor?.visible) continue;
    const truth = { x: v.cursor.x, y: v.cursor.y };
    // All these frames are 1920x1080.
    const pV9 = await predict(v9, v.abs_frame_path, 1920, 1080);
    const pV10 = await predict(v10, v.abs_frame_path, 1920, 1080);
    const dV9 = Math.hypot(pV9.x - truth.x, pV9.y - truth.y);
    const dV10 = Math.hypot(pV10.x - truth.x, pV10.y - truth.y);
    distsV9.push(dV9);
    distsV10.push(dV10);
    v10Wins.push(dV9 - dV10);
  }

  const p = (arr: number[], q: number) => {
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.floor(s.length * q));
    return s[idx].toFixed(1);
  };
  const fmt = (arr: number[]) =>
    `p50=${p(arr, 0.5)}  p75=${p(arr, 0.75)}  p95=${p(arr, 0.95)}  max=${p(arr, 1.0)}`;
  const ratePct = (arr: number[], t: number) =>
    `${arr.filter(d => d <= t).length}/${arr.length} (${(100 * arr.filter(d => d <= t).length / arr.length).toFixed(0)}%)`;

  console.log(`v9-bordered.onnx → ${fmt(distsV9)}`);
  console.log(`v10.onnx         → ${fmt(distsV10)}`);
  console.log();
  console.log(`v9 within 35 px: ${ratePct(distsV9, 35)}`);
  console.log(`v10 within 35 px: ${ratePct(distsV10, 35)}`);
  console.log(`v9 within 80 px: ${ratePct(distsV9, 80)}`);
  console.log(`v10 within 80 px: ${ratePct(distsV10, 80)}`);
  console.log();
  const v10Better = v10Wins.filter(d => d > 0).length;
  const v9Better = v10Wins.filter(d => d < 0).length;
  const tied = v10Wins.filter(d => d === 0).length;
  console.log(`per-frame: v10 closer ${v10Better}, v9 closer ${v9Better}, tied ${tied}`);
}

main().catch(e => { console.error(e); process.exit(1); });
