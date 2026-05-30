/**
 * Live A/B click bench: v11 (ml/cursor-v11.onnx, trained on YOUR human
 * labels) vs the deployed pipeline (still v9-bordered).
 *
 * Set PIKVM_ML_V8_MODEL=ml/cursor-v11.onnx (we set it in this script)
 * so the production click pipeline uses v11 for cursor detection.
 *
 * Each trial:
 *  1. ipadGoHome + settle
 *  2. Take pre-click screenshot ("the frame v11 would see")
 *  3. Run v11 inference directly on that frame, record its predicted (x, y)
 *  4. Run v9-bordered inference too (for reference)
 *  5. Execute the click via clickAtWithRetry (which will use v11 because
 *     of the env var)
 *  6. Take post-click screenshot
 *  7. Classify HIT / SKIP / MISS / NOLAUNCH (PA20 launch detector)
 *  8. Save:
 *     - pre-click frame
 *     - post-click frame
 *     - JSON sidecar with target, v11 pred, v9 pred, click result, classification
 *
 * Output: data/cursor-collect-v11-livebench-{TS}/
 *   {scene}/frame-NNN-pre.jpg
 *   {scene}/frame-NNN-post.jpg
 *   {scene}/frame-NNN.json
 *   verified-for-review.jsonl   (for label-review tool — v11 pred is the algo arrow)
 *   home-reference.jpg
 *   summary.json
 *
 * Usage:
 *   npx tsx bench-v11-live.ts [trials_per_target=5]
 */

// Set env BEFORE importing anything that reads it.
process.env.PIKVM_ML_V8_MODEL = 'ml/cursor-v11.onnx';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor, defaultMaxResidualPxFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const INPUT_W = 768;
const INPUT_H = 480;
const HEATMAP_W = 192;
const HEATMAP_H = 120;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const FRAME_W = 1920;
const FRAME_H = 1080;

async function predictFullFrame(
  session: ort.InferenceSession,
  jpeg: Buffer,
): Promise<{ x: number; y: number; presence: number }> {
  const { data: rgb } = await sharp(jpeg)
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
  const tensor = new ort.Tensor('float32', inp, [1, 3, INPUT_H, INPUT_W]);
  const out = await session.run({ frame: tensor });
  const heat = out.heatmap_logits.data as Float32Array;
  const presLogit = (out.presence_logit.data as Float32Array)[0];
  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < heat.length; i++) {
    if (heat[i] > bestLogit) { bestLogit = heat[i]; bestIdx = i; }
  }
  return {
    x: ((bestIdx % HEATMAP_W) / HEATMAP_W) * FRAME_W,
    y: (Math.floor(bestIdx / HEATMAP_W) / HEATMAP_H) * FRAME_H,
    presence: 1 / (1 + Math.exp(-presLogit)),
  };
}

async function rgbFromJpeg(jpeg: Buffer): Promise<Buffer> {
  const { data } = await sharp(jpeg)
    .resize(96, 54, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

async function similarityToHome(postJpeg: Buffer, homeRgb: Buffer): Promise<number> {
  const rgb = await rgbFromJpeg(postJpeg);
  if (rgb.length !== homeRgb.length) return 0;
  let sum = 0;
  for (let i = 0; i < rgb.length; i++) sum += Math.abs(rgb[i] - homeRgb[i]);
  return 1 - sum / rgb.length / 255;
}

const TRIALS = Number(process.argv[2] ?? 5);
const TARGETS = [
  { name: 'Settings',  slug: 'settings',  x: 1027, y: 837 },
  { name: 'Books',     slug: 'books',     x: 757,  y: 837 },
  { name: 'AppStore',  slug: 'appstore',  x: 1027, y: 702 },
  { name: 'Files',     slug: 'files',     x: 1162, y: 435 },
];
const HOME_SIM_THRESHOLD = 0.95;

async function main() {
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);
  const profile = await loadProfile('./data/ballistics.json').catch(() => null);
  const MAX_RETRIES = defaultMaxRetriesFor(false);
  const MAX_RESIDUAL_PX = defaultMaxResidualPxFor(false);

  const ROOT = process.env.BENCH_OUT_DIR ?? (() => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `./data/cursor-collect-v11-livebench-${ts}`;
  })();
  await fs.mkdir(ROOT, { recursive: true });
  console.error(`v11 live bench: PIKVM_ML_V8_MODEL=${process.env.PIKVM_ML_V8_MODEL}`);
  console.error(`output: ${ROOT}`);
  console.error(`trials: ${TRIALS} × ${TARGETS.length} targets = ${TRIALS * TARGETS.length} clicks\n`);

  // Direct ONNX sessions for prediction logging
  const v11Session = await ort.InferenceSession.create('ml/cursor-v11.onnx');
  const v9Session = await ort.InferenceSession.create('ml/cursor-v9-bordered.onnx');
  console.error('loaded v11 + v9-bordered ONNX for per-trial prediction logging');

  // Home reference for PA20 launch detector
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
  const homeShot = await client.screenshot({ quality: 75 });
  const homeRgb = await rgbFromJpeg(homeShot.buffer);
  await fs.writeFile(path.join(ROOT, 'home-reference.jpg'), homeShot.buffer);

  // Open verified-for-review.jsonl now (empty) and append per trial so the
  // label-review server picks up frames as the bench progresses.
  const reviewPath = path.join(ROOT, 'verified-for-review.jsonl');
  await fs.writeFile(reviewPath, '');
  const reviewFh = await fs.open(reviewPath, 'a');
  console.error(`per-trial appends: ${reviewPath}`);

  const results: Record<string, { hit: number; skip: number; miss: number; nolaunch: number }> = {};

  for (const t of TARGETS) {
    results[t.slug] = { hit: 0, skip: 0, miss: 0, nolaunch: 0 };
    const sceneDir = path.join(ROOT, t.slug);
    await fs.mkdir(sceneDir, { recursive: true });
    console.error(`\n=== ${t.name} (${t.x}, ${t.y}) — ${TRIALS} trials ===`);

    for (let i = 1; i <= TRIALS; i++) {
      await ipadGoHome(client);
      await new Promise(r => setTimeout(r, 800));

      // 2. Pre-click screenshot (the frame v11 will see after the click pipeline takes its own).
      const preShot = await client.screenshot({ quality: 75 });
      const preFile = `frame-${String(i).padStart(2, '0')}-pre.jpg`;
      await fs.writeFile(path.join(sceneDir, preFile), preShot.buffer);

      // 3. Run v11 + v9 directly for prediction comparison.
      const v11Pred = await predictFullFrame(v11Session, preShot.buffer);
      const v9Pred = await predictFullFrame(v9Session, preShot.buffer);

      // 5. Click via the production pipeline (which will use v11 via env var).
      const r = await clickAtWithRetry(client, { x: t.x, y: t.y }, {
        maxRetries: MAX_RETRIES,
        moveToOptions: {
          profile: profile ?? undefined,
          forbidSlamFallback: false,  // PA35-followup: allow slam-to-corner when cursor far from target
          strategy: 'detect-then-move',
        },
        maxResidualPx: MAX_RESIDUAL_PX,
        requireVerifiedCursor: true,
        verifyOptions: {
          region: { x: t.x, y: t.y, halfWidth: 50, halfHeight: 50 },
          minChangedFraction: 0.05,
        },
      });

      // 6. Post-click screenshot.
      const postShot = await client.screenshot({ quality: 75 });
      const sim = await similarityToHome(postShot.buffer, homeRgb);

      // 7. Classify.
      let cls: 'hit' | 'skip' | 'miss' | 'nolaunch';
      if (r.success) {
        cls = sim >= HOME_SIM_THRESHOLD ? 'nolaunch' : 'hit';
      } else if (r.attemptHistory.every(a => a.skippedClickReason)) {
        cls = 'skip';
      } else {
        cls = 'miss';
      }
      results[t.slug][cls]++;

      const postFile = `frame-${String(i).padStart(2, '0')}-${cls}-post.jpg`;
      await fs.writeFile(path.join(sceneDir, postFile), postShot.buffer);

      // 8. JSON sidecar.
      const sidecar = {
        target: t,
        trial: i,
        classification: cls,
        sim_to_home: sim,
        v11_prediction: { x: Math.round(v11Pred.x), y: Math.round(v11Pred.y), presence: v11Pred.presence },
        v9_prediction: { x: Math.round(v9Pred.x), y: Math.round(v9Pred.y), presence: v9Pred.presence },
        v11_v9_disagreement_px: Math.round(Math.hypot(v11Pred.x - v9Pred.x, v11Pred.y - v9Pred.y)),
        click_attempts: r.attempts,
        click_final_pos: r.finalMoveResult.finalDetectedPosition,
        skip_reasons: r.attemptHistory.filter(a => a.skippedClickReason).map(a => a.skippedClickReason),
      };
      await fs.writeFile(
        path.join(sceneDir, `frame-${String(i).padStart(2, '0')}.json`),
        JSON.stringify(sidecar, null, 2),
      );

      // Append pre-click frame to the label-review jsonl immediately so the
      // server can serve it while the bench continues.
      const reviewEntry = JSON.stringify({
        abs_frame_path: path.resolve(sceneDir, preFile),
        cursor: null,  // YOU label this — was v11's pick correct?
        scene: `${t.slug}:${cls}`,
        algorithm_label: { x: Math.round(v11Pred.x), y: Math.round(v11Pred.y) },
        v9_label: { x: Math.round(v9Pred.x), y: Math.round(v9Pred.y) },
        target: { x: t.x, y: t.y, name: t.name },
        classification: cls,
        v11_v9_disagreement_px: sidecar.v11_v9_disagreement_px,
      });
      await reviewFh.write(reviewEntry + '\n');
      await reviewFh.datasync();  // flush to disk so the server reads it on next /api/frames poll

      console.error(
        `  ${i}/${TRIALS} ${cls.toUpperCase()} ` +
        `v11=(${Math.round(v11Pred.x)},${Math.round(v11Pred.y)}) ` +
        `v9=(${Math.round(v9Pred.x)},${Math.round(v9Pred.y)}) ` +
        `Δ=${sidecar.v11_v9_disagreement_px}px sim=${sim.toFixed(3)}`,
      );
    }
  }

  await reviewFh.close();

  const summary = {
    detector: 'cursor-v11.onnx',
    out_dir: ROOT,
    finished_at: new Date().toISOString(),
    targets: TARGETS,
    trials_per_target: TRIALS,
    results,
    totals: Object.values(results).reduce((acc, r) => ({
      hit: acc.hit + r.hit, skip: acc.skip + r.skip, miss: acc.miss + r.miss, nolaunch: acc.nolaunch + r.nolaunch,
    }), { hit: 0, skip: 0, miss: 0, nolaunch: 0 }),
  };
  await fs.writeFile(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));

  const tot = summary.totals;
  const n = tot.hit + tot.skip + tot.miss + tot.nolaunch;
  console.error(`\n========== SUMMARY (v11) ==========`);
  console.error(`HIT (real launch):  ${tot.hit}/${n} (${((100 * tot.hit) / n).toFixed(0)}%)`);
  console.error(`SKIP (safety gate): ${tot.skip}/${n} (${((100 * tot.skip) / n).toFixed(0)}%)`);
  console.error(`MISS:               ${tot.miss}/${n}`);
  console.error(`NOLAUNCH:           ${tot.nolaunch}/${n}`);
  console.error(`\noutput: ${ROOT}`);
  console.error(`labels for review: ${reviewPath} (one append per trial)`);

  await ipadGoHome(client).catch(() => undefined);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
