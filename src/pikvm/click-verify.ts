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

import {
  cursorMovedAsExpected,
  decodeScreenshot,
  diffPixels,
  findCursorByTemplateSet,
} from './cursor-detect.js';
import type { DecodedScreenshot } from './cursor-detect.js';
import { moveToPixel } from './move-to.js';
import type { MoveToOptions, MoveToResult } from './move-to.js';
import type { PiKVMClient, MouseButton } from './client.js';
import { analyzeBrightness, VERY_DIM_THRESHOLD } from './brightness.js';
import { detectIpadBoundsFromBuffer } from './orientation.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './template-set.js';
import { ipadGoHome } from './ipad-unlock.js';

/**
 * Phase 127 — sanity-clamp the live px/mickey ratio reported by
 * `moveToPixel.usedPxPerMickey` before using it in the micro-
 * correction or pre-click approach math. moveToPixel sometimes
 * derives asymmetric / pathological ratios from a single noisy
 * motion-diff (live trace: usedPxPerMickey={ x: 0.7291,
 * y: 1.4833 }). Using such a low ratio in `mickeys = px / ratio`
 * means the loop emits 1.5-3× too many mickeys per residual
 * pixel — cursor over-shoots, then over-shoots back the other way
 * each iteration, oscillating around the target rather than
 * converging.
 *
 * The empirical iPad small-emit range (5-mickey chunks at slow
 * pace) is roughly 0.9-2.0 px/mickey. Outside that range the
 * measurement is unreliable; fall back to the fleet default 1.3
 * which is the validated iPad value across many sessions.
 *
 * Pure: deterministic, no I/O.
 */
export function clampPxPerMickeyRatio(
  live: number | undefined,
  min = 0.9,
  max = 2.5,
  fallback = 1.3,
): number {
  if (live === undefined || !Number.isFinite(live)) return fallback;
  if (live < min || live > max) return fallback;
  return live;
}

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
  /** Phase 43: pre-click wiggle magnitude in mickeys. iPadOS's
   *  pointer-effect snaps the cursor to interactive elements when the
   *  cursor is MOVING near them — a stationary cursor 30 px from an
   *  icon does NOT snap. A small +N/-N round-trip wiggle right before
   *  the click triggers the snap without significantly displacing the
   *  cursor. Default 5. Set 0 to disable.
   *
   *  Phase 125 (v0.5.118) deprioritises this in favour of a directional
   *  APPROACH (see `preClickApproachMickeys`) when a recent cursor
   *  position is available — the approach puts the cursor in active
   *  motion TOWARDS the icon at button-down time, which is what
   *  pointer-effect actually wants. Wiggle remains as the fallback
   *  when the cursor position is unknown (e.g. all detection failed). */
  preClickWiggleMickeys?: number;
  /** Phase 125: pre-click directional approach magnitude in mickeys.
   *  Replaces Phase 43's net-zero wiggle when a recent cursor
   *  position is known. Sends one final emit TOWARDS the target in
   *  the residual direction, then clicks IMMEDIATELY (no settle) so
   *  the button-down event arrives while the cursor is still in
   *  motion. iPadOS pointer-effect uses cursor velocity to apply
   *  icon snap; a converged-but-stationary cursor (Phase 122-123
   *  reaches 22 px residual) is NOT sufficient for snap-on-click,
   *  but a converging-into-icon cursor is. The emit magnitude is
   *  capped by both this option AND the residual-in-mickeys, so
   *  small residuals don't over-shoot. Default 5; set 0 to fall
   *  back to Phase 43 wiggle behaviour. */
  preClickApproachMickeys?: number;
  /** Phase 50: minimum live-measured px/mickey ratio for an attempt to
   *  be considered worth retrying. Live-verified 2026-04-26: when iPadOS
   *  is rate-limiting USB HID input (could be due to a popup, low-power
   *  state, accessibility throttle, or display-off-but-on state), motion-
   *  diff measures live ratio 0.5-0.8 vs expected ~3.0. The cursor
   *  barely moves regardless of emit. Skipping the attempt and surfacing
   *  the rate-limit lets the operator investigate the iPad-side issue
   *  rather than accumulating retries that all fail the same way.
   *  Default 0.4 — well below normal iPadOS variance (1.0-3.0) but above
   *  the rate-limit floor (0.5-0.8 observed). Set 0 to disable. */
  minLivePxPerMickey?: number;
  /** Phase 45: max iterations of post-move template-driven
   *  micro-correction. After moveToPixel returns, this loop runs:
   *    1. Take screenshot
   *    2. Locate cursor via full-frame template-match (ground truth)
   *    3. Compute delta to target
   *    4. If residual < `microConvergePx`, stop
   *    5. Emit small mickeys toward target (capped per iteration)
   *    6. Re-verify
   *  iPadOS pointer-acceleration variance prevented moveToPixel's
   *  motion-diff/linear approach from converging tighter than ~28-32 px
   *  in live benches. The template-match-based loop here uses the
   *  proven-reliable template-match for verification (live: 0.97 NCC
   *  scores) and small per-iteration emits to keep iPadOS in its
   *  near-1:1 linear regime. Default 5; set 0 to disable. */
  microCorrectionIterations?: number;
  /** Phase 45: residual (px) at which post-move micro-correction
   *  declares convergence. Default 8 — comfortably inside the iPadOS
   *  icon hit area (~70 px wide). */
  microConvergePx?: number;
  /** Phase 72: when an attempt fails because the iPad is on the lock
   *  screen (detect-then-move can't find the cursor), automatically
   *  call ipadGoHome to wake/unlock and retry one more time. Phase 70
   *  found this is the dominant failure mode; auto-recovery makes
   *  click_at robust without requiring the operator to remember to
   *  unlock first. SIDE EFFECT: if the iPad is INSIDE AN APP and
   *  detect-then-move fails for some other reason, the auto-recovery
   *  will exit the app to the home screen — undesired. Default false
   *  (preserve existing behaviour). Set true for fire-and-forget
   *  click_at on a fresh iPad target. */
  autoUnlockOnDetectFail?: boolean;
  /** Phase 88: skip the click if the verified cursor position is more
   *  than this many pixels from the target. Useful when callers care
   *  about CORRECT element hit, not just "screen changed somewhere".
   *  Live-verified failure mode (2026-04-27): residual 78 px caused a
   *  click targeting Settings > Software Update to instead activate
   *  the Apple Account sidebar row. Both clicks report
   *  `screenChanged: true`, but only one hit the intended element.
   *
   *  When set, attempts with residual exceeding this threshold are
   *  marked skipped and the retry loop runs again. Set to e.g. 25 for
   *  strict icon-tolerance clicks, 50 for "near-enough is fine".
   *  Default undefined (no skip; preserves prior behaviour where any
   *  cursor-verified attempt clicks regardless of residual). */
  maxResidualPx?: number;
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
  /** Phase 93: when every attempt failed for the same reason class, this
   *  holds an aggregated diagnosis suitable for one-line operator output.
   *  Null when ≥ 2 distinct failure classes ran, when only one attempt
   *  ran, or when at least one attempt was not a recognised skip. */
  failureSummary: string | null;
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
  const preClickWiggleMickeys = options.preClickWiggleMickeys ?? 5;
  const preClickApproachMickeys = options.preClickApproachMickeys ?? 5;
  // Phase 49: re-enabled with edge-aware safety + 350ms settle. Default
  // 3 iterations max — conservative; loop self-terminates when residual
  // is small or when emitting would push cursor into an iPad gesture zone.
  // Phase 122 (v0.5.116): bumped default from 3 to 5.
  // Phase 138 (v0.5.130): bumped 5 → 8 after Phase 136/137 bench
  // showed micro-mode residuals clustering at 29-36 px — exactly
  // the cap of "5 iters × 5 mickeys × 1.3 px = 32 px max
  // correction". Bumping to 8 iters gives 52 px headroom; even
  // a 60 px open-loop overshoot now converges below the 35 px
  // skip-click gate. Per-iter SETTLE_MS=350 means 8 iters adds
  // 2.8 s latency vs 5 iters' 1.75 s — acceptable for click
  // precision since the divergence guard (Phase 133) bails early
  // when convergence stalls.
  const microCorrectionIterations = options.microCorrectionIterations ?? 8;
  const microConvergePx = options.microConvergePx ?? 8;
  const minLivePxPerMickey = options.minLivePxPerMickey ?? 0.4;
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
      // Phase 48: only fail-fast on uniform dark frames. Dark-mode UI has
      // low mean but high stddev (text/icon contrast against dark bg) and
      // cursor detection works fine. Gate fires only when severity is
      // explicitly 'very-dim' (low mean AND low stddev).
      if (brightness.mean < minBrightness && brightness.severity === 'very-dim') {
        throw new Error(
          `clickAtWithRetry: screen too dim for cursor detection ` +
          `(mean=${brightness.mean.toFixed(0)}/255 stddev=${brightness.stddev.toFixed(1)}, threshold=mean<${minBrightness}+stddev<3). ` +
          `Possible causes: ` +
          `(1) iPad display brightness too low — adjust manually ` +
          `(software wakes don't restore it). ` +
          `(2) Phase 129 (v0.5.121) finding — a hidden security/privacy popup ` +
          `is open (Apple Pay / Face ID / password / app-permission prompt). ` +
          `iOS deliberately blanks these from HDMI/screen-capture output to ` +
          `prevent credential theft, BUT they remain interactive: keyboard and ` +
          `mouse events still reach the popup even though it's invisible to us. ` +
          `Try dismissing blindly: pikvm_key Escape, then Enter, then Cmd+Period; ` +
          `or pikvm_mouse_click_at on the centre of the iPad area (~960×540) ` +
          `which is where iOS centers most modal sheets. Confirm dismissal by ` +
          `re-running the click — if mean brightness recovers, the popup is gone. ` +
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
      let recoveredErr: Error | null = err as Error;
      // Phase 72: lock-screen recovery. If the throw mentions lock-screen
      // (Phase 71 error message) AND autoUnlockOnDetectFail is on, call
      // ipadGoHome to unlock and try moveToPixel one more time before
      // giving up on this attempt. Phase 70 found lock-screen state is
      // the dominant cause of detect-then-move failures.
      if (
        options.autoUnlockOnDetectFail &&
        /lock screen|pikvm_ipad_unlock/i.test(recoveredErr.message)
      ) {
        try {
          await ipadGoHome(client);
          await new Promise(r => setTimeout(r, 500));
          lastMoveResult = await moveToPixel(client, target, moveToOptions);
          lastMoveError = null;
          recoveredErr = null;
        } catch (recoveryErr) {
          recoveredErr = recoveryErr as Error;
        }
      }
      if (recoveredErr) {
        lastMoveError = recoveredErr;
        lastVerification = {
          changedPixels: 0,
          totalPixels: 0,
          changedFraction: 0,
          screenChanged: false,
          message:
            `Click skipped: moveToPixel threw — ${recoveredErr.message}`,
        };
        attemptHistory.push({
          attempt,
          screenChanged: false,
          changedFraction: 0,
          cursorVerified: false,
          skippedClickReason: `moveToPixel threw: ${recoveredErr.message}`,
        });
        continue;
      }
    }
    // After the try/catch: either moveToPixel succeeded (try) or recovery
    // succeeded (catch's nested try). Either way lastMoveResult is set.
    if (!lastMoveResult) continue; // unreachable, but narrows the type

    // Phase 50: detect iPadOS input rate-limiting via observed px/mickey.
    // Live-verified 2026-04-26: when iPadOS throttles USB HID input
    // (popup, low-power, accessibility), motion-diff measures live ratio
    // 0.5-0.8 vs expected ~3.0. Continuing to retry just wastes attempts
    // — the cursor isn't responsive to our input regardless of strategy.
    // Surface the rate-limit so the operator investigates iPad-side state.
    if (minLivePxPerMickey > 0 && lastMoveResult.usedPxPerMickey
        && isRateLimited(lastMoveResult.usedPxPerMickey, minLivePxPerMickey)) {
      const rx = lastMoveResult.usedPxPerMickey.x;
      const ry = lastMoveResult.usedPxPerMickey.y;
      const reason =
        `iPadOS rate-limiting input (live px/mickey x=${rx.toFixed(2)} y=${ry.toFixed(2)}, ` +
        `min=${minLivePxPerMickey}). Possible causes: popup intercepting input, low-power ` +
        `state, accessibility throttle, or display in off-but-on mode. Check the iPad ` +
        `directly — retries won't help while this state persists.`;
      lastVerification = {
        changedPixels: 0,
        totalPixels: 0,
        changedFraction: 0,
        screenChanged: false,
        message: `Click skipped: ${reason}`,
      };
      attemptHistory.push({
        attempt,
        screenChanged: false,
        changedFraction: 0,
        cursorVerified: false,
        skippedClickReason: `rate-limit: ratio < ${minLivePxPerMickey}`,
      });
      // Don't continue retrying — the rate-limit is a per-iPad-state
      // condition, not something a fresh probe will overcome. Break out
      // of the retry loop entirely so the caller sees a clear single
      // diagnosis instead of N identical "rate-limited" attempts.
      break;
    }

    // Phase 35: if cursor position couldn't be verified post-move,
    // skip the click — clicking blind when residual is unknown
    // risks hitting the wrong adjacent target (verified 2026-04-26).
    let cursorVerified = lastMoveResult.finalDetectedPosition !== null;

    // Phase 137 (v0.5.129): wake-nudge fallback when motion-diff +
    // template-match both failed (finalDetectedPosition=null).
    //
    // Phase 140 (v0.5.132): ALSO fire the second-opinion check
    // when motion-diff DID return a position but the residual is
    // suspiciously high (> 25 px). Live diagnostic on Settings
    // home-screen icon caught moveToPixel reporting cursor at
    // (996, 836) — residual 31 px — when the cursor's REAL
    // position was (1010, 830) — residual 17 px. The motion-diff
    // pair selection had picked the icon-LABEL feature (a static
    // text region 30 px below the icon) as the post-cluster, so
    // the reported residual was a lie. Without this Phase 140
    // gate, the maxResidualPx=35 skip gate would let this through
    // and the click would land at the wrong measured position.
    // With the gate, we re-template-match with expectedNear=target
    // hint and use the closer match if found.
    const SECOND_OPINION_RESIDUAL_PX = 25;
    const initialResidual = lastMoveResult.finalDetectedPosition
      ? Math.hypot(
          lastMoveResult.finalDetectedPosition.x - target.x,
          lastMoveResult.finalDetectedPosition.y - target.y,
        )
      : Infinity;
    if (
      sessionTemplates.length > 0 &&
      (!cursorVerified || initialResidual > SECOND_OPINION_RESIDUAL_PX)
    ) {
      try {
        await client.mouseMoveRelative(1, 0);
        await sleepMs(50);
        await client.mouseMoveRelative(-1, 0);
        await sleepMs(80);
        const wakeShot = await client.screenshot();
        const wakeDecoded = await decodeScreenshot(wakeShot.buffer);
        // Phase 139 (v0.5.131): minScore relaxed 0.85 → 0.7. Live
        // diagnostic on Settings home-screen icon showed real cursor
        // matches scoring 0.776 with the expectedNear hint — Phase
        // 137's 0.85 floor was rejecting them, so the wake-nudge
        // fallback never recovered the valid cursor. The
        // expectedNear=target + radius=200 hint provides the locality
        // protection that minScore alone used to give; matches at
        // 0.7+ within 200 px of target are real cursors, not false-
        // positives on far-away features.
        const woken = findCursorByTemplateSet(wakeDecoded, sessionTemplates, {
          minScore: 0.7,
          expectedNear: target,
          expectedNearRadius: 200,
        });
        if (woken) {
          // Phase 140: only adopt the second-opinion position if
          // it's actually CLOSER to target than what moveToPixel
          // reported. Avoid swapping a 17 px match for a 50 px one.
          const wokenResidual = Math.hypot(
            woken.position.x - target.x,
            woken.position.y - target.y,
          );
          if (!cursorVerified || wokenResidual < initialResidual) {
            (lastMoveResult as { finalDetectedPosition: { x: number; y: number } | null })
              .finalDetectedPosition = woken.position;
            cursorVerified = true;
          }
        }
      } catch {
        // Fall through; we'll skip the click as before.
      }
    }

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

    // Phase 88: maxResidualPx gate. If caller supplied a strict residual
    // limit, skip the click when cursor is too far from target — clicks
    // that land 50-100 px off can register on adjacent UI elements
    // (verified 2026-04-27: target Software Update at (1090,416), cursor
    // at (1030,466) navigated to Apple Account row instead). Callers that
    // need correct-element-hit semantics opt in by setting maxResidualPx.
    if (cursorVerified && lastMoveResult.finalDetectedPosition) {
      const skipResidual = residualForSkip(
        lastMoveResult.finalDetectedPosition,
        target,
        options.maxResidualPx,
      );
      if (skipResidual !== null) {
        lastVerification = {
          changedPixels: 0,
          totalPixels: 0,
          changedFraction: 0,
          screenChanged: false,
          message:
            `Click skipped: residual ${skipResidual.toFixed(1)}px exceeds ` +
            `maxResidualPx=${options.maxResidualPx}. Clicking would risk ` +
            `landing on an adjacent UI element. Loosen maxResidualPx if ` +
            `near-target clicks are acceptable.`,
        };
        attemptHistory.push({
          attempt,
          screenChanged: false,
          changedFraction: 0,
          cursorVerified: true,
          skippedClickReason: `residual ${skipResidual.toFixed(1)}px > maxResidualPx=${options.maxResidualPx}`,
        });
        continue;
      }
    }

    if (preClickSettleMs > 0) await sleepMs(preClickSettleMs);

    // Pre-click screenshot taken AFTER cursor settles, so the diff
    // isolates the click's UI effect from cursor motion during move-to.
    const preShot = await client.screenshot();

    // Phase 41 + Phase 42: ground-truth cursor verification before click.
    // moveToPixel's motion-diff and template-match can both false-positive-
    // verify widget-animation clusters as cursor.
    //
    // Phase 42 strengthens 41: instead of searching only a ±50 px window
    // around the claimed position, search the FULL frame for the best
    // template match. If the best match is FAR from the claimed position
    // (>100 px), the algorithm lied — real cursor is elsewhere, click would
    // hit the wrong target.
    //
    // Live-verified 2026-04-26: a Phase 41 click reported template score
    // 0.977 within ±50 px of (1058, 823), but the click opened Apple Music
    // (in the dock at ~(785, 985)) — meaning the REAL cursor was 250+ px
    // away in the dock; Phase 41's narrow-window match had locked onto a
    // cursor-like UI shadow within its window. Full-frame search would
    // have picked the higher-scoring real cursor in the dock and aborted
    // the click as "claimed position 250 px from best match".
    if (
      minPreClickTemplateScore > 0 &&
      sessionTemplates.length > 0 &&
      lastMoveResult.finalDetectedPosition
    ) {
      const preDecoded = await decodeScreenshot(preShot.buffer);
      const claimed = lastMoveResult.finalDetectedPosition;

      const verdict = evaluatePreClickAgreement(
        preDecoded,
        sessionTemplates,
        claimed,
        minPreClickTemplateScore,
      );
      if (!verdict.agree) {
        const disagreementReason = verdict.reason;
        lastVerification = {
          changedPixels: 0,
          totalPixels: 0,
          changedFraction: 0,
          screenChanged: false,
          message:
            `Click skipped: pre-click full-frame template search disagreed ` +
            `with moveToPixel's claimed cursor position. ${disagreementReason}.`,
        };
        attemptHistory.push({
          attempt,
          screenChanged: false,
          changedFraction: 0,
          cursorVerified: false,
          skippedClickReason: disagreementReason,
        });
        continue;
      }
    }

    // Phase 125: track the cursor's position across the post-
    // moveToPixel pipeline so the in-motion click (below) can use
    // the most recent observation. Initially null; the micro-
    // correction loop sets it from its template-match results.
    let lastKnownCursor: { x: number; y: number } | null = null;

    // Phase 49 (v0.5.37): bounds-aware post-move template-driven
    // micro-correction. Phase 45 (reverted) failed because:
    //   - 80 ms inter-iteration settle < streamer's 235 ms latency →
    //     stale cursor in subsequent screenshots → loop kept emitting
    //   - No edge-bounds safety → cursor pushed to iPad bottom edge
    //     triggered iPadOS's swipe-up-from-bottom gesture (app switcher)
    //   - Per-iteration emit cap of 5 mickeys was high enough to
    //     overshoot small targets when iPadOS acceleration variance
    //     amplified the emit
    //
    // Phase 49 fixes:
    //   - Settle 350 ms (well above 235 ms streamer latency)
    //   - Cap each emit at 2 mickeys per axis (kept tight; iPadOS
    //     near-1:1 in linear regime at slow pace)
    //   - Refuse to emit if it would push cursor within MARGIN px of
    //     iPad bounds edges (avoids hot-corner / bottom-edge gestures)
    if (
      microCorrectionIterations > 0 &&
      sessionTemplates.length > 0 &&
      lastMoveResult.finalDetectedPosition
    ) {
      const EDGE_MARGIN_PX = 50;
      // Phase 122 (v0.5.116): bumped from 2 to 5. The original
      // Phase 49 cap of 2 mickeys/iter (with default 3 iterations
      // and ratio 1.3 px/mickey) gave a max total correction of
      // 7.8 px — leaving residuals stuck around 30-40 px against
      // iPad icons whenever moveToPixel's linear loop converged
      // outside that range. Phase 49's safety motivation was
      // avoiding the iPad bottom-edge gesture zone; the
      // bounds-aware refusal below (wouldExceedSafeBounds) now
      // prevents that regardless of the per-iter magnitude, so
      // the tight cap is pure over-conservatism. 5 mickeys at
      // ratio 1.3 = 6.5 px/iter × 3 iters = 19.5 px max — enough
      // to bridge the typical residual gap. Also above iPadOS's
      // empirical rate-limit floor (small emits get quantised to
      // zero movement), so each iter actually moves the cursor.
      const PER_ITER_CAP_MICKEYS = 5;
      const SETTLE_MS = 350;
      // Phase 127 (v0.5.120): sanity-clamp via the pure helper
      // (see `clampPxPerMickeyRatio` below).
      const ratioX = clampPxPerMickeyRatio(lastMoveResult.usedPxPerMickey?.x);
      const ratioY = clampPxPerMickeyRatio(lastMoveResult.usedPxPerMickey?.y);
      // Detect iPad bounds for edge-safety check; full-frame fallback if
      // bounds detection fails (treat full HDMI frame as the safe area —
      // less safe but at least allows progress on non-iPad targets).
      let safeBounds: { x: number; y: number; width: number; height: number };
      try {
        const shot0 = await client.screenshot();
        const ipadBounds = await detectIpadBoundsFromBuffer(shot0.buffer, { verbose: false });
        safeBounds = { x: ipadBounds.x, y: ipadBounds.y, width: ipadBounds.width, height: ipadBounds.height };
      } catch {
        const res = await client.getResolution();
        safeBounds = { x: 0, y: 0, width: res.width, height: res.height };
      }
      let prevFound: { x: number; y: number } | null = null;
      let prevEmit: { mx: number; my: number } | null = null;
      // Phase 133 (v0.5.125): divergence detection. Track residual
      // between iterations; if it GROWS by more than 10 px, the
      // micro-correction loop is pushing the cursor in the wrong
      // direction (false-positive template-match feeding bad
      // residual → bad emit). Bail out before making things worse.
      // Phase 132 bench observed micro-mode trial 5 reach residual
      // 200 px while no-micro-mode reached 23 px on the same target;
      // micro was diverging.
      let prevResidual: number | null = null;
      // Phase 123 (v0.5.117): bias template-match search toward the
      // cursor's last-known position (from moveToPixel's motion-
      // diff). Without this hint, template-match against busy
      // screens picks up far-away false-positives — e.g. a dock
      // icon at (990, 990) scoring 0.69 against the cursor template
      // when the real cursor is near (991, 835). Locality-aware
      // ranking in findCursorByTemplateSet (cursor-detect.ts:900)
      // prefers within-radius matches over higher-scoring far ones.
      const initialHint = lastMoveResult.finalDetectedPosition;
      for (let iter = 0; iter < microCorrectionIterations; iter++) {
        const microShot = await client.screenshot();
        const microDecoded = await decodeScreenshot(microShot.buffer);
        const hint = prevFound ?? initialHint;
        const found = findCursorByTemplateSet(microDecoded, sessionTemplates, {
          minScore: minPreClickTemplateScore,
          expectedNear: hint ?? undefined,
          expectedNearRadius: 80,
        });
        if (!found) break; // can't verify, stop here (Phase 41/42 will catch)
        // Phase 120: motion-confirmation gate. If the previous iteration
        // emitted a non-zero move and the "cursor" did NOT move
        // accordingly, this match is a wallpaper false-positive (a
        // template matched a static gradient feature that NCC-correlates
        // with the cursor template, e.g. (952, 916) at score 0.71 in the
        // Phase 119 trace). Stop micro-correcting against a phantom.
        if (prevFound && prevEmit && (prevEmit.mx !== 0 || prevEmit.my !== 0)) {
          const expectedDx = prevEmit.mx * ratioX;
          const expectedDy = prevEmit.my * ratioY;
          if (!cursorMovedAsExpected(prevFound, found.position, expectedDx, expectedDy)) {
            break;
          }
        }
        prevFound = found.position;
        const dx = target.x - found.position.x;
        const dy = target.y - found.position.y;
        const residual = Math.sqrt(dx * dx + dy * dy);
        if (residual <= microConvergePx) break; // converged
        // Phase 133: divergence guard. If the new residual is
        // significantly worse than the previous, break rather than
        // continue pushing the cursor away from target. 10 px slack
        // tolerates iPadOS acceleration variance + JPEG noise without
        // letting genuine divergence (e.g. a 30→200 px run-away) bleed
        // through.
        if (prevResidual !== null && residual > prevResidual + 10) {
          break;
        }
        prevResidual = residual;
        // Cap raw delta in mickeys.
        const mxRaw = dx / ratioX;
        const myRaw = dy / ratioY;
        const mx = Math.sign(mxRaw) * Math.min(Math.ceil(Math.abs(mxRaw)), PER_ITER_CAP_MICKEYS);
        const my = Math.sign(myRaw) * Math.min(Math.ceil(Math.abs(myRaw)), PER_ITER_CAP_MICKEYS);
        if (mx === 0 && my === 0) break; // would be a no-op
        // Edge-safety: predict cursor's next position and refuse if it
        // would exit the safe-bounds margin. This is the Phase 49 fix
        // for the Phase 45 app-switcher failure mode.
        const predX = found.position.x + mx * ratioX;
        const predY = found.position.y + my * ratioY;
        if (wouldExceedSafeBounds(predX, predY, safeBounds, EDGE_MARGIN_PX)) {
          // Stop the loop rather than push toward an iPad gesture zone.
          break;
        }
        await client.mouseMoveRelative(mx, my);
        prevEmit = { mx, my };
        await sleepMs(SETTLE_MS);
      }
      // Carry the last known cursor position out of the micro-
      // correction scope so Phase 125 can compute a directional
      // approach.
      lastKnownCursor = prevFound;
    }

    // Phase 125: in-motion click. When we know the cursor's position
    // (post-micro-correction or post-moveToPixel), send one final
    // directional emit toward the target and click WITHOUT settling.
    // iPadOS pointer-effect snaps the cursor to nearby interactive UI
    // elements only while the cursor is moving towards them; a
    // stationary cursor 22 px from an icon (Phase 123 visual
    // diagnostic) does NOT register clicks on the icon, but a moving-
    // into-icon cursor does. Falls back to Phase 43's net-zero wiggle
    // when the cursor position is unknown.
    const cursorAtClick = lastKnownCursor ?? lastMoveResult.finalDetectedPosition;
    if (preClickApproachMickeys > 0 && cursorAtClick) {
      const apDx = target.x - cursorAtClick.x;
      const apDy = target.y - cursorAtClick.y;
      const apResidual = Math.hypot(apDx, apDy);
      if (apResidual >= 3) {
        // Phase 127: same sanity-clamp as the micro-correction loop.
        const apRatioX = clampPxPerMickeyRatio(lastMoveResult.usedPxPerMickey?.x);
        const apRatioY = clampPxPerMickeyRatio(lastMoveResult.usedPxPerMickey?.y);
        const apxRaw = apDx / apRatioX;
        const apyRaw = apDy / apRatioY;
        const apx = Math.sign(apxRaw) * Math.min(Math.ceil(Math.abs(apxRaw)), preClickApproachMickeys);
        const apy = Math.sign(apyRaw) * Math.min(Math.ceil(Math.abs(apyRaw)), preClickApproachMickeys);
        if (apx !== 0 || apy !== 0) {
          await client.mouseMoveRelative(apx, apy);
          // NO settle here — the click below fires while the cursor
          // is still mid-motion.
        }
      }
    } else if (preClickWiggleMickeys > 0) {
      // Phase 43 fallback: net-zero wiggle when cursor position
      // unknown. Triggers iPadOS pointer-effect via motion alone.
      await client.mouseMoveRelative(preClickWiggleMickeys, 0);
      await sleepMs(30);
      await client.mouseMoveRelative(-preClickWiggleMickeys, 0);
      await sleepMs(50); // give iPadOS time to apply pointer-effect snap
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

    // Phase 141 (v0.5.133): hidden-popup auto-dismiss between
    // retries. When the click FIRED at a verified cursor position
    // but the screen didn't change AT ALL (changedFraction
    // essentially zero), the dominant explanation is iOS's hidden
    // security popup eating the input (Phase 129). The popup is
    // invisible in HDMI but interactive. Fire the documented
    // dismiss recipe (Escape, Enter, center-tap) so the next retry
    // attempt has a chance at landing on the iPad UI.
    //
    // Gate carefully: only fire when (a) the click actually fired
    // (not skipped by maxResidualPx), (b) cursor was verified
    // (not blind), (c) screenChanged=false AND changedFraction
    // ≤ 0.001 (true zero-effect, not "small icon toggle didn't
    // pixel-diff much"). Avoids dismissing real modal sheets the
    // user might have wanted to click.
    if (
      cursorVerified &&
      !lastVerification.screenChanged &&
      lastVerification.changedFraction <= 0.001 &&
      attempt <= maxRetries
    ) {
      try {
        await client.sendKey('Escape');
        await sleepMs(60);
        await client.sendKey('Enter');
        await sleepMs(60);
        // Center-tap as a final dismiss for popups that ignore
        // keyboard. Use absolute coords if mouse mode supports it,
        // otherwise rely on the swipe to clear the popup state.
      } catch {
        // sendKey may not be available on every client; ignore.
      }
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
    failureSummary: lastVerification!.screenChanged
      ? null
      : summariseFailureClass(attemptHistory),
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Phase 49 — pure helper: would a predicted cursor position exit the
 * safe-bounds margin? This is the safety predicate that prevents the
 * micro-correction loop from pushing the cursor into iPadOS gesture
 * zones (top-left = lock screen hot corner; bottom-edge = swipe-up =
 * app switcher; top-edge = control centre / notifications).
 *
 * Returns true if the predicted (predX, predY) is OUTSIDE the
 * margin-shrunken inner rectangle. The loop should refuse to emit
 * a delta that would land here.
 *
 * Live-verified failure mode (Phase 45 reverted): without this
 * guard, the micro-correction loop pushed the cursor down to the
 * iPad's bottom edge (Y > bounds.bottom - margin) and triggered
 * the swipe-up-from-bottom system gesture — opening the app
 * switcher. Phase 49 added this predicate; it must stay correct.
 */
export function wouldExceedSafeBounds(
  predX: number,
  predY: number,
  safeBounds: { x: number; y: number; width: number; height: number },
  marginPx: number,
): boolean {
  const minX = safeBounds.x + marginPx;
  const maxX = safeBounds.x + safeBounds.width - marginPx;
  const minY = safeBounds.y + marginPx;
  const maxY = safeBounds.y + safeBounds.height - marginPx;
  return predX < minX || predX > maxX || predY < minY || predY > maxY;
}

/**
 * Phase 50 — pure helper: classify the live-measured px/mickey ratio
 * as rate-limited (true) or normal (false).
 *
 * Both axes must report a positive ratio AND be below the threshold for
 * rate-limit to be declared. A near-zero ratio on a single axis can be a
 * weak signal from a near-zero-emit-along-that-axis move (the
 * algorithm's calibration didn't get a clean measurement on that axis
 * and falls back to a stale/default ratio that may be 0). Single-axis
 * low ratio doesn't reliably indicate rate-limiting; only when BOTH axes
 * agree do we treat it as a real condition.
 */
export function isRateLimited(
  observed: { x: number; y: number },
  threshold: number,
): boolean {
  const rx = observed.x;
  const ry = observed.y;
  return rx > 0 && rx < threshold && ry > 0 && ry < threshold;
}

/**
 * Phase 95 — pure helper: pick the `maxRetries` default given the
 * target's mouse mode. Single-shot click_at on iPad (relative-mouse)
 * is ~50% reliable on tiny targets (Phase 70 bench data); with
 * retries=2 it's ~88%. Desktop (absolute-mouse) targets are reliable
 * single-shot, so retries are pure overhead. Mirrors the existing
 * mouseAbsoluteMode-driven defaults for `forbidSlamFallback` and
 * `minBrightness`.
 *
 * Extracted so the contract is unit-testable and a future revert
 * (someone removing the conditional and going back to a flat default)
 * fails a regression test instead of silently degrading the iPad UX.
 */
export function defaultMaxRetriesFor(mouseAbsoluteMode: boolean): number {
  // Phase 142 (v0.5.134): bumped iPad default 2 → 3. Phase 141's
  // auto-dismiss-popup-between-retries fires only on attempts that
  // actually fired-but-zero-effect; with maxRetries=2 (3 attempts
  // total), Phase 141 fires at most twice — and if a sticky popup
  // takes more than one Escape+Enter to clear (e.g. nested
  // permission prompts), the click_at exits before the dismiss
  // sequence completes. maxRetries=3 (4 attempts total) gives
  // Phase 141 three dismiss rounds before exhaustion. Cost: +1
  // attempt latency on terminal-failure cases; gain: success on
  // popup chains that take 2-3 dismisses to clear.
  return mouseAbsoluteMode ? 0 : 3;
}

/**
 * Phase 135 — pure helper: pick the `maxResidualPx` default given the
 * target's mouse mode. iPad targets benefit from a strict 35 px gate
 * because the open-loop move sometimes overshoots Y by 60+ px due to
 * pointer acceleration; without the gate, the click lands on an
 * adjacent icon (Books instead of Settings, etc.) and silently
 * succeeds the screen-changed test even though the wrong app
 * launched. Phase 134's bench measured this directly: 4/15 trials
 * had residuals 10-34 px (correct icon), 11/15 had residuals
 * 36-200 px (wrong icon or empty area). 35 is the documented icon
 * hit-area on a 70 px-wide iPad icon.
 *
 * Desktop targets (mouseAbsoluteMode=true) get `undefined` (no
 * default gate) — absolute-mode positioning is precise so callers
 * who want a click-success guarantee can opt in explicitly.
 *
 * Extracted so the contract is unit-testable and a regression
 * (someone removing the iPad default and going back to flat
 * `undefined`) fails a test instead of silently regressing
 * click_at quality.
 */
export function defaultMaxResidualPxFor(mouseAbsoluteMode: boolean): number | undefined {
  return mouseAbsoluteMode ? undefined : 35;
}

/** Phase 93 — discriminator for the click-skip reason classes recorded
 *  by clickAtWithRetry. Exposed so callers (the MCP handler, tests) can
 *  reason about *why* a class of attempts failed without parsing the
 *  per-attempt `skippedClickReason` strings (which contain dynamic
 *  numbers and would be brittle to grep). */
export type SkipReasonClass =
  | 'move-failed'
  | 'rate-limit'
  | 'cursor-not-verified'
  | 'residual-too-large'
  | 'pre-click-disagree';

/**
 * Phase 93 — classify a per-attempt skippedClickReason string into one of
 * the five skip classes that clickAtWithRetry can produce. Returns null
 * for unrecognised strings (defensive: future skip categories or a
 * non-skip attempt should never be aggregated under an existing class).
 *
 * Pure: never throws, never reads I/O.
 */
export function classifySkipReason(reason: string | undefined): SkipReasonClass | null {
  if (!reason) return null;
  if (reason.startsWith('moveToPixel threw:')) return 'move-failed';
  if (reason.startsWith('rate-limit:')) return 'rate-limit';
  if (reason === 'cursor not verified') return 'cursor-not-verified';
  if (/> maxResidualPx=/.test(reason)) return 'residual-too-large';
  if (
    /algorithm lied|best match score|no template match|narrow window/i.test(reason)
  ) {
    return 'pre-click-disagree';
  }
  return null;
}

/**
 * Phase 93 — summarise the failure class when EVERY attempt in
 * `attemptHistory` was skipped under the SAME class. When the class is
 * uniform, returns an actionable single-line message the MCP handler
 * can surface so the operator sees the diagnosis instead of just one
 * attempt's skip reason.
 *
 * Returns null when:
 *   - History has fewer than 2 attempts (no class-level pattern yet),
 *   - At least one attempt was not a recognised skip (mixed history),
 *   - Or attempts span ≥ 2 distinct skip classes (no clear diagnosis).
 *
 * Pure: never throws, never reads I/O.
 */
export function summariseFailureClass(
  attemptHistory: ReadonlyArray<{
    skippedClickReason?: string;
    cursorVerified?: boolean;
    screenChanged?: boolean;
  }>,
): string | null {
  if (attemptHistory.length < 2) return null;

  // Phase 112: detect the "iPadOS pointer-effect snap-zone" failure
  // mode that emerged in Phase 109-111 benches. Symptoms:
  //   - Every attempt actually clicked (no skipReason)
  //   - Cursor was verified at the requested target on every attempt
  //   - screenChanged was false on every attempt
  //
  // This is NOT an algorithm failure. The cursor IS where it was
  // requested. iPadOS's pointer-effect snap zones determine which
  // interactive element receives the click — when the cursor is in
  // the dead-zone between elements, clicks land on wallpaper and
  // register as nothing. Phase 109-111 measured this caps click-
  // success at ~50-60% for ~70 px iPad icons even with 100% cursor
  // verification.
  const allClicked = attemptHistory.every((a) => !a.skippedClickReason);
  const allVerified = attemptHistory.every((a) => a.cursorVerified === true);
  const allMissed = attemptHistory.every((a) => a.screenChanged === false);
  if (allClicked && allVerified && allMissed) {
    const n = attemptHistory.length;
    return (
      `All ${n} attempts clicked with verified cursor but no screen ` +
      `change — likely iPadOS pointer-effect snap-zone miss. The ` +
      `cursor was correctly positioned but iPadOS didn't register ` +
      `the click on the target element. For tiny iPad icons, prefer ` +
      `pikvm_ipad_launch_app (Spotlight) which is 100% reliable. See ` +
      `docs/troubleshooting/ipad-cursor-detection.md § Phase 111 for ` +
      `the empirical ~50-60% click-success ceiling.`
    );
  }

  const classes = attemptHistory.map((a) => classifySkipReason(a.skippedClickReason));
  if (classes.some((c) => c === null)) return null;
  const unique = new Set(classes);
  if (unique.size !== 1) return null;
  const klass = classes[0]!;
  const n = attemptHistory.length;
  switch (klass) {
    case 'residual-too-large':
      return (
        `All ${n} attempts skipped: cursor landing exceeded maxResidualPx ` +
        `on every attempt. Loosen maxResidualPx if near-target clicks are ` +
        `acceptable, or use keyboard navigation for tiny targets.`
      );
    case 'cursor-not-verified':
      return (
        `All ${n} attempts skipped: cursor position could not be verified ` +
        `post-move on any attempt. iPad may be locked, dim, or showing too ` +
        `much animation noise — try pikvm_ipad_unlock, check brightness, or ` +
        `use the keyboard-first workflow.`
      );
    case 'rate-limit':
      return (
        `All ${n} attempts skipped: iPadOS rate-limited USB HID input on ` +
        `every attempt. Possible causes: popup intercepting input, low-power ` +
        `state, accessibility throttle. Investigate iPad-side state — ` +
        `retries cannot recover from this.`
      );
    case 'move-failed':
      return (
        `All ${n} attempts failed: moveToPixel threw on every attempt ` +
        `(cursor cannot be located against the current screen). iPad may ` +
        `be on lock screen — call pikvm_ipad_unlock first, or pass ` +
        `autoUnlockOnDetectFail: true to recover automatically.`
      );
    case 'pre-click-disagree':
      return (
        `All ${n} attempts skipped: pre-click template search disagreed ` +
        `with motion-diff on every attempt. Cached cursor templates may be ` +
        `stale (delete ./data/cursor-templates/ to force recapture), or the ` +
        `screen has cursor-look-alike elements (status icons, glyphs).`
      );
  }
}

/**
 * Phase 88 — pure helper: compute Euclidean residual between cursor and
 * target, and decide whether the click should be skipped.
 *
 * Returns null when no skip is required (residual ≤ maxResidualPx, OR
 * maxResidualPx is undefined — opt-out behaviour). Returns the computed
 * residual as a number when the click should be skipped — the caller
 * uses it to populate the skip-reason message.
 *
 * Pulled out as a pure function so the contract is unit-testable. The
 * inline call site in clickAtWithRetry forwards directly to this helper.
 */
export function residualForSkip(
  cursor: { x: number; y: number },
  target: { x: number; y: number },
  maxResidualPx: number | undefined,
): number | null {
  if (maxResidualPx === undefined) return null;
  const dx = cursor.x - target.x;
  const dy = cursor.y - target.y;
  const residual = Math.sqrt(dx * dx + dy * dy);
  return residual > maxResidualPx ? residual : null;
}

export interface PreClickAgreement {
  /** True iff the algorithm's claimed cursor position is corroborated by
   *  a confident template match — either locally (Stage A) or via a
   *  full-frame search whose best match falls within the close-enough
   *  radius of the claim (Stage B's "agree" branch). */
  agree: boolean;
  /** Human-readable disagreement reason (empty when `agree=true`). Used
   *  in the click-skipped message so the operator knows whether the
   *  pre-click guard fired because of a low score, no match, or a
   *  truly far-off template hit. */
  reason: string;
}

export interface PreClickAgreementOptions {
  /** Stage A radius (px). Phase 52: 200 covers iPad's worst-case motion-
   *  diff Y-residual while still catching genuinely bad claims. */
  narrowRadius?: number;
  /** Stage B "close enough" tolerance (px). Mirror of `narrowRadius`. */
  closeEnoughDistance?: number;
}

/**
 * Phase 51/52/54 — pure two-stage pre-click agreement check.
 *
 * Stage A: search for a cursor template within `narrowRadius` of the
 * algorithm's claimed cursor position. If a match scores at or above
 * `minScore`, the algorithm's claim is considered locally verified —
 * agree.
 *
 * Stage B (only runs when Stage A fails): full-frame search. If no
 * template matches anywhere, or the best match falls below `minScore`,
 * the claim cannot be either confirmed or contradicted — disagree
 * with reason. If the best match is *near* the claim
 * (≤ `closeEnoughDistance` away), still agree even though it sat
 * outside the narrow window. Only when the best match is both
 * confident AND far from the claim do we conclude the algorithm lied
 * about cursor position.
 *
 * Live history: Phase 41 used Stage A only — too strict, missed
 * widget-animation false-positives. Phase 42 used Stage B only —
 * status-bar icons (battery, signal) score 0.85-0.86 against cursor
 * templates, beating real cursor in the global ranking and falsely
 * declaring "algorithm lied". Phase 51 combined both. Phase 52 widened
 * the radius from 100 → 200 px after a live false-positive (cursor was
 * 164 px Y-off, narrow window radius 100 missed it). Phase 54 extracted
 * this into a pure helper so it could be unit-tested.
 */
export function evaluatePreClickAgreement(
  preDecoded: DecodedScreenshot,
  sessionTemplates: import('./cursor-detect.js').CursorTemplate[],
  claimed: { x: number; y: number },
  minScore: number,
  options: PreClickAgreementOptions = {},
): PreClickAgreement {
  const narrowRadius = options.narrowRadius ?? 200;
  const closeEnoughDistance = options.closeEnoughDistance ?? 200;

  const narrowMatch = findCursorByTemplateSet(preDecoded, sessionTemplates, {
    searchCentre: claimed,
    searchWindow: narrowRadius,
    minScore: 0,
  });
  if (narrowMatch && narrowMatch.score >= minScore) {
    return { agree: true, reason: '' };
  }

  const bestMatch = findCursorByTemplateSet(preDecoded, sessionTemplates, {
    minScore: 0,
  });
  if (!bestMatch) {
    return { agree: false, reason: 'no template match anywhere in frame' };
  }
  if (bestMatch.score < minScore) {
    return {
      agree: false,
      reason: `best match score ${bestMatch.score.toFixed(3)} < ${minScore}`,
    };
  }
  const dx = bestMatch.position.x - claimed.x;
  const dy = bestMatch.position.y - claimed.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > closeEnoughDistance) {
    return {
      agree: false,
      reason:
        `narrow window had no match; best full-frame match ` +
        `(score=${bestMatch.score.toFixed(3)}) at ` +
        `(${bestMatch.position.x},${bestMatch.position.y}) is ` +
        `${dist.toFixed(0)} px from claimed cursor ` +
        `(${claimed.x},${claimed.y}) — algorithm lied`,
    };
  }
  return { agree: true, reason: '' };
}
