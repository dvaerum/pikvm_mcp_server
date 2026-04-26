/**
 * Phase 23 — Click verification (machine-verifiable click feedback).
 *
 * The cursor-detection layer cannot reach single-digit residuals on a
 * busy iPad home screen because of iPadOS's non-deterministic pointer
 * acceleration (9× ratio variance per command, see
 * docs/troubleshooting/ipad-cursor-detection.md). Reliability has to
 * come from a higher-level abstraction: take a pre-click screenshot,
 * click, take a post-click screenshot, and check whether the screen
 * changed. If nothing changed, the click likely missed and the caller
 * can decide to retry or try a different target.
 *
 * This module owns ONLY the diffing arithmetic. It does not click and
 * it does not decide retry policy — those are the caller's job. That
 * keeps it pure and testable without any client/network mock.
 */

import { decodeScreenshot, diffPixels } from './cursor-detect.js';
import type { DecodedScreenshot } from './cursor-detect.js';
import { moveToPixel } from './move-to.js';
import type { MoveToOptions, MoveToResult } from './move-to.js';
import type { PiKVMClient, MouseButton } from './client.js';

export interface ClickVerification {
  /** Pixels that changed between the pre and post screenshots within
   *  the diffed area. */
  changedPixels: number;
  /** Total pixels in the diffed area (full frame, or the clamped ROI). */
  totalPixels: number;
  /** changedPixels / totalPixels in [0, 1]. */
  changedFraction: number;
  /** Heuristic verdict: did the click trigger a visible UI change?
   *  True iff changedFraction ≥ minChangedFraction. */
  screenChanged: boolean;
  /** Human-readable summary suitable for the MCP-tool response. */
  message: string;
}

export interface ClickVerifyOptions {
  /** Sum of |R|+|G|+|B| deltas above which a pixel counts as changed.
   *  Default 60. Lower = more sensitive to JPEG noise; higher = only
   *  catches clearly visible changes. The default is the same noise
   *  floor that locateCursor uses. */
  pixelThreshold?: number;
  /** Minimum changedFraction for screenChanged to be true. Default
   *  0.005 (0.5% of the diffed area). At 1920×1080 full-frame this
   *  is ~10 000 pixels — well above JPEG re-encode noise but well
   *  below typical UI transitions (modal open, view change). When a
   *  region is supplied, the same fraction applies to the clamped
   *  region area, so smaller regions need proportionally smaller
   *  absolute changes to register. */
  minChangedFraction?: number;
  /** Restrict the diff to a square window around the click target.
   *  Coordinates and sizes are in screenshot pixels. The window is
   *  clamped to the frame bounds. Use this when the expected effect
   *  is small/local (e.g. a button highlight) and a full-frame diff
   *  would be diluted. */
  region?: { x: number; y: number; halfWidth: number; halfHeight: number };
}

/**
 * Pure variant: takes already-decoded RGB screenshots. Use this from
 * tests (so synthetic frames don't need to be JPEG-encoded) and from
 * callers that already have decoded frames in hand.
 */
export function verifyClickByDecodedFrames(
  pre: DecodedScreenshot,
  post: DecodedScreenshot,
  options: ClickVerifyOptions = {},
): ClickVerification {
  if (pre.width !== post.width || pre.height !== post.height) {
    throw new Error(
      `screenshot size mismatch: pre=${pre.width}x${pre.height} post=${post.width}x${post.height}`,
    );
  }

  const pixelThreshold = options.pixelThreshold ?? 60;
  const minChangedFraction = options.minChangedFraction ?? 0.005;

  const mask = diffPixels(pre.rgb, post.rgb, pre.width, pre.height, pixelThreshold);

  let changedPixels = 0;
  let totalPixels = 0;

  if (options.region) {
    const r = options.region;
    const x0 = Math.max(0, r.x - r.halfWidth);
    const x1 = Math.min(pre.width, r.x + r.halfWidth + 1);
    const y0 = Math.max(0, r.y - r.halfHeight);
    const y1 = Math.min(pre.height, r.y + r.halfHeight + 1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        totalPixels++;
        if (mask[y * pre.width + x]) changedPixels++;
      }
    }
  } else {
    totalPixels = pre.width * pre.height;
    for (let i = 0; i < totalPixels; i++) {
      if (mask[i]) changedPixels++;
    }
  }

  const changedFraction = totalPixels > 0 ? changedPixels / totalPixels : 0;
  const screenChanged = changedFraction >= minChangedFraction;
  const pct = (changedFraction * 100).toFixed(2);
  const scope = options.region ? 'ROI' : 'screen';
  const message = screenChanged
    ? `Click triggered visible screen change (${pct}% of ${scope} pixels changed).`
    : `Click did not trigger a visible screen change (${pct}% of ${scope} pixels changed, below ${(minChangedFraction * 100).toFixed(2)}% threshold). The click may have missed its target.`;

  return { changedPixels, totalPixels, changedFraction, screenChanged, message };
}

/**
 * Convenience variant: takes raw screenshot Buffers (JPEG/PNG). Decodes
 * both then delegates to verifyClickByDecodedFrames.
 */
export async function verifyClickByDiff(
  preBuffer: Buffer,
  postBuffer: Buffer,
  options: ClickVerifyOptions = {},
): Promise<ClickVerification> {
  const pre = await decodeScreenshot(preBuffer);
  const post = await decodeScreenshot(postBuffer);
  return verifyClickByDecodedFrames(pre, post, options);
}

// ============================================================================
// Phase 25 — server-side retry-on-miss orchestrator.
//
// iPadOS pointer acceleration is non-deterministic (per the troubleshooting
// doc, 9× ratio variance per command). A single click_at call has a
// hit-rate that's well below 100% on small icons. But each retry is an
// independent random trial: if per-attempt hit rate is ~50%, retrying 3×
// gets to ~88% cumulative success.
//
// Each retry runs a FRESH detect-then-move probe so cursor position is
// rediscovered from scratch. This is qualitatively different from Phase 17
// (which retried within the correction loop on stale predicted state and
// compounded errors).
// ============================================================================

export interface ClickAtWithRetryOptions {
  /** Max additional attempts after the first one. 0 = single-shot
   *  (preserves pre-Phase-25 behavior). Default 0. */
  maxRetries?: number;
  /** Mouse button. Default 'left'. */
  button?: MouseButton;
  /** Brief pause between move-to-target completion and click, so iPadOS
   *  registers the cursor as stationary. Default 80 ms. */
  preClickSettleMs?: number;
  /** Pause between click and post-click screenshot for the UI to render.
   *  Streamer latency is ~235 ms; default 300 ms. */
  postClickSettleMs?: number;
  /** Threshold + region options forwarded to verifyClickByDiff. */
  verifyOptions?: ClickVerifyOptions;
  /** Options forwarded to moveToPixel for each attempt. Default uses
   *  detect-then-move with forbidSlamFallback=true (iPad-safe). */
  moveToOptions?: MoveToOptions;
}

export interface ClickAtWithRetryResult {
  /** True iff a single attempt's verifyClickByDiff returned screenChanged=true. */
  success: boolean;
  /** How many click attempts ran (1 = first-try success or only-attempt). */
  attempts: number;
  /** moveToPixel's diagnostic for the FINAL attempt (success or last failure). */
  finalMoveResult: MoveToResult;
  /** verifyClickByDiff result for the FINAL attempt. */
  finalVerification: ClickVerification;
  /** The screenshot captured AFTER the final attempt's click. */
  postClickScreenshot: Buffer;
  /** Per-attempt verification verdicts in order, for diagnostics. */
  attemptHistory: { attempt: number; screenChanged: boolean; changedFraction: number }[];
}

/**
 * Click at a target with verify-and-retry.
 *
 * Each attempt is independent: fresh detect-then-move probe, fresh
 * pre/post screenshots, fresh verification. Stops on the first attempt
 * that triggers a visible screen change OR after maxRetries+1 attempts.
 */
export async function clickAtWithRetry(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: ClickAtWithRetryOptions = {},
): Promise<ClickAtWithRetryResult> {
  const maxRetries = options.maxRetries ?? 0;
  const button: MouseButton = options.button ?? 'left';
  const preClickSettleMs = options.preClickSettleMs ?? 80;
  const postClickSettleMs = options.postClickSettleMs ?? 300;
  const moveToOptions: MoveToOptions = options.moveToOptions ?? {
    strategy: 'detect-then-move',
    forbidSlamFallback: true,
  };
  const verifyOptions: ClickVerifyOptions = options.verifyOptions ?? {};

  const attemptHistory: ClickAtWithRetryResult['attemptHistory'] = [];
  let lastMoveResult: MoveToResult | null = null;
  let lastVerification: ClickVerification | null = null;
  let lastPostShot: Buffer | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // Fresh aim every attempt — moveToPixel runs detect-then-move probe
    // afresh so cursor position is rediscovered from scratch.
    lastMoveResult = await moveToPixel(client, target, moveToOptions);

    if (preClickSettleMs > 0) await sleepMs(preClickSettleMs);

    // Pre-click screenshot taken AFTER cursor settles, so the diff
    // isolates the click's UI effect from cursor motion during move-to.
    const preShot = await client.screenshot();

    await client.mouseClick(button);

    if (postClickSettleMs > 0) await sleepMs(postClickSettleMs);
    const postShot = await client.screenshot();
    lastPostShot = postShot.buffer;

    lastVerification = await verifyClickByDiff(preShot.buffer, postShot.buffer, verifyOptions);

    attemptHistory.push({
      attempt,
      screenChanged: lastVerification.screenChanged,
      changedFraction: lastVerification.changedFraction,
    });

    if (lastVerification.screenChanged) {
      // Success — stop retrying.
      break;
    }
  }

  // Loop guarantees lastMoveResult, lastVerification, lastPostShot are set
  // (maxRetries+1 ≥ 1 always).
  return {
    success: lastVerification!.screenChanged,
    attempts: attemptHistory.length,
    finalMoveResult: lastMoveResult!,
    finalVerification: lastVerification!,
    postClickScreenshot: lastPostShot!,
    attemptHistory,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
