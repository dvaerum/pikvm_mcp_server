/**
 * CursorLocator — one front door for "where is the cursor?".
 *
 * Candidate 1 / Phase 1 of docs/plans/cursor-locator-and-mover-collapse.md.
 * This is the OFFLINE-ONLY skeleton: nothing calls it yet, so it changes NO
 * existing behaviour. Each named profile reproduces TODAY's detector cascade
 * **call-for-call, same order, same thresholds**; Phase 3 reroutes the real
 * callers (discoverOrigin / tryOpenLoopShapeDetect / click-verify / curve-mover)
 * through it and proves byte-identical detector call sequences on hardware.
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
import type { ShapeCandidate, ShapeOptions } from './cursor-shape-detect.js';

export type LocateProfile = 'origin' | 'openLoopShape' | 'verify' | 'curve';

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

  /** Fresh capture + decode. `origin` and `verify` take their OWN screenshots
   *  (probe wake-nudges / second-opinion wake), matching the current code which
   *  re-decodes a fresh frame rather than reusing a passed-in one. */
  screenshot: () => Promise<DecodedScreenshot>;
  /** Decode a passed-in frame (openLoopShape receives an already-captured frame). */
  decode: (frame: Buffer) => Promise<DecodedScreenshot>;

  /** Device nudge + settle (origin progressive-wake, verify second-opinion wake). */
  mouseMoveRelative: (dx: number, dy: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;

  /** Cached NCC template set (origin fallback, verify second-opinion). */
  getCachedTemplates: () => Promise<CursorTemplate[]>;

  /** `origin` skips V8 when ML is disabled (settings.ml.disabled). Evaluated per
   *  call so a mid-session settings flip is honoured, matching discoverOrigin. */
  isMlDisabled: () => boolean;

  // --- detectors (injected; never imported at module scope for the profile logic) ---
  findCursorByV8FullFrame: (
    frame: Buffer,
    width: number,
    height: number,
    options?: { minPresence?: number },
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
  findCursorByShape: (
    rgb: Buffer,
    width: number,
    height: number,
    options?: ShapeOptions,
  ) => ShapeCandidate | null;
  buildMLHints: (
    predicted: { x: number; y: number },
    frameWidth: number,
    frameHeight: number,
    beliefPos?: { x: number; y: number } | null,
  ) => Array<{ x: number; y: number }>;

  // --- openLoopShape wiggle-verify helpers ---
  mlWiggleVerify: (initial: MLCursorResult) => Promise<MLCursorResult | null>;
  wiggleVerifyCandidate: (
    pos: { x: number; y: number },
    score: number,
  ) => Promise<{ pos: { x: number; y: number } } | null>;

  // --- verify arbiters (pure predicates) ---
  shouldFireSecondOpinion: (args: {
    hasTemplates: boolean;
    cursorVerified: boolean;
    initialResidual: number;
    secondOpinionResidualPx?: number;
  }) => boolean;
  shouldAdoptSecondOpinion: (args: {
    cursorVerified: boolean;
    wokenResidual: number;
    initialResidual: number;
  }) => boolean;

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
      case 'verify':
        return this.locateVerify(hint);
      case 'curve':
        return this.locateCurve(frame, w, h, opts?.minPresence);
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
        // wiggle rejected the ML detection → fall through to shape detect.
      }

      // Heuristic shape fallback: dark AND bright, competed by score desc.
      const dark = d.findCursorByShape(shot.rgb, shot.width, shot.height, {
        expectedNear: predicted,
        expectedNearRadius: 100,
      });
      const bright = d.findCursorByShape(shot.rgb, shot.width, shot.height, {
        expectedNear: predicted,
        expectedNearRadius: 100,
        brightThreshold: 120,
      });

      type Candidate = { pos: { x: number; y: number }; score: number };
      const candidates: Candidate[] = [];
      const proxOf = (p: { x: number; y: number }): number =>
        Math.hypot(p.x - predicted.x, p.y - predicted.y);
      if (dark) {
        const pos = { x: Math.round(dark.centroidX), y: Math.round(dark.centroidY) };
        const prox = proxOf(pos);
        if (dark.shapeScore >= 0.05 || prox <= 30) {
          candidates.push({ pos, score: dark.shapeScore });
        }
      }
      if (bright) {
        const pos = { x: Math.round(bright.centroidX), y: Math.round(bright.centroidY) };
        const prox = proxOf(pos);
        const sameAsDark = candidates.some(
          (c) => Math.hypot(c.pos.x - pos.x, c.pos.y - pos.y) <= 5,
        );
        if (!sameAsDark && (bright.shapeScore >= 0.05 || prox <= 30)) {
          candidates.push({ pos, score: bright.shapeScore });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates) {
        const wiggleVerified = await d.wiggleVerifyCandidate(c.pos, c.score);
        if (wiggleVerified) {
          return {
            position: { x: wiggleVerified.pos.x, y: wiggleVerified.pos.y },
            source: 'shape',
            rawScore: c.score,
            confidence: null,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** click-verify.ts second-opinion (~809): template match arbitrated by
   *  shouldFireSecondOpinion / shouldAdoptSecondOpinion → V8 full-frame fallback.
   *
   *  As a fresh detection front-door the locator has no prior mover fix, so the
   *  arbiters are seeded with cursorVerified=false / initialResidual=Infinity
   *  ("nothing found yet"): the template opinion fires whenever templates exist
   *  and is adopted when found — exactly the not-yet-verified branch of the
   *  current loop. Phase 3 threads the loop's real state in if it needs to. */
  private async locateVerify(hint?: { x: number; y: number }): Promise<CursorFix | null> {
    if (!hint) {
      throw new Error("cursor-locator: 'verify' profile requires a hint (the click target)");
    }
    const d = this.deps;
    const target = hint;
    const SECOND_OPINION_RESIDUAL_PX = 25;
    const cursorVerified = false;
    const initialResidual = Infinity;

    const templates = await d.getCachedTemplates();

    if (
      d.shouldFireSecondOpinion({
        hasTemplates: templates.length > 0,
        cursorVerified,
        initialResidual,
        secondOpinionResidualPx: SECOND_OPINION_RESIDUAL_PX,
      })
    ) {
      try {
        await d.mouseMoveRelative(1, 0);
        await d.sleep(50);
        await d.mouseMoveRelative(-1, 0);
        await d.sleep(80);
        const wakeShot = await d.screenshot();
        const woken = d.findCursorByTemplateSet(wakeShot, templates, {
          minScore: 0.7,
          expectedNear: target,
          expectedNearRadius: 200,
        });
        if (woken) {
          const wokenResidual = Math.hypot(
            woken.position.x - target.x,
            woken.position.y - target.y,
          );
          if (d.shouldAdoptSecondOpinion({ cursorVerified, wokenResidual, initialResidual })) {
            return {
              position: { x: woken.position.x, y: woken.position.y },
              source: 'template',
              rawScore: woken.score,
              confidence: null,
            };
          }
        }
      } catch {
        // Fall through to the V8 fallback, as the current code does.
      }
    }

    // V8 full-frame recovery (fresh frame, minPresence 0.5, heatmapPeak >= 0.3).
    const shot = await d.screenshot();
    const v8 = await d.findCursorByV8FullFrame(shot.buffer, shot.width, shot.height, {
      minPresence: 0.5,
    });
    if (v8 !== null && v8.heatmapPeak >= 0.3) {
      return {
        position: { x: v8.x, y: v8.y },
        source: 'cascade',
        rawScore: v8.presence,
        confidence: v8.presence,
      };
    }
    return null;
  }

  /** curve-mover.ts detect(): V8 full-frame on the given frame. curve-mover's
   *  detect() is parameterised by minPresence (caller-overridable via moveToPixel →
   *  moveByCurveOneShot); the caller threads it so the reroute stays byte-identical.
   *  Defaults to CURVE_MIN_PRESENCE (0.5) when omitted. */
  private async locateCurve(
    frame: Buffer,
    w: number,
    h: number,
    minPresence: number = CURVE_MIN_PRESENCE,
  ): Promise<CursorFix | null> {
    const v8 = await this.deps.findCursorByV8FullFrame(frame, w, h, {
      minPresence,
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
