// Head-to-head: v9-bordered, v10, v11 on the 20 v10-livebench frames
// the user labeled by hand. This is the honest distribution-shift test.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

const INPUT_W = 768, INPUT_H = 480;
const HEATMAP_W = 192, HEATMAP_H = 120;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

async function predict(session: ort.InferenceSession, jpegPath: string) {
  const { data: rgb } = await sharp(await fs.readFile(jpegPath))
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
  const t = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await session.run({ frame: t });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  let bestIdx = 0, bestLogit = -Infinity;
  for (let i = 0; i < heat.length; i++) if (heat[i] > bestLogit) { bestLogit = heat[i]; bestIdx = i; }
  return {
    x: ((bestIdx % HEATMAP_W) / HEATMAP_W) * 1920,
    y: (Math.floor(bestIdx / HEATMAP_W) / HEATMAP_H) * 1080,
    presence: 1 / (1 + Math.exp(-presLogit)),
  };
}

const v9 = await ort.InferenceSession.create('ml/cursor-v9-bordered.onnx');
const v10 = await ort.InferenceSession.create('ml/cursor-v10.onnx');
const v11 = await ort.InferenceSession.create('ml/cursor-v11.onnx');
console.log('loaded all three models\n');

const BENCH = 'data/cursor-collect-v10-livebench-2026-05-30T07-00-55';
const hum = (await fs.readFile(path.join(BENCH, 'human-verified.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(l => JSON.parse(l));
const humByPath = new Map<string, any>();
for (const h of hum) humByPath.set(h.frame.split('/').slice(-2).join('/'), h);
const src = (await fs.readFile(path.join(BENCH, 'verified-for-review.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

const dists: Record<string, number[]> = { v9: [], v10: [], v11: [] };
const presence: Record<string, number[]> = { v9: [], v10: [], v11: [] };
const rows: any[] = [];

for (const s of src) {
  const key = s.abs_frame_path.split('/').slice(-2).join('/');
  const h = humByPath.get(key);
  if (!h?.cursor?.visible) continue;
  const truth = { x: h.cursor.x, y: h.cursor.y };
  const p9 = await predict(v9, s.abs_frame_path);
  const p10 = await predict(v10, s.abs_frame_path);
  const p11 = await predict(v11, s.abs_frame_path);
  const d9 = Math.hypot(p9.x - truth.x, p9.y - truth.y);
  const d10 = Math.hypot(p10.x - truth.x, p10.y - truth.y);
  const d11 = Math.hypot(p11.x - truth.x, p11.y - truth.y);
  dists.v9.push(d9); dists.v10.push(d10); dists.v11.push(d11);
  presence.v9.push(p9.presence); presence.v10.push(p10.presence); presence.v11.push(p11.presence);
  rows.push({ scene: s.scene, d9: Math.round(d9), d10: Math.round(d10), d11: Math.round(d11), p11_pres: p11.presence.toFixed(2) });
}

const p = (arr: number[], q: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
};
const within = (arr: number[], t: number) =>
  `${arr.filter(d => d <= t).length}/${arr.length} (${(100 * arr.filter(d => d <= t).length / arr.length).toFixed(0)}%)`;

for (const name of ['v9', 'v10', 'v11'] as const) {
  console.log(`${name}: p50=${p(dists[name], 0.5)} p75=${p(dists[name], 0.75)} p95=${p(dists[name], 0.95)} max=${p(dists[name], 1.0)}`);
  console.log(`     ≤35px: ${within(dists[name], 35)}    ≤80px: ${within(dists[name], 80)}`);
}
console.log('\nPer frame (d9 / d10 / d11 / v11 presence):');
for (const r of rows) {
  console.log(`  ${r.scene.padEnd(20)} v9=${String(r.d9).padStart(4)} v10=${String(r.d10).padStart(4)} v11=${String(r.d11).padStart(4)}  pres=${r.p11_pres}`);
}
