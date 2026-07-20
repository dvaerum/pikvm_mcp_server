/**
 * ML cursor detector — primary cursor detection at v0.5.237+.
 *
 * Uses a CenterNet-style heatmap-regression model (MobileNetV3-small
 * backbone + 3-block decoder + 1×1 head, ~2.5M params) loaded from
 * `ml/cursor-v0.onnx` via onnxruntime-node.
 *
 * Crops a 256×256 region around the hint (e.g. cursor-belief.position
 * or the predicted post-emit landing), runs inference (~30-50ms on
 * CPU), and returns the heatmap argmax as the cursor pixel.
 *
 * Returns `null` when:
 *   - Model file is missing / failed to load
 *   - Hint is null (no crop center available)
 *   - Max heatmap confidence below threshold
 *
 * On null, callers should fall back to `cursor-shape-detect.ts` or
 * other heuristic detectors. This module is a strict ADDITION — it
 * never breaks existing paths.
 */
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { detectIpadRegion, NATIVE_MARGIN } from './ipad-region-detect.js';

/** Crop dimension (must match training: train-cursor-v1.py CROP_SIZE). */
const CROP_SIZE = 256;
const HEATMAP_SIZE = 64;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// v0.5.241+: cursor-v1 trained on visually-verified labels with
// 157 cursor-absent negatives. v0 reported 100% FP rate on
// cursor-absent val frames (Phase 310 tautology); v1 reports
// 6.45%. See docs/troubleshooting/2026-05-14-cursor-v1-eval.md.
// Set PIKVM_ML_MODEL env var (absolute path) to A/B against an
// alternate ONNX file (e.g. cursor-v0.bad-labels.onnx).
const DEFAULT_MODEL = process.env.PIKVM_ML_MODEL
  ? path.resolve(process.env.PIKVM_ML_MODEL)
  : path.resolve(process.cwd(), 'ml', 'cursor-v1.onnx');
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

// H-i (2026-05-17): v5 full-frame presence gate. When
// PIKVM_ML_V5_PRESENCE_GATE=1, every findCursorByML call first runs
// v5 on the full frame. If v5's presence head says "no cursor"
// (presence < threshold), return null without running v1 — short-
// circuiting the Phase 310 tautology where v1 false-positives on
// page-indicator dots and icon glyphs.
const V5_MODEL = process.env.PIKVM_ML_V5_MODEL
  ? path.resolve(process.env.PIKVM_ML_V5_MODEL)
  : path.resolve(process.cwd(), 'ml', 'cursor-v5.onnx');
const V5_PRESENCE_GATE = process.env.PIKVM_ML_V5_PRESENCE_GATE === '1';
const V5_INPUT_W = 768;
const V5_INPUT_H = 480;
const V5_HEATMAP_W = V5_INPUT_W / 4;  // 192
const V5_HEATMAP_H = V5_INPUT_H / 4;  // 120
const V5_PRESENCE_THRESHOLD = 0.5;

let cachedSession: ort.InferenceSession | null = null;
let cachedModelPath: string | null = null;
let loadFailureLogged = false;
let cachedV5Session: ort.InferenceSession | null = null;
let v5LoadFailureLogged = false;

// 2026-05-25: v8 full-frame model trained on combined v0+emit+collect (TEST
// held out). Belief-tracker diagnosis on this iPad showed locateCursor
// returned positions ~360 px off ground truth, while v8 was ~15 px off
// median on the same 16 frames. v8 is the better full-frame calibration
// detector. Opt in via env var PIKVM_V8_CALIBRATE=1; default off.
//
// 2026-05-31 (v12 ship-decision): prefer cursor-v12.onnx — trained on
// 11k labeled frames (10k iPad-app auto-labeled synthetic + 1030 human-
// verified). Live A/B on iPad: 8/20 real-launch HITs (40%) vs v11's
// 1/20 (5%) on the same iPad state and same 4 targets; AppStore: 5/5
// vs 0/5; Files: 3/5 vs 1/5. Zero SKIPs (vs v11's 4) — v12 produces
// confident-enough detections to clear the 35-px residual gate.
// Falls back to v11 → v9-bordered → v8 if v12 isn't present. Env var
// still overrides for diagnostic / A-B testing.
//
// 2026-06-04 (v13): deliberately NOT in the auto-load candidate list.
// Opt in for the 4.3' live A/B via PIKVM_ML_V8_MODEL=ml/cursor-v13.onnx.
// Full offline eval (p50 8.2→4.7 vs v12 on 34 held-out on-icon frames):
// docs/roadmap-2026-05-31.md § 4.2'.
const V8_MODEL = (() => {
  if (process.env.PIKVM_ML_V8_MODEL) return path.resolve(process.env.PIKVM_ML_V8_MODEL);
  const candidates = [
    path.resolve(process.cwd(), 'ml', 'cursor-v12.onnx'),
    path.resolve(process.cwd(), 'ml', 'cursor-v11.onnx'),
    path.resolve(process.cwd(), 'ml', 'cursor-v9-bordered.onnx'),
    path.resolve(process.cwd(), 'ml', 'cursor-v8.onnx'),
  ];
  for (const c of candidates) {
    try { fsSync.accessSync(c); return c; } catch { /* keep looking */ }
  }
  return candidates[candidates.length - 1];  // best effort; let load fail loudly
})();
const V8_INPUT_W = 768;
const V8_INPUT_H = 480;
const V8_HEATMAP_W = V8_INPUT_W / 4;  // 192
const V8_HEATMAP_H = V8_INPUT_H / 4;  // 120
let cachedV8Session: ort.InferenceSession | null = null;
let v8LoadFailureLogged = false;

// --- Cascade verifier (cursor-v14 PROPOSER + crop-VERIFIER). Opt-in via
// PIKVM_ML_CASCADE=1 (proposer = PIKVM_ML_V8_MODEL). The full-frame heatmap can't
// separate the cursor from orange app icons at 192×120 (the arrow is ~3-4px, so it
// keys on colour and FPs on the Maps widget / Books icon at ~0.99). The cascade
// PROPOSES the top-K heatmap peaks, then a 96px-crop binary VERIFIER ("is there a
// cursor arrow here?") confirms which candidate is the real cursor and rejects
// icons/buttons/map tiles at native resolution. Offline: 6/6 on the held-out home
// frames. See docs/detector-retrain-plan.md.
const CASCADE_ENABLED = process.env.PIKVM_ML_CASCADE !== '0';  // DEFAULT ON (opt out with =0)
const VERIFIER_MODEL = process.env.PIKVM_ML_VERIFIER_MODEL
  ? path.resolve(process.env.PIKVM_ML_VERIFIER_MODEL)
  : path.resolve(process.cwd(), 'ml', 'crop-heatmap.onnx');
const HM_OUT = 24;  // dual-head heatmap output resolution (crop 96 / 4)
const CASCADE_CROP = 96;  // native-px verifier crop (MUST match training)
const GRID_STRIDE = Number(process.env.PIKVM_ML_GRID_STRIDE ?? '48');  // native-px grid step
const VERIFY_THRESH = Number(process.env.PIKVM_ML_VERIFY_THRESH ?? '0.5');
let cachedVerifierSession: ort.InferenceSession | null = null;
let verifierLoadFailureLogged = false;
let cachedRegion: { x: number; y: number; w: number; h: number } | null = null;

/**
 * Cascade detection: run the VERIFIER over a dense grid of 96px crops covering the
 * iPad region (batched in ONE inference), take the max-scoring crop, and refine to
 * the score-weighted centroid of the winning cluster for sub-cell precision. This
 * DECOUPLES detection from the full-frame proposer, whose recall failed live (it
 * missed the cursor on the Maps app icon — verifier=1.0 there but the proposer never
 * proposed it). The proposer heatmap is intentionally NOT used. ~230 crops / ~110ms.
 * See docs/detector-retrain-plan.md cycle 14.
 */
async function runCascade(
  jpegBuffer: Buffer, frameW: number, frameH: number,
): Promise<{ x: number; y: number; presence: number; heatmapPeak: number } | null> {
  if (cachedVerifierSession === null) {
    try {
      await fs.access(VERIFIER_MODEL);
      cachedVerifierSession = await ort.InferenceSession.create(VERIFIER_MODEL);
    } catch (e) {
      if (!verifierLoadFailureLogged) {
        console.error(
          `[cursor-ml-detect] failed to load verifier at ${VERIFIER_MODEL}: ` +
          `${(e as Error).message}. Cascade disabled.`,
        );
        verifierLoadFailureLogged = true;
      }
      return null;
    }
  }
  if (cachedRegion === null) {
    try {
      const r = await detectIpadRegion(jpegBuffer);
      cachedRegion = { x: r.x + NATIVE_MARGIN, y: r.y + NATIVE_MARGIN, w: r.w - 2 * NATIVE_MARGIN, h: r.h - 2 * NATIVE_MARGIN };
    } catch {
      cachedRegion = { x: 0, y: 0, w: frameW, h: frameH };
    }
  }
  const reg = cachedRegion;
  const { data: full, info } = await sharp(jpegBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const FW = info.width, half = CASCADE_CROP / 2;
  const centers: { x: number; y: number }[] = [];
  for (let cy = reg.y + half; cy <= reg.y + reg.h - half; cy += GRID_STRIDE) {
    for (let cx = reg.x + half; cx <= reg.x + reg.w - half; cx += GRID_STRIDE) {
      centers.push({ x: Math.round(cx), y: Math.round(cy) });
    }
  }
  if (centers.length === 0) return null;
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
  const out = await cachedVerifierSession.run({ crop: new ort.Tensor('float32', batch, [N, 3, CASCADE_CROP, CASCADE_CROP]) });
  const presence = out.presence_logit.data as Float32Array;   // [N]
  const heatmap = out.heatmap_logits.data as Float32Array;    // [N,1,HM,HM]
  // PRESENCE head (offset-invariant, confuser-rejecting) picks the crop; the HEATMAP
  // head gives the sub-pixel tip within it via soft-argmax.
  let bi = 0;
  for (let i = 1; i < N; i++) if (presence[i] > presence[bi]) bi = i;
  const maxP = 1 / (1 + Math.exp(-presence[bi]));
  if (maxP < VERIFY_THRESH) return null;
  const hmScale = CASCADE_CROP / HM_OUT, off = bi * HM_OUT * HM_OUT;
  let mx = -Infinity;
  for (let k = 0; k < HM_OUT * HM_OUT; k++) mx = Math.max(mx, heatmap[off + k]);
  let sum = 0, ex = 0, ey = 0;
  for (let gy = 0; gy < HM_OUT; gy++) {
    for (let gx = 0; gx < HM_OUT; gx++) {
      const w = Math.exp(heatmap[off + gy * HM_OUT + gx] - mx);
      sum += w; ex += gx * w; ey += gy * w;
    }
  }
  ex /= sum; ey /= sum;
  const left = Math.max(0, Math.min(FW - CASCADE_CROP, centers[bi].x - half));
  const top = Math.max(0, Math.min(info.height - CASCADE_CROP, centers[bi].y - half));
  return { x: Math.round(left + ex * hmScale), y: Math.round(top + ey * hmScale), presence: maxP, heatmapPeak: maxP };
}

/** Result type returned by findCursorByML. */
export interface MLCursorResult {
  /** Cursor x in full-frame screenshot pixels. */
  x: number;
  /** Cursor y in full-frame screenshot pixels. */
  y: number;
  /** Sigmoid of heatmap peak — model's confidence in cursor presence. */
  confidence: number;
  /** Returned only for diagnostics: the crop window used. */
  crop: { left: number; top: number };
}

export interface MLCursorOptions {
  /** Where to center the 256×256 crop. Required (no hint = no detection). */
  hint: { x: number; y: number };
  /** Minimum confidence to report a detection. Below this, return null
   *  (caller should fall back to heuristic). Default 0.5. */
  minConfidence?: number;
  /** Override the ONNX model path. Default `ml/cursor-v0.onnx` from
   *  cwd. Useful for testing or model versioning. */
  modelPath?: string;
}

/**
 * Lazily load the ONNX session. Returns null if model file missing
 * or load fails.
 */
async function getSession(modelPath: string): Promise<ort.InferenceSession | null> {
  if (cachedSession !== null && cachedModelPath === modelPath) {
    return cachedSession;
  }
  try {
    // Check file exists first; gives a cleaner error than ORT's
    await fs.access(modelPath);
    const session = await ort.InferenceSession.create(modelPath);
    cachedSession = session;
    cachedModelPath = modelPath;
    return session;
  } catch (e) {
    if (!loadFailureLogged) {
      console.error(
        `[cursor-ml-detect] failed to load model at ${modelPath}: ` +
        `${(e as Error).message}. ML detection disabled; falling back to heuristic.`,
      );
      loadFailureLogged = true;
    }
    return null;
  }
}

/**
 * Run v5 full-frame inference. Returns presence probability and a
 * rough cursor position (in full-frame native pixels). Used by the
 * presence-gate path; v5's position is intentionally coarse (~11 px
 * median error) so callers either use it as a hint for v1 or treat
 * the presence signal alone.
 */
export async function findCursorPresenceV5(
  jpegBuffer: Buffer,
  frameWidth: number,
  frameHeight: number,
): Promise<{ presence: number; x: number; y: number } | null> {
  if (cachedV5Session === null) {
    try {
      await fs.access(V5_MODEL);
      cachedV5Session = await ort.InferenceSession.create(V5_MODEL);
    } catch (e) {
      if (!v5LoadFailureLogged) {
        console.error(
          `[cursor-ml-detect] failed to load v5 model at ${V5_MODEL}: ` +
          `${(e as Error).message}. Presence gate disabled.`,
        );
        v5LoadFailureLogged = true;
      }
      return null;
    }
  }

  // Resize full frame to v5 input dims (768×480) preserving aspect.
  // PiKVM frames are 1680×1050 (aspect 1.6), v5 input is 768×480 (also 1.6).
  const { data: rgb } = await sharp(jpegBuffer)
    .resize(V5_INPUT_W, V5_INPUT_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const inputData = new Float32Array(1 * 3 * V5_INPUT_W * V5_INPUT_H);
  for (let y = 0; y < V5_INPUT_H; y++) {
    for (let x = 0; x < V5_INPUT_W; x++) {
      const srcIdx = (y * V5_INPUT_W + x) * 3;
      const r = rgb[srcIdx] / 255;
      const g = rgb[srcIdx + 1] / 255;
      const b = rgb[srcIdx + 2] / 255;
      const dstBase = y * V5_INPUT_W + x;
      const planeSize = V5_INPUT_W * V5_INPUT_H;
      inputData[0 * planeSize + dstBase] = (r - MEAN[0]) / STD[0];
      inputData[1 * planeSize + dstBase] = (g - MEAN[1]) / STD[1];
      inputData[2 * planeSize + dstBase] = (b - MEAN[2]) / STD[2];
    }
  }

  const inputTensor = new ort.Tensor(
    'float32', inputData, [1, 3, V5_INPUT_H, V5_INPUT_W],
  );
  const results = await cachedV5Session.run({ frame: inputTensor });

  // v5 has two outputs: heatmap_logits (1,1,120,192), presence_logit (1,1).
  const heatmapLogits = results.heatmap_logits.data as Float32Array;
  const presenceLogit = (results.presence_logit.data as Float32Array)[0];
  const presence = 1 / (1 + Math.exp(-presenceLogit));

  // Decode heatmap peak
  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < heatmapLogits.length; i++) {
    if (heatmapLogits[i] > bestLogit) {
      bestLogit = heatmapLogits[i];
      bestIdx = i;
    }
  }
  const peakY_hm = Math.floor(bestIdx / V5_HEATMAP_W);
  const peakX_hm = bestIdx % V5_HEATMAP_W;
  // Scale heatmap coords to native frame coords.
  const xNative = (peakX_hm / V5_HEATMAP_W) * frameWidth;
  const yNative = (peakY_hm / V5_HEATMAP_H) * frameHeight;

  return { presence, x: xNative, y: yNative };
}

/**
 * Run v8 full-frame inference. Same architecture as v5 (MobileNetV3-small
 * + position head + presence head), but trained on the combined v0+emit+
 * collect human-verified labels with TEST held out.
 *
 * Belief-tracker diagnosis 2026-05-25 (data/belief-diag-2026-05-25T12-15-34):
 * v8 reported median 15 px from human label across 16 live frames, while
 * locateCursor (motion-diff probe) returned ~360 px off. v8 is the better
 * calibration detector for the seed-belief role.
 *
 * Returns null when the model fails to load OR presence is below
 * threshold (cursor likely not visible).
 */
export async function findCursorByV8FullFrame(
  jpegBuffer: Buffer,
  frameWidth: number,
  frameHeight: number,
  options?: { minPresence?: number },
): Promise<{ x: number; y: number; presence: number; heatmapPeak: number } | null> {
  // DEFAULT detection path (2026-07-20): the dual-head crop CASCADE (grid → presence +
  // heatmap soft-argmax). Validated LIVE 160/160 across two N=80 benches + 2.8px small-
  // button precision; both v13 failure modes (Maps-widget FP, Books-icon FN) fixed. Skips
  // the full-frame proposer entirely (the grid doesn't use it). Opt OUT with
  // PIKVM_ML_CASCADE=0 to fall back to the legacy single-stage path below.
  if (CASCADE_ENABLED) {
    return runCascade(jpegBuffer, frameWidth, frameHeight);
  }
  const minPresence = options?.minPresence ?? 0.5;
  if (cachedV8Session === null) {
    try {
      await fs.access(V8_MODEL);
      cachedV8Session = await ort.InferenceSession.create(V8_MODEL);
    } catch (e) {
      if (!v8LoadFailureLogged) {
        console.error(
          `[cursor-ml-detect] failed to load v8 model at ${V8_MODEL}: ` +
          `${(e as Error).message}. v8 calibration disabled.`,
        );
        v8LoadFailureLogged = true;
      }
      return null;
    }
  }

  // 2026-05-25: sharp's default kernel is `lanczos3`. The v8 model was
  // trained with PIL.Image.BILINEAR resize, which is closer to sharp's
  // `cubic` than to lanczos3. Smoke test on belief-diag frame-0 showed
  // lanczos3 path predicting (621, 70) vs PIL-bilinear (674, 149) — a
  // 50-80 px shift on identical input due to the resize-kernel mismatch.
  // Using `cubic` here reduces that gap and keeps production output
  // closer to what offline eval reports.
  const { data: rgb } = await sharp(jpegBuffer)
    .resize(V8_INPUT_W, V8_INPUT_H, { fit: 'fill', kernel: 'cubic' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const inputData = new Float32Array(1 * 3 * V8_INPUT_W * V8_INPUT_H);
  const planeSize = V8_INPUT_W * V8_INPUT_H;
  for (let y = 0; y < V8_INPUT_H; y++) {
    for (let x = 0; x < V8_INPUT_W; x++) {
      const srcIdx = (y * V8_INPUT_W + x) * 3;
      const r = rgb[srcIdx] / 255;
      const g = rgb[srcIdx + 1] / 255;
      const b = rgb[srcIdx + 2] / 255;
      const dst = y * V8_INPUT_W + x;
      inputData[0 * planeSize + dst] = (r - MEAN[0]) / STD[0];
      inputData[1 * planeSize + dst] = (g - MEAN[1]) / STD[1];
      inputData[2 * planeSize + dst] = (b - MEAN[2]) / STD[2];
    }
  }

  const inputTensor = new ort.Tensor(
    'float32', inputData, [1, 3, V8_INPUT_H, V8_INPUT_W],
  );
  const results = await cachedV8Session.run({ frame: inputTensor });
  const heatmapLogits = results.heatmap_logits.data as Float32Array;
  const presenceLogit = (results.presence_logit.data as Float32Array)[0];
  const presence = 1 / (1 + Math.exp(-presenceLogit));

  if (presence < minPresence) return null;

  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < heatmapLogits.length; i++) {
    if (heatmapLogits[i] > bestLogit) {
      bestLogit = heatmapLogits[i];
      bestIdx = i;
    }
  }
  const peakY_hm = Math.floor(bestIdx / V8_HEATMAP_W);
  const peakX_hm = bestIdx % V8_HEATMAP_W;
  const xNative = Math.round((peakX_hm / V8_HEATMAP_W) * frameWidth);
  const yNative = Math.round((peakY_hm / V8_HEATMAP_H) * frameHeight);
  const heatmapPeak = 1 / (1 + Math.exp(-bestLogit));

  return { x: xNative, y: yNative, presence, heatmapPeak };
}

/**
 * Run the trained heatmap detector on a screenshot. Returns the
 * predicted cursor position (in full-frame pixels) or null.
 *
 * @param jpegBuffer  Screenshot from `client.screenshot()` (JPEG).
 * @param frameWidth  Full-frame width in pixels (e.g. 1680).
 * @param frameHeight Full-frame height in pixels (e.g. 1050).
 * @param options     Required `hint` (crop center), optional
 *                    `minConfidence` and `modelPath`.
 */
export async function findCursorByML(
  jpegBuffer: Buffer,
  frameWidth: number,
  frameHeight: number,
  options: MLCursorOptions,
): Promise<MLCursorResult | null> {
  const modelPath = options.modelPath ?? DEFAULT_MODEL;
  const minConfidence = options.minConfidence ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const session = await getSession(modelPath);
  if (session === null) return null;

  // H-i (2026-05-17): v5 presence gate. Short-circuit when v5 says no
  // cursor in the frame, before running v1's crop-around-hint
  // inference. Defends against Phase 310 tautology where v1 picks
  // icon-internal features as "cursor" in cursor-absent crops.
  if (V5_PRESENCE_GATE) {
    const v5 = await findCursorPresenceV5(jpegBuffer, frameWidth, frameHeight);
    if (v5 !== null && v5.presence < V5_PRESENCE_THRESHOLD) {
      return null;
    }
  }

  // Compute the crop window — center on hint, clamp to frame bounds.
  const half = CROP_SIZE / 2;
  let cropLeft = Math.max(0, Math.round(options.hint.x - half));
  let cropTop = Math.max(0, Math.round(options.hint.y - half));
  cropLeft = Math.min(cropLeft, frameWidth - CROP_SIZE);
  cropTop = Math.min(cropTop, frameHeight - CROP_SIZE);
  if (cropLeft < 0 || cropTop < 0) {
    // Frame smaller than crop — can't run. Return null and let
    // caller fall back.
    return null;
  }

  // Decode the JPEG region of interest at full quality, get raw RGB.
  const { data: rgb } = await sharp(jpegBuffer)
    .extract({ left: cropLeft, top: cropTop, width: CROP_SIZE, height: CROP_SIZE })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Build NCHW float32 tensor with ImageNet normalisation.
  const inputData = new Float32Array(1 * 3 * CROP_SIZE * CROP_SIZE);
  for (let y = 0; y < CROP_SIZE; y++) {
    for (let x = 0; x < CROP_SIZE; x++) {
      const srcIdx = (y * CROP_SIZE + x) * 3;
      const r = rgb[srcIdx] / 255;
      const g = rgb[srcIdx + 1] / 255;
      const b = rgb[srcIdx + 2] / 255;
      const dstBase = y * CROP_SIZE + x;
      inputData[0 * CROP_SIZE * CROP_SIZE + dstBase] = (r - MEAN[0]) / STD[0];
      inputData[1 * CROP_SIZE * CROP_SIZE + dstBase] = (g - MEAN[1]) / STD[1];
      inputData[2 * CROP_SIZE * CROP_SIZE + dstBase] = (b - MEAN[2]) / STD[2];
    }
  }

  const inputTensor = new ort.Tensor('float32', inputData, [1, 3, CROP_SIZE, CROP_SIZE]);
  const feeds: Record<string, ort.Tensor> = { frame: inputTensor };
  const results = await session.run(feeds);

  const outputName = session.outputNames[0];
  const logits = results[outputName].data as Float32Array;

  // logits shape: (1, 1, HEATMAP_SIZE, HEATMAP_SIZE)
  // Find argmax of sigmoid(logits)
  let bestIdx = 0;
  let bestLogit = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > bestLogit) {
      bestLogit = logits[i];
      bestIdx = i;
    }
  }
  const peakY = Math.floor(bestIdx / HEATMAP_SIZE);
  const peakX = bestIdx % HEATMAP_SIZE;
  const confidence = 1 / (1 + Math.exp(-bestLogit));

  // Heatmap is HEATMAP_SIZE×HEATMAP_SIZE for a CROP_SIZE×CROP_SIZE input.
  // Scale factor = CROP_SIZE / HEATMAP_SIZE = 4.
  const scale = CROP_SIZE / HEATMAP_SIZE;
  const localX = Math.round(peakX * scale + scale / 2);
  const localY = Math.round(peakY * scale + scale / 2);
  const predictedX = localX + cropLeft;
  const predictedY = localY + cropTop;

  // 2026-05-14: opt-in capture. When PIKVM_ML_CAPTURE_DIR is set,
  // save the full-frame JPEG + a sidecar JSON with the model's
  // prediction. Lets us visually compare live model output to
  // ground-truth cursor position (the thing we previously assumed
  // worked live without verification).
  // Sidecar mirrors data/cursor-training-v0/ schema so saved
  // frames can be hand-labelled and added to verified.jsonl.
  const captureDir = process.env.PIKVM_ML_CAPTURE_DIR;
  if (captureDir) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      await fs.promises.mkdir(captureDir, { recursive: true });
      const stem = `${Date.now()}-${Math.floor(Math.random() * 1e6)
        .toString().padStart(6, '0')}`;
      await fs.promises.writeFile(
        path.join(captureDir, `${stem}.jpg`),
        jpegBuffer,
      );
      const sidecar = {
        frame_path: path.join(captureDir, `${stem}.jpg`),
        ml_prediction: { x: predictedX, y: predictedY, confidence },
        hint: { x: options.hint.x, y: options.hint.y },
        crop: { left: cropLeft, top: cropTop, size: CROP_SIZE },
        model_path: modelPath,
        captured_at: new Date().toISOString(),
        below_threshold: confidence < minConfidence,
      };
      await fs.promises.writeFile(
        path.join(captureDir, `${stem}.json`),
        JSON.stringify(sidecar, null, 2),
      );
    } catch {
      // Ignore capture errors — diagnostic must not break detection.
    }
  }

  if (confidence < minConfidence) return null;
  return {
    x: predictedX,
    y: predictedY,
    confidence,
    crop: { left: cropLeft, top: cropTop },
  };
}

/**
 * Try multiple hint positions and return the highest-confidence
 * result. Useful when the cursor may be at one of several plausible
 * locations (e.g. predicted target, current belief, or home position
 * after a rate-limited emit).
 *
 * Hints are deduplicated by ~256 px proximity (no point running ML
 * on overlapping crops). Returns null if every hint yielded null
 * (cursor not found in any crop with confidence ≥ minConfidence).
 */
export async function findCursorByMLMultiHint(
  jpegBuffer: Buffer,
  frameWidth: number,
  frameHeight: number,
  hints: Array<{ x: number; y: number }>,
  options: Omit<MLCursorOptions, 'hint'> = {},
): Promise<MLCursorResult | null> {
  // 2026-05-28: prefer the full-frame v9-bordered detector when it
  // returns a confident result. PA19 trace (Settings target, n=8): the
  // post-emit hint-crop path (cursor-v1, borderless-cursor weights)
  // returned (961, 919) at conf=0.989 on every single attempt — a
  // confident-wrong static FP near the target hint. discoverOrigin
  // running findCursorByV8FullFrame (cursor-v9-bordered) on the SAME
  // frames found the true cursor at (1100, 684)/(1110, 738)/etc.
  // Wiring the full-frame v9-bordered detector here too — same model
  // proven to work in discoverOrigin — eliminates the model-mismatch
  // class of FPs entirely.
  //
  // Gate on BOTH presence (cursor visible) AND heatmapPeak (model is
  // confident in WHERE the cursor is). PA19-c Books trace showed
  // presence=0.94 + heatmapPeak=0.13 returning (0, 1071) — a
  // degenerate corner prediction that, when accepted, makes the
  // correction emit launch the cursor 800 px across the screen.
  //
  // 0.2 heatmapPeak floor: empirically (Books PA19-c), bad
  // corner-degenerate predictions score 0.12-0.14. Set just above that
  // band so valid moderate-confidence detections pass through.
  const presenceThreshold = options.minConfidence ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const HEATMAP_FLOOR = 0.2;
  const v8 = await findCursorByV8FullFrame(jpegBuffer, frameWidth, frameHeight, {
    minPresence: presenceThreshold,
  });
  if (v8 !== null && v8.heatmapPeak >= HEATMAP_FLOOR) {
    return {
      x: v8.x,
      y: v8.y,
      confidence: v8.heatmapPeak,
      crop: { left: 0, top: 0 },
    };
  }

  // Fall back to crop-based hint search when full-frame returns null
  // (presence below threshold). Dedup: keep only hints that are > 200 px
  // apart (so crops don't overlap substantially).
  const dedupedHints: Array<{ x: number; y: number }> = [];
  for (const h of hints) {
    if (dedupedHints.every((d) => Math.hypot(d.x - h.x, d.y - h.y) > 200)) {
      dedupedHints.push(h);
    }
  }

  let best: MLCursorResult | null = null;
  for (const hint of dedupedHints) {
    const r = await findCursorByML(jpegBuffer, frameWidth, frameHeight, {
      ...options,
      hint,
    });
    if (r !== null && (best === null || r.confidence > best.confidence)) {
      best = r;
    }
  }
  return best;
}

/**
 * Build a multi-hint set for ML cursor detection.
 *
 * Always includes `predicted`. Conditionally adds:
 *  - `beliefPos` if it's inside the frame AND > 200 px from existing hints.
 *    (v0.5.238 multi-hint included belief unconditionally, but v0.5.239
 *    diagnostic showed belief can drift off-screen after unlock/home
 *    swipes when bounds=null — using such a hint clamps the crop to
 *    the top-left corner of the frame, wasting an inference.)
 *  - A "home-zone" hint at (frameWidth × 0.625, frameHeight × 0.75) —
 *    the typical post-navigation cursor location on iPad (right-bottom
 *    quadrant). Added when > 200 px from all existing hints. v0.5.239
 *    diagnostic at Books target: cursor was at (1170, 892) with home
 *    hint giving ML conf 0.968, while predicted-only crops at (640, 800)
 *    yielded conf 0.143 (random).
 */
export function buildMLHints(
  predicted: { x: number; y: number },
  frameWidth: number,
  frameHeight: number,
  beliefPos?: { x: number; y: number } | null,
): Array<{ x: number; y: number }> {
  const hints: Array<{ x: number; y: number }> = [predicted];
  const minSep = 200;
  const farFromAll = (p: { x: number; y: number }): boolean =>
    hints.every((h) => Math.hypot(h.x - p.x, h.y - p.y) > minSep);

  if (
    beliefPos !== undefined && beliefPos !== null
    && beliefPos.x >= 0 && beliefPos.x < frameWidth
    && beliefPos.y >= 0 && beliefPos.y < frameHeight
  ) {
    const beliefRounded = { x: Math.round(beliefPos.x), y: Math.round(beliefPos.y) };
    if (farFromAll(beliefRounded)) hints.push(beliefRounded);
  }

  const homeHint = {
    x: Math.round(frameWidth * 0.625),
    y: Math.round(frameHeight * 0.75),
  };
  if (farFromAll(homeHint)) hints.push(homeHint);

  return hints;
}

/**
 * Drop the cached session. Useful for tests that swap models, or
 * to release memory when ML detection is not actively used.
 */
export function disposeMLSession(): void {
  cachedSession = null;
  cachedModelPath = null;
  loadFailureLogged = false;
}
