/**
 * CursorLocator — one front door for "where is the cursor?".
 *
 * See docs/adr/0003-cursor-locator-is-the-front-door.md for which profiles are
 * live and why. Each named profile reproduces the target call site's detector
 * cascade **call-for-call, same order, same thresholds**. All three profiles
 * in {@link LocateProfile} are wired to real callers today: `origin` —
 * move-to.ts's `discoverOrigin`; `openLoopShape` — move-to.ts's
 * `tryOpenLoopShapeDetect`; `curve` — curve-mover.ts's `detect`.
 *
 * Design decisions (already settled with the repo owner — see the plan):
 *  - A: the locator OWNS the CursorBelief instance (folds in candidate 5).
 *  - B: named profiles, NOT one merged cascade — merge only once a bench proves
 *       two land identically.
 *  - C: CursorFix carries provenance + HONEST confidence — never a normalised or
 *       fabricated score. ML sigmoid is a real calibrated value; motion-diff /
 *       template / shape have no calibrated confidence, so it is `null`.
 *
 * Every detector / device / verify function each profile calls is INJECTED via
 * `deps` (not imported at module scope) so the unit tests can substitute stubs
 * and assert exact call order. Only TYPES are imported here (erased at compile).
 */

import type { Bounds, CursorBelief } from './cursor-belief.js';
import type {
  CursorTemplate,
  DecodedScreenshot,
  FindCursorOptions,
  FindCursorSetResult,
  LocateCursorOptions,
  LocateCursorResult,
} from './cursor-detect.js';
import type { MLCursorOptions, MLCursorResult } from './cursor-ml-detect.js';

export type LocateProfile = 'origin' | 'openLoopShape' | 'curve';

export interface CursorFix {
  position: { x: number; y: number };
  source: 'cascade' | 'motion-diff' | 'template' | 'shape' | 'ml';
  /** Native per-source score; NEVER normalised across sources. Sources that
   *  emit no native score (motion-diff) report 0. */
  rawScore: number;
  /** ONLY where honestly calibrated: ML sigmoid = the real value; motion-diff /
   *  template / shape = null (do NOT fabricate one). */
  confidence: number | null;
  /** Optional source-specific provenance the caller may still need (e.g. the
   *  motion-diff probe's offset + mickeys that moveToPixel uses for
   *  calibration). Preserved so Phase 3 caller-reroute stays behaviour-identical. */
  probeMeasurement?: {
    offsetPx: { x: number; y: number };
    mickeys: { x: number; y: number };
  };
}

/** The native shape returned by findCursorByV8FullFrame (the dual-head cascade). */
export interface V8Detection {
  x: number;
  y: number;
  presence: number;
  heatmapPeak: number;
}

/**
 * Every collaborator each profile touches, injected so tests can stub them and
 * so Phase 2/3 can bind the real implementations (+ the client they close over).
 */
export interface CursorLocatorDeps {
  /** The belief this locator OWNS (candidate 5: belief moves out of PiKVMClient). */
  belief: CursorBelief;

  /** Fresh capture + decode. `origin` takes its OWN screenshot (probe
   *  wake-nudges), matching the current code which re-decodes a fresh frame
   *  rather than reusing a passed-in one. */
  screenshot: () => Promise<DecodedScreenshot>;
  /** Decode a passed-in frame (openLoopShape receives an already-captured frame). */
  decode: (frame: Buffer) => Promise<DecodedScreenshot>;

  /** Device nudge + settle (origin progressive-wake). */
  mouseMoveRelative: (dx: number, dy: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;

  /** Cached NCC template set (origin fallback). */
  getCachedTemplates: () => Promise<CursorTemplate[]>;

  /** `origin` skips V8 when ML is disabled (settings.ml.disabled). Evaluated per
   *  call so a mid-session settings flip is honoured, matching discoverOrigin. */
  isMlDisabled: () => boolean;

  // --- detectors (injected; never imported at module scope for the profile logic) ---
  findCursorByV8FullFrame: (
    frame: Buffer,
    width: number,
    height: number,
    options?: { minPresence?: number; hint?: { x: number; y: number } | null },
  ) => Promise<V8Detection | null>;
  locateCursor: (options: LocateCursorOptions) => Promise<LocateCursorResult | null>;
  findCursorByTemplateSet: (
    screenshot: DecodedScreenshot,
    templates: CursorTemplate[],
    options?: FindCursorOptions,
  ) => FindCursorSetResult | null;
  findCursorByMLMultiHint: (
    frame: Buffer,
    width: number,
    height: number,
    hints: Array<{ x: number; y: number }>,
    options?: Omit<MLCursorOptions, 'hint'>,
  ) => Promise<MLCursorResult | null>;
  buildMLHints: (
    predicted: { x: number; y: number },
    frameWidth: number,
    frameHeight: number,
    beliefPos?: { x: number; y: number } | null,
  ) => Array<{ x: number; y: number }>;

  // --- openLoopShape wiggle-verify helpers ---
  mlWiggleVerify: (initial: MLCursorResult) => Promise<MLCursorResult | null>;

  /** Phase 317 tautology threshold — move-to.ts:671 = 30. */
  tautologyProxThreshold: number;
}

/** curve-mover.ts:91 detect() V8 presence gate (moveByCurveOneShot default). */
const CURVE_MIN_PRESENCE = 0.5;

export class CursorLocator {
  private readonly deps: CursorLocatorDeps;
  /** The owned belief (candidate 5). */
  readonly belief: CursorBelief;

  constructor(deps: CursorLocatorDeps) {
    this.deps = deps;
    this.belief = deps.belief;
  }

  /**
   * Locate the cursor via the named profile. `frame`/`w`/`h` are the CURRENT
   * frame the caller already holds; profiles that must probe or wake-nudge take
   * their own fresh screenshots (via `deps.screenshot`) exactly as the current
   * code does. Returns null when every stage in the profile's cascade fails —
   * the caller keeps its own fallback (slam / skip); that is NOT the locator's job.
   */
  async locate(
    frame: Buffer,
    w: number,
    h: number,
    profile: LocateProfile,
    hint?: { x: number; y: number },
    opts?: { minPresence?: number },
  ): Promise<CursorFix | null> {
    switch (profile) {
      case 'origin':
        return this.locateOrigin();
      case 'openLoopShape':
        return this.locateOpenLoopShape(frame, hint);
      case 'curve':
        return this.locateCurve(frame, w, h, opts?.minPresence, hint);
    }
  }

  /** Feed a fix forward into the belief. */
  observe(fix: CursorFix): void {
    // motion-diff / template / shape have no calibrated confidence (null); the
    // belief needs a positive gain, so treat those as full-weight (1.0). ML
    // passes its real sigmoid through unchanged.
    this.belief.observe(fix.position, fix.confidence ?? 1);
  }

  reset(at: { x: number; y: number }): void {
    this.belief.reset(at);
  }

  setBounds(b: Bounds | null): void {
    this.belief.bounds = b;
  }

  /** Passthrough to belief.predict — candidate-5 belief eviction (Phase 2) needs
   *  the emit side-effect to still happen at the caller's chosen point. */
  predict(emit: { dx: number; dy: number }): void {
    this.belief.predict(emit);
  }

  // ---------------------------------------------------------------------------
  // Profiles — each mirrors its current site call-for-call, same thresholds.
  // ---------------------------------------------------------------------------

  /** discoverOrigin (move-to.ts:864): V8 (ML-gated) → motion-diff probe →
   *  template-set progressive wake. Slam/bounds are the caller's, not ours. */
  private async locateOrigin(): Promise<CursorFix | null> {
    const d = this.deps;

    // 1. V8 full-frame (dual-head cascade) — gated by settings.ml.disabled.
    if (!d.isMlDisabled()) {
      const shot = await d.screenshot();
      const v8 = await d.findCursorByV8FullFrame(shot.buffer, shot.width, shot.height);
      if (v8 !== null) {
        return {
          position: { x: v8.x, y: v8.y },
          source: 'cascade',
          rawScore: v8.presence,
          confidence: v8.presence,
        };
      }
    }

    // 2. motion-diff (probe-and-diff) — PRIMARY origin path when V8 declines.
    //    Carries probeMeasurement so moveToPixel can skip a redundant calibration.
    const located = await d.locateCursor({ maxAttempts: 2 });
    if (located) {
      return {
        position: { x: located.position.x, y: located.position.y },
        source: 'motion-diff',
        rawScore: 0,
        confidence: null,
        probeMeasurement: {
          offsetPx: located.probeOffsetPx,
          mickeys: located.probeMickeys,
        },
      };
    }

    // 3. template-set progressive wake — 3 net-zero nudges (30/60/100) with the
    //    matching settle (300/400/500) and minScore 0.85.
    const templates = await d.getCachedTemplates();
    if (templates.length > 0) {
      const wakeAttempts: Array<{ dx: number; settleMs: number }> = [
        { dx: 30, settleMs: 300 },
        { dx: 60, settleMs: 400 },
        { dx: 100, settleMs: 500 },
      ];
      for (const attempt of wakeAttempts) {
        await d.mouseMoveRelative(attempt.dx, 0);
        await d.sleep(80);
        await d.mouseMoveRelative(-attempt.dx, 0);
        await d.sleep(attempt.settleMs);
        const shot = await d.screenshot();
        const found = d.findCursorByTemplateSet(shot, templates, { minScore: 0.85 });
        if (found) {
          return {
            position: { x: found.position.x, y: found.position.y },
            source: 'template',
            rawScore: found.score,
            confidence: null,
          };
        }
      }
    }

    return null;
  }

  /** tryOpenLoopShapeDetect (move-to.ts:2022): ML multi-hint (wiggle-verified
   *  when suspiciously close) → dark+bright shape candidates, each wiggle-verified,
   *  first pass wins. Whole thing swallows errors → null, like the original. */
  private async locateOpenLoopShape(
    frame: Buffer,
    hint?: { x: number; y: number },
  ): Promise<CursorFix | null> {
    if (!hint) {
      throw new Error("cursor-locator: 'openLoopShape' profile requires a hint (the predicted target)");
    }
    const d = this.deps;
    const predicted = hint;
    try {
      const shot = await d.decode(frame);

      // ML PRIMARY: multi-hint crop detector at minConfidence 0.5.
      const hints = d.buildMLHints(predicted, shot.width, shot.height, this.belief.position);
      const ml = await d.findCursorByMLMultiHint(shot.buffer, shot.width, shot.height, hints, {
        minConfidence: 0.5,
      });
      if (ml) {
        const mlProx = Math.hypot(ml.x - predicted.x, ml.y - predicted.y);
        // findCursorByMLMultiHint returns crop {0,0} when its FULL-FRAME
        // v9-bordered cascade fired (hint-INDEPENDENT); a non-zero crop means the
        // crop-near-hint fallback fired. The tautology wiggle-verify exists to
        // reject hint-echo FPs — but a full-frame-cascade landing near the hint is
        // a GENUINE near-target hit, not an echo, so wiggle-verifying it only risks
        // false-rejecting a correct detection. Real-frame diagnosis (grey scene,
        // @nixos-developer-system) showed the cascade locating the cursor 100% at
        // 2-4px yet the guard rejecting it at upper-right (0% live locate). So skip
        // the guard for full-frame-cascade detections; keep it for crop-based ones,
        // which genuinely can be tautologies.
        const fromFullFrameCascade = ml.crop.left === 0 && ml.crop.top === 0;
        let verified: MLCursorResult | null = ml;
        if (mlProx <= d.tautologyProxThreshold && !fromFullFrameCascade) {
          verified = await d.mlWiggleVerify(ml);
        }
        if (verified) {
          return {
            position: { x: verified.x, y: verified.y },
            source: 'ml',
            rawScore: verified.confidence,
            confidence: verified.confidence,
          };
        }
        // wiggle rejected the ML detection → no fix.
      }

      // Shape fallback RETIRED (2026-07-23). bench-shape-vs-cascade-backgrounds
      // proved findCursorByShape is a DEAD + HARMFUL fallback on this path: over
      // 192 frames × 16 backgrounds it rescued 0 cascade misses (cascade was
      // 100% everywhere), hit only 1%, and MIS-fired 27% (up to 50% on busy home
      // screens) — the exact false-candidate surface the tautology wiggle-guard
      // existed to reject. The cascade carries this profile; shape only added a
      // detector to maintain and FPs to filter. See docs/FUTURE-WORK.md.
      // (findCursorByShape's SEPARATE use in move-to.ts wiggleVerifyCandidate is
      // a different mechanism and is intentionally left untouched.)
      return null;
    } catch {
      return null;
    }
  }

  /** curve-mover.ts detect(): V8 full-frame on the given frame. curve-mover's
   *  detect() is parameterised by minPresence (caller-overridable via moveToPixel →
   *  moveByCurveOneShot); the caller threads it so the reroute stays byte-identical.
   *  Defaults to CURVE_MIN_PRESENCE (0.5) when omitted. `hint` (task_484bed055820,
   *  optional) lets the cascade search a bounded window around a known/expected
   *  position first — e.g. curve-mover's post-emit landing check already knows the
   *  target it just moved toward — instead of scanning the whole region on every
   *  call; omit for genuine cold-start detects (unchanged full-region behavior). */
  private async locateCurve(
    frame: Buffer,
    w: number,
    h: number,
    minPresence: number = CURVE_MIN_PRESENCE,
    hint?: { x: number; y: number },
  ): Promise<CursorFix | null> {
    const v8 = await this.deps.findCursorByV8FullFrame(frame, w, h, {
      minPresence,
      hint,
    });
    if (v8 !== null) {
      return {
        position: { x: v8.x, y: v8.y },
        source: 'cascade',
        rawScore: v8.presence,
        confidence: v8.presence,
      };
    }
    return null;
  }
}
