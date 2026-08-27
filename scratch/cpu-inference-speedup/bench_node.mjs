// CPU-side fp32-vs-INT8 inference timing benchmark, via `onnxruntime-node`
// — the SAME package + API this repo's own production code
// (src/pikvm/cursor-ml-detect.ts) uses, not a Python proxy. Run this
// directly on real Pi4 hardware for a representative number; Python
// isn't reliably available there (see e.g. it-03400's "no bare python3
// on PATH" constraint), and onnxruntime's C++ core is shared across
// language bindings anyway, so there's no accuracy reason to prefer
// Python — only a practicality one, and Node wins it here.
//
// Run from a checkout of this repo (reuses its own node_modules, no
// extra install needed):
//   node scratch/cpu-inference-speedup/bench_node.mjs
//
// Loads the same 12 real ground-truth-centered crops used throughout
// this session's investigations (data/openloopshape-real/manifest.jsonl),
// runs N timed inferences per crop against both ml/crop-heatmap.onnx
// (fp32 baseline) and the INT8-quantized crop-heatmap.int8.onnx
// (alongside this script), reports median/min/max per model plus a
// last-crop argmax+presence spot-check so a correctness signal travels
// with the timing numbers (same discipline as the ncnn Phase 2 C++
// harness).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const CASCADE_CROP = 96;
const ITERS = 50; // per crop, per model
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function loadCropCHW(imgPath, gtX, gtY) {
  const { data, info } = await sharp(imgPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const half = CASCADE_CROP >> 1;
  const left = Math.max(0, Math.min(w - CASCADE_CROP, gtX - half));
  const top = Math.max(0, Math.min(h - CASCADE_CROP, gtY - half));

  const plane = CASCADE_CROP * CASCADE_CROP;
  const chw = new Float32Array(3 * plane);
  for (let y = 0; y < CASCADE_CROP; y++) {
    for (let x = 0; x < CASCADE_CROP; x++) {
      const si = ((top + y) * w + (left + x)) * 3;
      const di = y * CASCADE_CROP + x;
      chw[0 * plane + di] = (data[si] / 255 - MEAN[0]) / STD[0];
      chw[1 * plane + di] = (data[si + 1] / 255 - MEAN[1]) / STD[1];
      chw[2 * plane + di] = (data[si + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return chw;
}

async function runOnce(session, chw) {
  const inputTensor = new ort.Tensor('float32', chw, [1, 3, CASCADE_CROP, CASCADE_CROP]);
  const t0 = performance.now();
  const results = await session.run({ crop: inputTensor });
  const t1 = performance.now();
  return {
    heatmap: results.heatmap_logits.data,
    presenceLogit: results.presence_logit.data[0],
    ms: t1 - t0,
  };
}

async function benchModel(label, modelPath, manifest, dataDir) {
  const session = await ort.InferenceSession.create(modelPath);
  const allTimings = [];
  let last = null;

  for (const entry of manifest) {
    const imgPath = path.join(dataDir, entry.file);
    const chw = await loadCropCHW(imgPath, entry.gt_x, entry.gt_y);

    // One untimed warm-up per crop.
    await runOnce(session, chw);

    for (let i = 0; i < ITERS; i++) {
      const r = await runOnce(session, chw);
      allTimings.push(r.ms);
      last = r;
    }
  }

  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < last.heatmap.length; i++) {
    if (last.heatmap[i] > bestLogit) {
      bestLogit = last.heatmap[i];
      bestIdx = i;
    }
  }
  const confidence = sigmoid(last.presenceLogit);

  console.log(
    `[${label}] ${manifest.length} crops x ${ITERS} iters = ${allTimings.length} inferences — ` +
    `median=${median(allTimings).toFixed(3)}ms min=${Math.min(...allTimings).toFixed(3)}ms ` +
    `max=${Math.max(...allTimings).toFixed(3)}ms | last-crop check: argmax_idx=${bestIdx} ` +
    `presence=${confidence.toFixed(4)} (${confidence >= 0.5 ? 'CONFIDENT' : 'low-conf'})`,
  );
}

async function main() {
  const dataDir = path.join(REPO_ROOT, 'data', 'openloopshape-real');
  const manifest = readFileSync(path.join(dataDir, 'manifest.jsonl'), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  console.log(`loaded ${manifest.length} manifest entries from ${dataDir}`);

  await benchModel('fp32', path.join(REPO_ROOT, 'ml', 'crop-heatmap.onnx'), manifest, dataDir);
  await benchModel('int8', path.join(SCRIPT_DIR, 'crop-heatmap.int8.onnx'), manifest, dataDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
