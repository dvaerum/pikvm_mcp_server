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

import path from 'path';
import {
  decodeScreenshot,
  diffPixels,
  findCursorByTemplateSet,
} from './cursor-detect.js';
import type { DecodedScreenshot } from './cursor-detect.js';
import { moveToPixel } from './move-to.js';
import type { MoveToOptions, MoveToResult } from './move-to.js';
import { loadSettings } from '../settings.js';
import type { PiKVMClient, MouseButton } from './client.js';

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
  /** M6: an explicit rectangular ROI in screenshot px, top-left origin.
   *  When set it TAKES PRECEDENCE over `region` (the internal
   *  target-centered square): the caller knows the exact box where the
   *  tap's effect appears (e.g. a PIN-dots field) and scopes the diff
   *  there, so a small legit change registers instead of being diluted
   *  by the full frame. Surfaced as the `expectRegion` arg on
   *  pikvm_mouse_click_at. Clamped to frame bounds. */
  regionRect?: { x: number; y: number; width: number; height: number };
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

  if (options.regionRect) {
    // M6 expectRegion: an explicit rectangular ROI. Takes precedence over the
    // target-centered `region` — the caller pinpoints the effect box (e.g. the
    // PIN-dots field), so scope the diff there. Half-open [x0,x1)×[y0,y1),
    // clamped to frame bounds.
    const r = options.regionRect;
    const x0 = Math.max(0, Math.round(r.x));
    const x1 = Math.min(pre.width, Math.round(r.x + r.width));
    const y0 = Math.max(0, Math.round(r.y));
    const y1 = Math.min(pre.height, Math.round(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        totalPixels++;
        if (mask[y * pre.width + x]) changedPixels++;
      }
    }
  } else if (options.region) {
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
  const scope = options.regionRect || options.region ? 'ROI' : 'screen';
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
 * Phase 147 (v0.5.137) — pure helper: gate the Phase 141 hidden-popup
 * auto-dismiss recipe (Escape+Enter between retries). Extracted from
 * the inline predicate in clickAtWithRetry so the contract is
 * unit-testable and a future revert can't silently regress the iOS
 * hidden-security-popup recovery path.
 *
 * Fire conditions (ALL must hold):
 *  - cursorVerified: the click actually fired at a verified cursor
 *    position (not a blind/skipped attempt). Firing the dismiss
 *    recipe on a skipped attempt would be wasted effort.
 *  - !screenChanged: the click visibly produced no UI change.
 *  - changedFraction ≤ 0.001: the change was true zero-effect, not a
 *    small icon toggle (e.g. a checkbox flicker) that the
 *    minChangedFraction floor rejected. Without this floor, we'd
 *    auto-dismiss real intentional clicks on tiny UI controls.
 *  - attempt ≤ maxRetries: we have at least one more retry round to
 *    benefit from the dismiss; firing on the FINAL attempt is wasted.
 *
 * Pure: deterministic, no I/O.
 */
export function shouldFireDismissRecipe(args: {
  cursorVerified: boolean;
  screenChanged: boolean;
  changedFraction: number;
  attempt: number;
  maxRetries: number;
}): boolean {
  return (
    args.cursorVerified &&
    !args.screenChanged &&
    args.changedFraction <= 0.001 &&
    args.attempt <= args.maxRetries
  );
}

/**
 * Phase 148 (v0.5.138) — pure helper: gate the Phase 137/140 wake-
 * nudge + second-opinion template-match. Extracted from the inline
 * predicate in clickAtWithRetry so the trigger conditions are
 * regression-pinned.
 *
 * Fire conditions:
 *  - hasTemplates: at least one cached cursor template is loaded.
 *    Without templates, second-opinion has nothing to match against.
 *  - !cursorVerified OR initialResidual > secondOpinionResidualPx:
 *    fire EITHER when motion-diff failed completely (cursor not
 *    located at all) OR when motion-diff returned a position but the
 *    residual is suspiciously high. Phase 140 caught a live case
 *    where motion-diff picked an icon-LABEL feature 30 px below the
 *    real cursor — without this trigger the click would have landed
 *    on the wrong measured position.
 *
 * Pure: deterministic, no I/O.
 */
export function shouldFireSecondOpinion(args: {
  hasTemplates: boolean;
  cursorVerified: boolean;
  initialResidual: number;
  secondOpinionResidualPx?: number;
}): boolean {
  if (!args.hasTemplates) return false;
  const threshold = args.secondOpinionResidualPx ?? 25;
  return !args.cursorVerified || args.initialResidual > threshold;
}

/**
 * Phase 148 (v0.5.138) — pure helper: decide whether the second-
 * opinion template match should REPLACE the position reported by
 * motion-diff. Phase 140 added this guard after observing that an
 * unconditional swap could replace a good 17 px motion-diff match
 * with a worse 50 px template match (the wake-nudge frame might
 * catch the cursor mid-flight). Adopt only when:
 *  - cursor was not verified at all (anything is better than blind), OR
 *  - the second-opinion position is strictly closer to target.
 *
 * Pure: deterministic, no I/O.
 */
export function shouldAdoptSecondOpinion(args: {
  cursorVerified: boolean;
  wokenResidual: number;
  initialResidual: number;
}): boolean {
  return !args.cursorVerified || args.wokenResidual < args.initialResidual;
}

/**
 * Phase 150 (v0.5.140) — pure helper: gate Phase 125's in-motion
 * approach emit. The in-motion click sends one final directional
 * mickey emit toward target and clicks WITHOUT settling.
 * Historical framing (unverified, see REJECTED_CLAIMS.md):
 * "exploits iPadOS pointer-effect's 'snap-to-icon while moving'
 * behavior". Mechanism is hypothesis; the empirical effect of
 * the in-motion emit is the actual evidence. The emit is wasted
 * (and can over-shoot via acceleration variance) when the
 * residual is already sub-pixel-noise distance from target.
 *
 * Fire conditions:
 *  - preClickApproachMickeys > 0: feature opt-in (caller can disable
 *    by passing 0).
 *  - cursorKnown: we have a position to compute the emit from. With
 *    no known cursor, the math would NaN-poison the chunk size.
 *  - residual ≥ minResidualPx (default 3): far enough from target to
 *    benefit from an emit. Below 3 px the cursor is at sub-pixel
 *    distance; an extra emit just adds acceleration noise.
 *    (Historical framing: "already inside iPadOS's pointer-effect
 *    snap radius"; that mechanism is on REJECTED_CLAIMS.md as
 *    unverified.)
 *
 * Pure: deterministic, no I/O.
 */
export function shouldEmitApproach(args: {
  preClickApproachMickeys: number;
  cursorKnown: boolean;
  residual: number;
  minResidualPx?: number;
}): boolean {
  if (args.preClickApproachMickeys <= 0) return false;
  if (!args.cursorKnown) return false;
  const minResidual = args.minResidualPx ?? 3;
  return args.residual >= minResidual;
}

/**
 * Phase 153 (v0.5.143) — pure helper: gate Phase 38's fail-fast
 * brightness precheck. Phase 48 (v0.5.36) fixed a false-positive
 * where dark-mode iPads (low mean RGB but high stddev from icon /
 * text contrast) were spuriously failing the precheck despite
 * cursor detection working fine on them.
 *
 * The fix added a severity-class guard: only fail-fast on UNIFORM
 * dim frames (severity === 'very-dim', set by classifyBrightness
 * when BOTH mean is low AND stddev < 3). Dark-mode UI scores
 * severity='dim' (low mean, but stddev > 3 from contrast features),
 * which the precheck deliberately does NOT trip.
 *
 * The two-condition AND is load-bearing: dropping the severity
 * check would re-introduce the dark-mode false-positive that
 * blocked normal click_at on dark-mode apps for an entire session
 * before Phase 48 was diagnosed.
 *
 * Pure: deterministic, no I/O.
 */
export function isScreenTooDimForCursorDetection(args: {
  mean: number;
  severity: 'normal' | 'dim' | 'very-dim';
  minBrightness: number;
}): boolean {
  return args.mean < args.minBrightness && args.severity === 'very-dim';
}

/**
 * Phase 154 (v0.5.144) — pure helper: detect whether a moveToPixel
 * error indicates lock-screen state, suitable for Phase 72's
 * auto-recovery path. The regex matches either "lock screen" (human-
 * readable phrase from Phase 71's error message) OR
 * "pikvm_ipad_unlock" (tool-name reference). Both alternatives are
 * load-bearing — if Phase 71's wording changes to "lockscreen" or
 * the tool name is renamed, the recovery silently stops firing.
 *
 * Phase 75 (v0.5.45) added regression tests for the error-message
 * format itself; this helper additionally pins the DETECTION
 * regex as a separate concern (the message can stay the same while
 * the regex breaks if someone narrows it).
 *
 * Pure: deterministic, no I/O.
 */
export function isLockScreenRecoveryError(message: string): boolean {
  return /lock screen|pikvm_ipad_unlock/i.test(message);
}

/**
 * Phase 155 (v0.5.145) — pure helper: compute one chunked mickey
 * emit from a raw fractional count, capped at `maxMickeys`. Used by
 * both the micro-correction loop (per-iteration emit) and the
 * Phase 125 in-motion approach. The math has subtle edge cases:
 *
 *  - Math.sign(0) === 0, so a zero raw count returns 0 (no emit).
 *  - Math.ceil rounds magnitude up (e.g. raw=2.1 → 3 mickeys), so
 *    sub-1-mickey residuals still emit 1 mickey if the sign is
 *    non-zero. This intentionally avoids stalling at fractional
 *    distances.
 *  - The cap is applied to magnitude AFTER ceil, so raw=10.5 with
 *    cap=5 returns sign*5, NOT sign*ceil(10.5) = 11.
 *  - Negative raw values produce negative output (sign-preserving).
 *
 * Pure: deterministic, no I/O.
 */
export function chunkMickeys(rawMickeys: number, maxMickeys: number): number {
  if (!Number.isFinite(rawMickeys)) return 0;
  if (maxMickeys <= 0) return 0;
  return (
    Math.sign(rawMickeys) *
    Math.min(Math.ceil(Math.abs(rawMickeys)), maxMickeys)
  );
}

/**
 * Phase 156 (v0.5.146) — pure helper: pick the open-loop chunk pace
 * default given the target's mouse mode. Phase 136 (v0.5.128) measured
 * a 167-mickey Y emit landing 60 px past target on iPad at 30 ms
 * pace — iPadOS pointer acceleration was tracking velocity across
 * the chunk burst, so 9 chunks of 20 mickeys each were seen as one
 * fast burst. Slowing to 100 ms lets velocity decay between chunks,
 * keeping each chunk in the linear regime that calibration measured.
 *
 * iPad targets (mouseAbsoluteMode=false) get 100 ms. Desktop
 * (mouseAbsoluteMode=true) doesn't have iPadOS pointer acceleration,
 * so the default 30 ms (returned as undefined → caller's default
 * applies) is retained.
 *
 * Extracted so the iPad value is regression-pinned. A future revert
 * to 30 ms (or "let's optimise latency by halving this") would silently
 * re-introduce Phase 136's overshoot bug.
 *
 * Pure: deterministic, no I/O.
 */
export function defaultChunkPaceMsFor(mouseAbsoluteMode: boolean): number | undefined {
  return mouseAbsoluteMode ? undefined : 100;
}

/**
 * Phase 165 (v0.5.155) — run the documented Phase 141 hidden-popup
 * dismiss recipe: Escape → 60 ms → Enter → 60 ms. Caller-friendly
 * version of the inline recipe Phase 141 fires between retries
 * inside `clickAtWithRetry`. Exposed so the MCP `pikvm_dismiss_popup`
 * tool can invoke it on demand.
 *
 * Why this recipe: iOS HDMI-blocked security popups (Apple Pay,
 * Face ID, password, app permission, Low Battery) are invisible in
 * HDMI capture but remain interactive. Phase 162 (v0.5.152) live-
 * verified that Escape DOES dismiss visible system popups (the
 * Low Battery 10% modal cleared cleanly with a single Escape).
 * Enter is sent as a fallback for popups whose default action is
 * an OK button rather than Cancel.
 *
 * 2026-06-03 escalation: a Low Battery 5% modal that had been
 * sitting on the home screen for hours (HDMI frame frozen, no
 * visual updates) absorbed Escape with no effect — modal had lost
 * keyboard focus or the system was deferring input. Cmd+H (system
 * Home shortcut) bypassed it in one step and the home screen
 * became responsive again. Added as opt-in escalation: pass
 * `tryCmdH: true` to append Cmd+H AFTER Escape+Enter. NOT default
 * because Cmd+H exits any foreground app — destructive if the
 * popup was inside an app the user wanted to stay in. Use when:
 *   - the iPad is on (or expected to be on) the home screen, AND
 *   - Escape+Enter alone did not produce a visible state change.
 *
 * Errors from sendKey are caught — some clients may not support it.
 * Returns the count of keys sent so callers can sanity-check.
 */
export async function runDismissRecipe(
  client: {
    sendKey: (k: string) => Promise<void>;
    sendShortcut?: (keys: string[]) => Promise<void>;
  },
  opts?: { tryCmdH?: boolean },
): Promise<{ keysSent: number; errors: string[] }> {
  const errors: string[] = [];
  let keysSent = 0;
  try {
    await client.sendKey('Escape');
    keysSent++;
    await sleepMs(60);
  } catch (err) {
    errors.push(`Escape: ${(err as Error).message}`);
  }
  try {
    await client.sendKey('Enter');
    keysSent++;
    await sleepMs(60);
  } catch (err) {
    errors.push(`Enter: ${(err as Error).message}`);
  }
  if (opts?.tryCmdH && client.sendShortcut) {
    try {
      await client.sendShortcut(['MetaLeft', 'KeyH']);
      keysSent++;
      await sleepMs(60);
    } catch (err) {
      errors.push(`Cmd+H: ${(err as Error).message}`);
    }
  }
  return { keysSent, errors };
}

/**
 * Phase 172 (v0.5.162) — pure helper: format the user-visible
 * summary text returned by the `pikvm_dismiss_popup` MCP handler.
 * Extracted so the two formatting branches (clean vs error-path)
 * are unit-testable. Mentioning `pikvm_screenshot` is load-bearing:
 * the user/agent needs to verify the dismiss took effect, and the
 * recommended verification path is a screenshot.
 *
 * Pure: deterministic, no I/O.
 */
export function formatDismissResult(result: {
  keysSent: number;
  errors: string[];
}): string {
  if (result.errors.length === 0) {
    return (
      `Dismiss recipe sent ${result.keysSent} keys (Escape, Enter). ` +
      `If a hidden popup was eating input, it should now be cleared — ` +
      `verify with pikvm_screenshot and retry the original action.`
    );
  }
  return (
    `Dismiss recipe sent ${result.keysSent} keys with ` +
    `${result.errors.length} error(s): ${result.errors.join('; ')}. ` +
    `Best-effort dismiss continued anyway.`
  );
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
  // The proximity gate is an integer argument (`maxResidualPx` on
  // pikvm_mouse_click_at / clickAtWithRetry). When a positive number is passed,
  // that value is used. When it is not passed, the default is 25 px on iPad
  // (tight enough to reject adjacent-icon wrong-clicks; a 70 px icon tolerates
  // ~half its width). The config line PIKVM_CLICK_MAX_RESIDUAL_PX overrides the
  // default without a rebuild:
  //   PIKVM_CLICK_MAX_RESIDUAL_PX=40   → default 40 px
  //   PIKVM_CLICK_MAX_RESIDUAL_PX=off  (or 0) → disable the gate
  const raw = loadSettings().movement.clickMaxResidualPxRaw;
  if (raw !== undefined) {
    if (raw === '0' || raw.toLowerCase() === 'off') return undefined;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return mouseAbsoluteMode ? undefined : 25;
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
 * single-attempt click path in pikvm_mouse_click_at calls it before the tap.
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
  /** NCC score below which a disagreeing match is "inconclusive" rather
   *  than evidence the algorithm lied. PA19-c default 0.85 — real
   *  bordered cursor matches above; stale-template false positives on
   *  status-bar / widget chrome typically score 0.5-0.65. */
  lieScoreThreshold?: number;
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
  // 2026-05-28 PA19-c: only call it a "lie" when the disagreeing NCC
  // match has a STRONG score (≥0.85), not a borderline-above-floor
  // 0.5+ match. The pre-click check was designed for an era when NCC
  // was the primary detector and ~0.85 was the "real cursor" band.
  // Now ML (v9-bordered) is primary and produces high-confidence
  // claims; cached NCC templates often include stale borderless-cursor
  // entries that yield 0.5-0.65 false positives on UI features
  // (e.g. status-bar widgets). Forcing the lie verdict to require
  // a strong NCC score prevents stale-template FPs from overriding
  // good ML detections.
  const lieScoreThreshold = options.lieScoreThreshold ?? 0.85;

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
  if (!bestMatch || bestMatch.score < lieScoreThreshold) {
    // No confident disagreement signal. Trust the ML claim — running
    // template-match without a strong winner is inconclusive, not
    // evidence of a lie.
    return { agree: true, reason: '' };
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
