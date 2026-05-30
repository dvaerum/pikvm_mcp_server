/**
 * Live A/B bench: cursor-v5 (old labels) vs cursor-v6 (human-verified
 * labels), same architecture, same val seed. For each of N trials per
 * target, alternate detector A=v5 and B=v6.
 *
 * Saves every pre-click frame to data/clickv6-bench/ so the frames
 * become candidate additions to the next training set.
 *
 * Per trial:
 *   1. ipadGoHome + 1s settle
 *   2. wake cursor (small mouse move)
 *   3. run chosen detector → (presence, x, y)
 *   4. emit ONE big chunk: target - detected_pos converted to mickeys
 *   5. click
 *   6. capture post-click and check strict screen change
 *
 *   PIKVM_ML_V5_PRESENCE_THRESHOLD=0.2 npx tsx bench-v5-vs-v6.ts [trials_per_target]
 */
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { verifyClickByDiff } from '../src/pikvm/click-verify.js';

const TRIALS_PER_TARGET = process.argv[2] ? Number(process.argv[2]) : 10;
const STRICT_THRESHOLD = 0.10;
const PX_PER_MICKEY = 1.3;
const FRAME_W = 1680;
const FRAME_H = 1050;
const PRESENCE_THRESHOLD = Number(
  process.env.PIKVM_ML_V5_PRESENCE_THRESHOLD ?? '0.2',
);

const INPUT_W = 768;
const INPUT_H = 480;
const HEATMAP_W = 192;
const HEATMAP_H = 120;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

interface Target { name: string; slug: string; x: number; y: number; }
const TARGETS: Target[] = [
  { name: 'Settings', slug: 'settings', x: 905, y: 808 },
  { name: 'Books',    slug: 'books',    x: 642, y: 808 },
  { name: 'Files',    slug: 'files',    x: 1037, y: 425 },
];

interface DetectorSpec { name: 'v5' | 'v6'; modelPath: string; }
const DETECTORS: DetectorSpec[] = [
  { name: 'v5', modelPath: 'ml/cursor-v5.onnx' },
  { name: 'v6', modelPath: 'ml/cursor-v6.onnx' },
];

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/clickv6-bench';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('loading onnx models…');
const sessions: Record<string, ort.InferenceSession> = {};
for (const d of DETECTORS) {
  sessions[d.name] = await ort.InferenceSession.create(d.modelPath);
  console.error(`  ${d.name}: ${d.modelPath} loaded`);
}

async function detect(
  modelName: 'v5' | 'v6',
  jpeg: Buffer,
): Promise<{ presence: number; x: number; y: number }> {
  const { data: rgb } = await sharp(jpeg)
    .resize(INPUT_W, INPUT_H, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inp = new Float32Array(3 * INPUT_W * INPUT_H);
  const plane = INPUT_W * INPUT_H;
  for (let y = 0; y < INPUT_H; y++) {
    for (let x = 0; x < INPUT_W; x++) {
      const s = (y * INPUT_W + x) * 3;
      const d = y * INPUT_W + x;
      inp[0 * plane + d] = (rgb[s]     / 255 - MEAN[0]) / STD[0];
      inp[1 * plane + d] = (rgb[s + 1] / 255 - MEAN[1]) / STD[1];
      inp[2 * plane + d] = (rgb[s + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  const tensor = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await sessions[modelName].run({ frame: tensor });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  let bestIdx = 0, bestLogit = -Infinity;
  for (let i = 0; i < heat.length; i++) {
    if (heat[i] > bestLogit) { bestLogit = heat[i]; bestIdx = i; }
  }
  const py_hm = Math.floor(bestIdx / HEATMAP_W);
  const px_hm = bestIdx % HEATMAP_W;
  return {
    presence: 1 / (1 + Math.exp(-presLogit)),
    x: (px_hm / HEATMAP_W) * FRAME_W,
    y: (py_hm / HEATMAP_H) * FRAME_H,
  };
}

function clamp127(v: number): number { return Math.max(-127, Math.min(127, Math.round(v))); }

await unlockIpad(client).catch((e) => console.error(`unlock warning: ${(e as Error).message}`));
await new Promise((r) => setTimeout(r, 1000));

interface Counters { hits: number; total: number; }
const stats: Record<string, Record<string, Counters>> = {};
for (const t of TARGETS) {
  stats[t.name] = {};
  for (const d of DETECTORS) stats[t.name][d.name] = { hits: 0, total: 0 };
}

let totalTrials = 0;
for (let t = 1; t <= TRIALS_PER_TARGET; t++) {
  for (const tgt of TARGETS) {
    for (const det of DETECTORS) {
      totalTrials++;
      const dir = path.join(
        ROOT, tgt.slug, `trial-${String(t).padStart(2, '0')}-${det.name}`,
      );
      await fs.mkdir(dir, { recursive: true });

      // Home and settle.
      await ipadGoHome(client);
      await new Promise((r) => setTimeout(r, 900));
      const home = await client.screenshot();
      await fs.writeFile(path.join(dir, '00-after-home.jpg'), home.buffer);

      // Wake cursor.
      await client.mouseMoveRelative(20, 0);
      await client.mouseMoveRelative(-20, 0);
      await new Promise((r) => setTimeout(r, 200));
      const pre = await client.screenshot();
      await fs.writeFile(path.join(dir, '01-pre-click.jpg'), pre.buffer);

      // Detect.
      const result = await detect(det.name, pre.buffer);

      let success = false;
      let changedFrac = 0;
      let reason = '';
      let emit = { x: 0, y: 0 };
      if (result.presence < PRESENCE_THRESHOLD) {
        reason = 'low-presence';
      } else {
        const dxPx = tgt.x - result.x;
        const dyPx = tgt.y - result.y;
        const dxM = clamp127(dxPx / PX_PER_MICKEY);
        const dyM = clamp127(dyPx / PX_PER_MICKEY);
        emit = { x: dxM, y: dyM };
        await client.mouseMoveRelative(dxM, dyM);
        await new Promise((r) => setTimeout(r, 250));
        const afterEmit = await client.screenshot();
        await fs.writeFile(path.join(dir, '02-after-emit.jpg'), afterEmit.buffer);
        await client.mouseClick('left');
        await new Promise((r) => setTimeout(r, 500));
        const post = await client.screenshot();
        await fs.writeFile(path.join(dir, '03-after-click.jpg'), post.buffer);
        const v = await verifyClickByDiff(home.buffer, post.buffer, {
          minChangedFraction: STRICT_THRESHOLD,
        });
        success = v.screenChanged;
        changedFrac = v.changedFraction;
        reason = success ? 'hit' : 'no-screen-change';
      }

      stats[tgt.name][det.name].total++;
      if (success) stats[tgt.name][det.name].hits++;

      const row = {
        trial: t,
        target: tgt.name,
        target_pos: { x: tgt.x, y: tgt.y },
        detector: det.name,
        detected: result,
        emit_mickeys: emit,
        success,
        reason,
        strict_changed_fraction: changedFrac,
        presence_threshold: PRESENCE_THRESHOLD,
      };
      await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(row, null, 2));

      console.error(
        `  [${tgt.name}/${det.name}] trial ${t}/${TRIALS_PER_TARGET}: ${success ? 'HIT' : 'MISS'}  ` +
        `det=(${result.x.toFixed(0)},${result.y.toFixed(0)}) pres=${result.presence.toFixed(2)}  ` +
        `emit=(${emit.x},${emit.y})  Δ=${(changedFrac * 100).toFixed(1)}%  [${reason}]`,
      );
    }
  }
}

console.error(`\n=== ${totalTrials} trials done ===`);
for (const tgt of TARGETS) {
  for (const det of DETECTORS) {
    const s = stats[tgt.name][det.name];
    const pct = s.total ? (100 * s.hits / s.total).toFixed(0) : 'n/a';
    console.error(`  ${tgt.name.padEnd(9)} ${det.name}: ${s.hits}/${s.total} (${pct}%)`);
  }
}

// Compact summary
const summary: Record<string, { v5: string; v6: string }> = {};
for (const tgt of TARGETS) {
  summary[tgt.name] = {
    v5: `${stats[tgt.name].v5.hits}/${stats[tgt.name].v5.total}`,
    v6: `${stats[tgt.name].v6.hits}/${stats[tgt.name].v6.total}`,
  };
}
await fs.writeFile(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.error(`\nsummary saved: ${path.join(ROOT, 'summary.json')}`);
