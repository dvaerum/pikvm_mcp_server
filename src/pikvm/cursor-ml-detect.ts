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
import path from 'path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

/** Crop dimension (must match training: train-cursor-v0.py CROP_SIZE). */
const CROP_SIZE = 256;
const HEATMAP_SIZE = 64;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const DEFAULT_MODEL = path.resolve(process.cwd(), 'ml', 'cursor-v0.onnx');
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

let cachedSession: ort.InferenceSession | null = null;
let cachedModelPath: string | null = null;
let loadFailureLogged = false;

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
  if (confidence < minConfidence) return null;

  // Heatmap is HEATMAP_SIZE×HEATMAP_SIZE for a CROP_SIZE×CROP_SIZE input.
  // Scale factor = CROP_SIZE / HEATMAP_SIZE = 4.
  const scale = CROP_SIZE / HEATMAP_SIZE;
  const localX = Math.round(peakX * scale + scale / 2);
  const localY = Math.round(peakY * scale + scale / 2);
  return {
    x: localX + cropLeft,
    y: localY + cropTop,
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
  // Dedup: keep only hints that are > 200 px apart (so crops don't
  // overlap substantially).
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
