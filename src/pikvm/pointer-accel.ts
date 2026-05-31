/**
 * Learned forward pointer-acceleration model loader (Stage 1, step 1.5).
 *
 * Loads `ml/pointer-accel-v1.onnx` (an 8-feature -> 2-output MLP trained
 * by `ml/train-pointer-accel.py`) and exposes:
 *
 *   - {@link buildFeatures} — produces the 8-dim feature vector the
 *     model was trained on, given the recent emit history, the cursor's
 *     instantaneous velocity, the current emit, and the elapsed time
 *     since the previous emit.
 *   - {@link predictDisplacement} — runs the ONNX session and returns
 *     the predicted (dx, dy) cursor displacement over the next
 *     {@link HORIZON_MS} ms in iPad **logical** pixels.
 *
 * Feature schema (must stay in lock-step with
 * `ml/train-pointer-accel.py:build_examples` — see the docstring at
 * the top of that file):
 *
 *   [0] raw_dx                  — current emit's signed dx mickeys
 *   [1] raw_dy                  — current emit's signed dy mickeys
 *   [2] sum_dx_100ms            — sum of emit dx over the last 100 ms
 *   [3] sum_dy_100ms            — sum of emit dy over the last 100 ms
 *   [4] emit_count_100ms        — number of prior emits in that window
 *   [5] dt_prev_emit_ms         — ms since the immediately-preceding emit
 *   [6] cursor_vx_logical_pxms  — recent cursor velocity, logical px / ms
 *   [7] cursor_vy_logical_pxms  — recent cursor velocity, logical px / ms
 *
 * This module is opt-in: it is only consumed by `move-to.ts` when
 * `PIKVM_USE_LEARNED_BALLISTICS=1`. When the ONNX file is missing or
 * fails to load, {@link predictDisplacement} resolves to `null` so the
 * caller falls back to the empirical constant ratio.
 */
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import path from 'path';
import * as ort from 'onnxruntime-node';

/** Horizon over which the trained model predicts displacement (ms).
 *  Must match `HORIZON_MS` in `ml/train-pointer-accel.py`. */
export const HORIZON_MS = 50;

/** Cumulative-emit window in milliseconds.
 *  Must match `HISTORY_WINDOW_MS` in `ml/train-pointer-accel.py`. */
export const HISTORY_WINDOW_MS = 100;

/** Number of input features. Must match the trainer's FEATURE_DIM. */
export const FEATURE_DIM = 8;

/** Number of output values. Must match the trainer's OUTPUT_DIM. */
export const OUTPUT_DIM = 2;

const DEFAULT_MODEL = path.resolve(process.cwd(), 'ml', 'pointer-accel-v1.onnx');

/** Single emit record. Times in absolute wall-clock ms (Date.now-ish);
 *  only inter-event deltas matter, but consistent units make the buffer
 *  cheap to reason about. */
export interface EmitEvent {
  t: number;
  dx: number;
  dy: number;
}

/** Cursor velocity in **logical** iPad pixels per millisecond. */
export interface CursorVelocity {
  vxPxPerMs: number;
  vyPxPerMs: number;
}

/** Lazy session cache. `null` while uninitialised; resolves to the
 *  inference session, or `null` if model load failed. */
let cachedSession: Promise<ort.InferenceSession | null> | null = null;
let loadFailureLogged = false;

/** Allow tests to inject a stub session and clear the cache between
 *  tests. The injected session is wrapped in a resolved Promise so the
 *  cache shape stays consistent. Not part of the public API for callers. */
export function __setPointerAccelSessionForTest(
  session: ort.InferenceSession | null,
): void {
  cachedSession = Promise.resolve(session);
}

/** Clear the cached session (and the load-failure log flag). For tests. */
export function __resetPointerAccelSessionForTest(): void {
  cachedSession = null;
  loadFailureLogged = false;
}

/** Lazily resolve to an InferenceSession, or `null` if the model is
 *  missing or fails to load. Called once per process; subsequent calls
 *  return the same Promise. */
export function getPointerAccelSession(
  modelPath: string = DEFAULT_MODEL,
): Promise<ort.InferenceSession | null> {
  if (cachedSession !== null) return cachedSession;
  cachedSession = (async () => {
    try {
      await fs.access(modelPath);
      return await ort.InferenceSession.create(modelPath);
    } catch (e) {
      if (!loadFailureLogged) {
        console.error(
          `[pointer-accel] failed to load model at ${modelPath}: ` +
          `${(e as Error).message}. Learned ballistics disabled; ` +
          `falling back to constant px/mickey ratio.`,
        );
        loadFailureLogged = true;
      }
      return null;
    }
  })();
  return cachedSession;
}

/** Synchronous check used by callers that only want to know whether the
 *  ONNX file even exists before constructing the feature buffer. Returns
 *  true if the file is present; does not actually load the session. */
export function pointerAccelModelExists(
  modelPath: string = DEFAULT_MODEL,
): boolean {
  try {
    fsSync.accessSync(modelPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the 8-dim feature vector that {@link predictDisplacement}
 * consumes. Pure function — no I/O, deterministic, unit-testable.
 *
 * `emitHistory` is the chronological list of emits *prior to* the
 * `currentEmit`. Emits older than `currentEmit.t - HISTORY_WINDOW_MS`
 * are ignored. The trainer treats inputs that have the same timestamp
 * as the current emit as in-window (`t_emit - emit_ts[j] <= 100 ms`).
 *
 * `dtPrevEmitMs` is the ms gap between the previous emit and the
 * current one. Pass `0` when there is no previous emit (cold start).
 *
 * `recentCursorVelocity` is the cursor velocity in logical px/ms
 * (matches the trainer's `instantaneous_velocity`).
 */
export function buildFeatures(
  emitHistory: ReadonlyArray<EmitEvent>,
  recentCursorVelocity: CursorVelocity,
  currentEmit: { dx: number; dy: number; t: number },
  dtPrevEmitMs: number,
): number[] {
  let sumDx = 0;
  let sumDy = 0;
  let count = 0;
  // Match the trainer's `(t_emit - emit_ts[j]) <= HISTORY_WINDOW_MS`
  // inclusive predicate, walking history newest-first.
  for (let j = emitHistory.length - 1; j >= 0; j--) {
    const e = emitHistory[j];
    if (currentEmit.t - e.t > HISTORY_WINDOW_MS) break;
    sumDx += e.dx;
    sumDy += e.dy;
    count++;
  }
  return [
    currentEmit.dx,
    currentEmit.dy,
    sumDx,
    sumDy,
    count,
    dtPrevEmitMs,
    recentCursorVelocity.vxPxPerMs,
    recentCursorVelocity.vyPxPerMs,
  ];
}

/**
 * Run the ONNX model on the given feature vector and return the
 * predicted cursor displacement in **logical** iPad pixels over the
 * next {@link HORIZON_MS} ms.
 *
 * Returns `null` when the model is unavailable (file missing / load
 * failed) so the caller can fall back to the constant px/mickey
 * ratio path. Throws only on malformed feature input or genuine ORT
 * inference errors.
 */
export async function predictDisplacement(
  features: number[],
  opts: { modelPath?: string } = {},
): Promise<{ dx: number; dy: number } | null> {
  if (features.length !== FEATURE_DIM) {
    throw new Error(
      `predictDisplacement: features.length must be ${FEATURE_DIM}, got ${features.length}`,
    );
  }
  const session = await getPointerAccelSession(opts.modelPath ?? DEFAULT_MODEL);
  if (!session) return null;

  const data = Float32Array.from(features);
  const tensor = new ort.Tensor('float32', data, [1, FEATURE_DIM]);
  const outputs = await session.run({ features: tensor });
  // Trainer exports the output as `dxdy` (see export-pointer-accel-onnx.py).
  // Fall back to the first output if the name differs (e.g. a re-exported
  // ONNX with a different convention).
  const out = (outputs.dxdy ?? outputs[Object.keys(outputs)[0]]) as ort.Tensor;
  const arr = out.data as Float32Array;
  if (arr.length < OUTPUT_DIM) {
    throw new Error(
      `predictDisplacement: ONNX returned ${arr.length} values, expected ${OUTPUT_DIM}`,
    );
  }
  return { dx: arr[0], dy: arr[1] };
}
