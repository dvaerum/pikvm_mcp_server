/**
 * Archived orphaned predicates from click-verify.ts (F13 / N2, Round 2
 * Phase 2c, 2026-08-26).
 *
 * These eight functions have ZERO real callers anywhere in src/, benches/,
 * or scratch/ — only their own dedicated test files (moved alongside them
 * into __tests__/click-verify-archive/) exercise them. They are
 * intentionally-kept regression-knowledge artifacts, not dead code
 * awaiting deletion: each one is a pure, deterministic, well-tested
 * predicate that pins a specific real historical bug or incident. See
 * docs/FUTURE-WORK.md's "click-verify.ts orphaned predicates" entry for
 * the disposition decision, and docs/adr/0003-cursor-locator-is-the-
 * front-door.md for the related `verify`-profile deletion that orphaned
 * the second-opinion pair a second time.
 *
 * Split out of click-verify.ts (rather than deleted or left in place) so
 * click-verify.ts itself only contains functions with real production
 * callers — this file is the explicit "here be historical scaffolding"
 * shelf, not a silent pile of unused exports mixed into the active module.
 * No re-export back into click-verify.ts: nothing imports these today: a
 * future caller that needs this arbitration logic again imports directly
 * from here.
 */

import { findCursorByTemplateSet } from './cursor-detect.js';
import type { CursorTemplate, DecodedScreenshot } from './cursor-detect.js';

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

/**
 * ORPHANED PREDICATES, KEPT DELIBERATELY (2026-08-24 Phase 6 audit; moved
 * into this dedicated archive file 2026-08-26, F13/N2 Round 2 Phase 2c):
 * the eight exported functions in this file (isRateLimited,
 * shouldFireDismissRecipe, shouldFireSecondOpinion, shouldAdoptSecondOpinion,
 * shouldEmitApproach, isLockScreenRecoveryError, evaluatePreClickAgreement,
 * clampPxPerMickeyRatio) have ZERO real callers anywhere in src/, benches/,
 * or scratch/ today — only their own dedicated test files exercise them.
 * The first seven were orphaned by the same event: PR #34 (1b900df,
 * 2026-07-28, "remove tap-retry — single-attempt clicks") deleted
 * `clickAtWithRetry`, the retry orchestrator that was their only real
 * caller. That commit's own message says they were "kept ... deliberately"
 * even then — this note makes that decision durable rather than tribal
 * knowledge. `clampPxPerMickeyRatio` is an EIGHTH, separately-discovered
 * zero-caller orphan (not part of PR #34's group, not previously ruled on)
 * added to this archive when it was found during the same 2026-08-26 sweep
 * that moved the other seven here — see docs/FUTURE-WORK.md for that
 * addition called out explicitly.
 *
 * They stay because each one is a pure, deterministic, well-tested
 * predicate that pins a specific real historical bug or incident — read
 * each function's own doc comment for its bug history (e.g.
 * isLockScreenRecoveryError documents its regex as "load-bearing" for
 * Phase 72's auto-recovery; evaluatePreClickAgreement's comment narrates
 * Phase 41→42→51→52→PA19-c, the densest bug-history artifact in this
 * file; shouldFireSecondOpinion/shouldAdoptSecondOpinion pin Phase 140's
 * live motion-diff mislocalization, recurring per a Phase-296 report).
 * Deleting any of them as "unused" would lose that record. If a future
 * caller needs this arbitration logic again, they're ready to use as-is;
 * if not, they still document bug classes worth remembering. Don't delete
 * these without understanding what each one protects first — read its own
 * comment, not just this note.
 *
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
 * Orphaned, kept deliberately — see the group note above `isRateLimited`
 * (this file) for why. Their most recent real caller was cursor-locator.ts's
 * `verify` profile, deleted in ADR 0003
 * (docs/adr/0003-cursor-locator-is-the-front-door.md).
 *
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
