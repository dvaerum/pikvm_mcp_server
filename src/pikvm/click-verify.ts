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

import { decodeScreenshot, diffPixels, findCursorByTemplateSet } from './cursor-detect.js';
import type { DecodedScreenshot } from './cursor-detect.js';
import { moveToPixel } from './move-to.js';
import type { MoveToOptions, MoveToResult } from './move-to.js';
import type { PiKVMClient, MouseButton } from './client.js';
import { analyzeBrightness, VERY_DIM_THRESHOLD } from './brightness.js';
import { detectIpadBoundsFromBuffer } from './orientation.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './template-set.js';

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
  /** Phase 35: when true (default), skip the click if moveToPixel
   *  returned `finalDetectedPosition === null` — i.e. neither
   *  motion-diff nor template-match could verify where the cursor
   *  ended up after the open-loop emit. In that state the cursor is
   *  somewhere within ±100s of pixels of the predicted landing and
   *  clicking is a coin flip — risks hitting an adjacent app icon
   *  instead of the intended target. Live-verified 2026-04-26: a
   *  bench trial that clicked-anyway under this state opened
   *  Calendar instead of Settings. With requireVerifiedCursor on,
   *  the unverified attempt is recorded as a no-click failure and
   *  the retry loop tries afresh. Set false to preserve the old
   *  click-anyway behaviour (only useful for non-iPad targets where
   *  detection is reliable enough that null finalDetectedPosition
   *  is rare). Default true. */
  requireVerifiedCursor?: boolean;
  /** Phase 38: minimum mean RGB brightness (0-255) required to even
   *  attempt the click. Live-verified 2026-04-26: an iPad in a dim
   *  display state (mean=29) made every motion-diff probe fail. The
   *  retry loop wasted 3 attempts on a known-bad environment.
   *  Pre-checking the brightness once and failing fast saves the
   *  retry budget AND tells the operator to wake the iPad before
   *  trying again. Set 0 to disable the precheck. Default
   *  VERY_DIM_THRESHOLD (50) — matches the threshold below which
   *  cursor detection has reliably failed in tests. */
  minBrightness?: number;
  /** Phase 41: minimum NCC template-match score required to accept
   *  moveToPixel's claimed cursor position as ground truth. Live-verified
   *  2026-04-26: a 5-trial bench had moveToPixel report verified cursor
   *  at residual 28-32 px on every trial, but ALL clicks missed the
   *  target. Hypothesis confirmed: motion-diff/template-match inside
   *  moveToPixel was false-positive-verifying widget-animation clusters
   *  as the cursor. Adding a tight pre-click template re-check in a
   *  ±50 px window around the claimed position catches the lie before
   *  we waste a click. Requires cached cursor templates (./data/cursor-
   *  templates/); if the set is empty the check is a no-op. Set 0 to
   *  disable. Default 0.5 — loose enough to admit cursor matches across
   *  varied wallpaper backdrops, strict enough to reject "cursor at
   *  arbitrary widget" false positives. */
  minPreClickTemplateScore?: number;
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
  /** Per-attempt verification verdicts in order, for diagnostics.
   *  Phase 35: `cursorVerified` indicates whether moveToPixel's
   *  finalDetectedPosition was non-null going into the click; when
   *  false, the click was either skipped (requireVerifiedCursor
   *  default) or proceeded blind (requireVerifiedCursor=false). */
  attemptHistory: {
    attempt: number;
    screenChanged: boolean;
    changedFraction: number;
    cursorVerified: boolean;
    skippedClickReason?: string;
  }[];
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
  const requireVerifiedCursor = options.requireVerifiedCursor ?? true;
  const minBrightness = options.minBrightness ?? VERY_DIM_THRESHOLD;
  const minPreClickTemplateScore = options.minPreClickTemplateScore ?? 0.5;
  // Load cursor templates ONCE outside the retry loop. Empty set →
  // pre-click template check is a no-op (graceful degradation).
  const sessionTemplates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR).catch(() => []);

  // Phase 38: brightness precheck — fail fast on a dim screen. Live-verified
  // 2026-04-26: cursor detection reliably fails when iPad display brightness
  // is below ~50/255. Better to throw a clear "wake the iPad" error after
  // one screenshot than to waste maxRetries+1 attempts on a known-bad
  // environment. Set minBrightness=0 to skip the precheck.
  //
  // Phase 38b (v0.5.27): scope the brightness measurement to detected iPad
  // bounds. Without this, the ~67% black letterbox in a 1920×1080 frame
  // dragged the mean below threshold even on a fully-bright iPad — false
  // positive verified live 2026-04-26.
  if (minBrightness > 0) {
    try {
      const shot = await client.screenshot();
      let region: { x: number; y: number; width: number; height: number } | undefined;
      try {
        const bounds = await detectIpadBoundsFromBuffer(shot.buffer, { verbose: false });
        region = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      } catch {
        // No bounds → analyse full frame (non-iPad target or dark screen).
      }
      const brightness = await analyzeBrightness(shot.buffer, { region });
      if (brightness.mean < minBrightness) {
        throw new Error(
          `clickAtWithRetry: screen too dim for cursor detection ` +
          `(mean brightness=${brightness.mean.toFixed(0)}/255, threshold=${minBrightness}). ` +
          `Possible causes: (1) iPad display brightness too low — adjust manually ` +
          `(software wakes don't restore it); (2) a security/permission popup is open — ` +
          `it may be positioned off the HDMI capture frame but is still interactive, ` +
          `try sending Escape via pikvm_key, then Enter, then Cmd+Period. ` +
          `Set minBrightness=0 to skip this check.`,
        );
      }
    } catch (err) {
      // If the precheck itself fails (e.g. screenshot RPC error), treat as
      // ambiguous and let the main loop run — it'll surface its own errors.
      // Re-throw the dim-screen error since that's the diagnostic we want.
      if ((err as Error).message.includes('screen too dim')) throw err;
    }
  }

  const attemptHistory: ClickAtWithRetryResult['attemptHistory'] = [];
  let lastMoveResult: MoveToResult | null = null;
  let lastVerification: ClickVerification | null = null;
  let lastPostShot: Buffer | null = null;

  let lastMoveError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // Fresh aim every attempt — moveToPixel runs detect-then-move probe
    // afresh so cursor position is rediscovered from scratch.
    //
    // Phase 36: catch moveToPixel throws (e.g. forbidSlamFallback when
    // cursor cannot be located) and treat them as a failed attempt rather
    // than aborting the whole retry sequence. iPadOS sometimes hides the
    // cursor entirely; on the next attempt the detect probes themselves
    // re-render it. Letting the retry loop run again gives it a chance.
    try {
      lastMoveResult = await moveToPixel(client, target, moveToOptions);
      lastMoveError = null;
    } catch (err) {
      lastMoveError = err as Error;
      lastVerification = {
        changedPixels: 0,
        totalPixels: 0,
        changedFraction: 0,
        screenChanged: false,
        message:
          `Click skipped: moveToPixel threw — ${lastMoveError.message}`,
      };
      attemptHistory.push({
        attempt,
        screenChanged: false,
        changedFraction: 0,
        cursorVerified: false,
        skippedClickReason: `moveToPixel threw: ${lastMoveError.message}`,
      });
      continue;
    }

    // Phase 35: if cursor position couldn't be verified post-move,
    // skip the click — clicking blind when residual is unknown
    // risks hitting the wrong adjacent target (verified 2026-04-26).
    const cursorVerified = lastMoveResult.finalDetectedPosition !== null;
    if (requireVerifiedCursor && !cursorVerified) {
      // Mark this attempt as a no-click failure. Don't take pre/post
      // screenshots since there's nothing to compare. Synthesise a
      // verification result so callers see the structure they expect.
      lastVerification = {
        changedPixels: 0,
        totalPixels: 0,
        changedFraction: 0,
        screenChanged: false,
        message:
          `Click skipped: cursor position not verified after move ` +
          `(motion-diff and template-match both failed). Predicted ` +
          `landing alone is unreliable on busy screens; clicking blind ` +
          `risks hitting the wrong adjacent target. Set ` +
          `requireVerifiedCursor=false to override.`,
      };
      attemptHistory.push({
        attempt,
        screenChanged: false,
        changedFraction: 0,
        cursorVerified: false,
        skippedClickReason: 'cursor not verified',
      });
      // Don't break — let the retry loop attempt fresh detection.
      continue;
    }

    if (preClickSettleMs > 0) await sleepMs(preClickSettleMs);

    // Pre-click screenshot taken AFTER cursor settles, so the diff
    // isolates the click's UI effect from cursor motion during move-to.
    const preShot = await client.screenshot();

    // Phase 41: ground-truth cursor verification before click. moveToPixel's
    // motion-diff and template-match can both false-positive-verify widget
    // animation clusters as cursor. Live bench 2026-04-26: 4/5 trials had
    // verified cursor at 28-32 px residual but ALL 5 clicks missed —
    // suggesting the verification was a lie. Re-check by running
    // template-match on the pre-click screenshot in a ±50 px window around
    // the claimed cursor position; if it doesn't agree, skip the click.
    if (
      minPreClickTemplateScore > 0 &&
      sessionTemplates.length > 0 &&
      lastMoveResult.finalDetectedPosition
    ) {
      const preDecoded = await decodeScreenshot(preShot.buffer);
      const found = findCursorByTemplateSet(preDecoded, sessionTemplates, {
        searchCentre: lastMoveResult.finalDetectedPosition,
        searchWindow: 50,
        minScore: 0,
      });
      if (!found || found.score < minPreClickTemplateScore) {
        const claimedScore = found ? found.score.toFixed(3) : 'no match';
        lastVerification = {
          changedPixels: 0,
          totalPixels: 0,
          changedFraction: 0,
          screenChanged: false,
          message:
            `Click skipped: pre-click template re-check disagreed with ` +
            `moveToPixel's claimed cursor position (template score=` +
            `${claimedScore} < ${minPreClickTemplateScore} threshold). ` +
            `The motion-diff verification was likely a false positive on ` +
            `a widget-animation cluster.`,
        };
        attemptHistory.push({
          attempt,
          screenChanged: false,
          changedFraction: 0,
          cursorVerified: false,
          skippedClickReason: `pre-click template score ${claimedScore} < ${minPreClickTemplateScore}`,
        });
        continue;
      }
    }

    await client.mouseClick(button);

    if (postClickSettleMs > 0) await sleepMs(postClickSettleMs);
    const postShot = await client.screenshot();
    lastPostShot = postShot.buffer;

    lastVerification = await verifyClickByDiff(preShot.buffer, postShot.buffer, verifyOptions);

    attemptHistory.push({
      attempt,
      screenChanged: lastVerification.screenChanged,
      changedFraction: lastVerification.changedFraction,
      cursorVerified,
    });

    if (lastVerification.screenChanged) {
      // Success — stop retrying.
      break;
    }
  }

  // Phase 36: if EVERY attempt threw, there's no MoveToResult or
  // screenshot to return. Re-throw the last error so the caller sees the
  // underlying problem (e.g. cursor cannot be located, even after
  // maxRetries probes). Without this, `lastMoveResult!` would crash with
  // "cannot read properties of null".
  if (lastMoveResult === null) {
    throw new Error(
      `clickAtWithRetry: every attempt (${attemptHistory.length}) failed to ` +
      `establish a cursor position — last error was: ` +
      `${lastMoveError?.message ?? 'unknown'}. ` +
      `Try waking the iPad, calling pikvm_health_check to verify the target, ` +
      `or use the keyboard-first workflow.`,
    );
  }

  // If every attempt was skipped (cursor never verified), there's no
  // post-click screenshot to return. Use the LAST move's screenshot as
  // a stand-in so callers always have an image to inspect.
  if (lastPostShot === null) {
    lastPostShot = lastMoveResult.screenshot;
  }

  return {
    success: lastVerification!.screenChanged,
    attempts: attemptHistory.length,
    finalMoveResult: lastMoveResult,
    finalVerification: lastVerification!,
    postClickScreenshot: lastPostShot,
    attemptHistory,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
