// Full end-to-end cascade profiling harness (task_78184455df4e).
// Mirrors runCascade()'s internal phases (src/pikvm/cursor-ml-detect.ts,
// not exported, so duplicated here) with per-phase timing, PLUS a
// thread-config sweep on the real batched inference call — the
// production path batches ALL grid crops into ONE inference call
// (N=352 on a real 1920x1080 frame at default GRID_STRIDE=48, confirmed
// via grid-size-check.mts against real captured frames using the REAL
// detectIpadRegion, imported below — not duplicated), not the single-crop
// N=1 case the earlier INT8 bench measured.
//
// Run from the repo root (reuses its own node_modules):
//   npx tsx scratch/cpu-inference-speedup/full-path-profile.mts [path/to/frame.jpg]
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { detectIpadRegion, NATIVE_MARGIN } from '../../src/pikvm/ipad-region-detect.js';

const REPO_ROOT = process.cwd();
const CASCADE_CROP = 96;
const GRID_STRIDE = 48;
const HM_OUT = 24;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MODEL = `${REPO_ROOT}/ml/crop-heatmap.onnx`;
const FRAME = process.argv[2] ?? `${REPO_ROOT}/data/openloopshape-real/frame-lower-left-01.jpg`;
const ITERS = 10;

function median(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function profileOnce(session: ort.InferenceSession, jpegBuffer: Buffer) {
  const t: Record<string, number> = {};
  let mark = performance.now();
  const stamp = (name: string) => { const now = performance.now(); t[name] = now - mark; mark = now; };

  const r = await detectIpadRegion(jpegBuffer);
  stamp('regionDetect');

  const reg = { x: r.x + NATIVE_MARGIN, y: r.y + NATIVE_MARGIN, w: r.w - 2 * NATIVE_MARGIN, h: r.h - 2 * NATIVE_MARGIN };
  const { data: full, info } = await sharp(jpegBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  stamp('jpegDecode');

  const FW = info.width, half = CASCADE_CROP / 2;
  const axis = (lo: number, hi: number, frameMax: number): number[] => {
    const raw: number[] = [];
    for (let v = lo; v < hi; v += GRID_STRIDE) raw.push(v);
    raw.push(hi);
    const seen = new Set<number>(), out: number[] = [];
    for (const v of raw) {
      const c = Math.round(Math.max(half, Math.min(frameMax - half, v)));
      if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  };
  const ys = axis(reg.y, reg.y + reg.h, info.height);
  const xs = axis(reg.x, reg.x + reg.w, FW);
  const centers = [];
  for (const cy of ys) for (const cx of xs) centers.push({ x: cx, y: cy });
  const N = centers.length, plane = CASCADE_CROP * CASCADE_CROP;
  const batch = new Float32Array(N * 3 * plane);
  for (let n = 0; n < N; n++) {
    const left = Math.max(0, Math.min(FW - CASCADE_CROP, centers[n].x - half));
    const top = Math.max(0, Math.min(info.height - CASCADE_CROP, centers[n].y - half));
    const base = n * 3 * plane;
    for (let yy = 0; yy < CASCADE_CROP; yy++) {
      for (let xx = 0; xx < CASCADE_CROP; xx++) {
        const si = ((top + yy) * FW + (left + xx)) * 3, di = yy * CASCADE_CROP + xx;
        batch[base + di] = (full[si] / 255 - MEAN[0]) / STD[0];
        batch[base + plane + di] = (full[si + 1] / 255 - MEAN[1]) / STD[1];
        batch[base + 2 * plane + di] = (full[si + 2] / 255 - MEAN[2]) / STD[2];
      }
    }
  }
  stamp('gridBuildPreprocess');

  const out = await session.run({ crop: new ort.Tensor('float32', batch, [N, 3, CASCADE_CROP, CASCADE_CROP]) });
  stamp('inference');

  const presence = out.presence_logit.data as Float32Array;
  const heatmap = out.heatmap_logits.data as Float32Array;
  let bi = 0;
  for (let i = 1; i < N; i++) if (presence[i] > presence[bi]) bi = i;
  const maxP = 1 / (1 + Math.exp(-presence[bi]));
  const off = bi * HM_OUT * HM_OUT;
  let mx = -Infinity;
  for (let k = 0; k < HM_OUT * HM_OUT; k++) mx = Math.max(mx, heatmap[off + k]);
  let sum = 0, ex = 0, ey = 0;
  for (let gy = 0; gy < HM_OUT; gy++) for (let gx = 0; gx < HM_OUT; gx++) {
    const w = Math.exp(heatmap[off + gy * HM_OUT + gx] - mx);
    sum += w; ex += gx * w; ey += gy * w;
  }
  ex /= sum; ey /= sum;
  stamp('postprocess');

  return { t, N, confidence: maxP };
}

async function main() {
  const jpegBuffer = readFileSync(FRAME);
  console.log(`frame: ${FRAME}`);
  console.log(`node ${process.version}, cpus: ${(await import('node:os')).cpus().length}`);

  for (const threadsLabel of ['default(unset)', 1, 2, 4] as const) {
    const opts: ort.InferenceSession.SessionOptions = threadsLabel === 'default(unset)'
      ? {}
      : { intraOpNumThreads: threadsLabel, interOpNumThreads: 1 };
    const session = await ort.InferenceSession.create(MODEL, opts);
    const runs: Awaited<ReturnType<typeof profileOnce>>[] = [];
    // one untimed warmup (JIT/cache warm)
    await profileOnce(session, jpegBuffer);
    for (let i = 0; i < ITERS; i++) runs.push(await profileOnce(session, jpegBuffer));

    const N = runs[0].N;
    const phases = Object.keys(runs[0].t);
    const totals = runs.map((r) => phases.reduce((s, p) => s + r.t[p], 0));
    console.log(`\n--- intraOpNumThreads=${threadsLabel} (N=${N} crops/batch, ${ITERS} runs) ---`);
    for (const p of phases) {
      const vals = runs.map((r) => r.t[p]);
      console.log(`  ${p.padEnd(20)} median=${median(vals).toFixed(2)}ms  min=${Math.min(...vals).toFixed(2)}ms  max=${Math.max(...vals).toFixed(2)}ms`);
    }
    console.log(`  ${'TOTAL'.padEnd(20)} median=${median(totals).toFixed(2)}ms`);
    console.log(`  inference share of total: ${((median(runs.map(r => r.t.inference)) / median(totals)) * 100).toFixed(1)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
