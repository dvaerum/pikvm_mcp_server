/**
 * Passive continuous curve-scale learner (task #41).
 *
 * Every real first-shot move yields a FREE per-axis sample from the detector the
 * mover already runs: planned P (target−start) vs achieved A (landed−start). The
 * implied scale is  s = sApplied × (A / P)  (an overshoot A>P needs a LARGER scale,
 * because scale DIVIDES the requested distance in planAxisEmits). Real moves are
 * paced bursts, so samples sit in the correct velocity regime by construction — the
 * isolated-ratio trap (phase-0) cannot occur here. The learner accumulates these and
 * adapts curveScaleX/Y gradually, warm-started from the shipped defaults.
 *
 * Estimator + guard parameters are validated in scratch/yscale-estimator-sim.ts.
 * Design signed off by georg 2026-07-31. maxResidualPx and the mover's own math are
 * untouched; this only chooses the per-axis scale the mover applies.
 *
 * ⚠️ EXPERIMENTAL, OFF BY DEFAULT (georg's #41 decision, 2026-07-31). On the real iPad
 * rig the auto-adaptation did NOT beat a one-time human measurement: the median
 * estimator is ~1% biased low (a constant along-travel offset c biases implied=s+c/P),
 * and the unbiased regression-slope estimator WANDERS ±2-3% because the rig's traffic
 * gives each axis only two distinct |planned| values, so the two-cluster slope is
 * noisy and the rate cap converts that noise directly into applied-value wander (it
 * caps, it does not average). So we ship the STABLE median, tightly CLAMPED to ±1% of
 * the shipped default so even when enabled it cannot materially hurt — but the feature
 * is OPT-IN only (PIKVM_MOVER_LEARN=1). When off (the default) the learner is inert,
 * the 3 pikvm_mover_scale_* tools are not registered, and the mover uses the static
 * shipped DEFAULT_CURVE_SCALE_Y exactly as before — a true no-op. The drift DETECTION
 * (divergence / detector-fault warnings) is the more reliable half; it ships coupled to
 * the feature (also off by default). The two changes that WOULD make adaptation
 * converge — an EMA/damping on the applied value, and a distance-diversity gate so a
 * two-cluster window can't drive a fit — are the documented path IF anyone revisits it.
 *
 * The whole thing is a fail-safe: unwritable state → learn in-memory; not opted in, or
 * disabled mid-session (MCP tool) → freeze at the shipped default; any garbage sample
 * (faded-cursor-wake start, forced click, abort, low-confidence detection, correction
 * shot) → rejected before it can move the scale.
 */
import { DEFAULT_CURVE_SCALE_Y } from './curve-mover.js';
import type { MoveLearnSample } from './move-to.js';

export type Axis = 'x' | 'y';

/** The 3 experimental control tools index.ts registers ONLY when opted in (#41). */
export const MOVER_SCALE_TOOL_NAMES = [
  'pikvm_mover_scale_status', 'pikvm_mover_scale_control', 'pikvm_mover_scale_reset',
] as const;
export type MoverScaleToolName = (typeof MOVER_SCALE_TOOL_NAMES)[number];

/** Per-move provenance so garbage never trains the scale. A sample is learned ONLY
 *  when all of these are false/absent. */
export interface SampleMeta {
  /** start came from the M2 faded-cursor wake (jiggled position, not a clean rest). */
  woken?: boolean;
  /** click was force:true (unverified landing). */
  forced?: boolean;
  /** move was skipped/aborted (gate, brightness, not-landed). */
  aborted?: boolean;
  /** detection confidence below the learn bar. */
  lowConfidence?: boolean;
  /** this is the correction shot, not the first shot (starts elsewhere → pollutes). */
  isCorrectionShot?: boolean;
}

// ── validated constants (scratch/yscale-estimator-sim.ts) ───────────────────────
export const SIGMA_DETECT_PX = 5.1;            // measured landing noise per endpoint (georgs n=79)
export const MIN_PLANNED_PX = 150;             // accept floor; below this σ_i/P is noise not signal
export const WINDOW_MAX = 70;                  // keep the most recent N samples
export const SE_APPLY_THRESHOLD = 0.005;       // apply an update only when window SE < 0.5%
export const PREFILTER_LO = 0.7, PREFILTER_HI = 1.4;   // reject implied scales outside (kills gross FPs)
// The applied scale is clamped to ±1% of the SHIPPED DEFAULT (per-axis), not an absolute
// band. This is the experimental-safety bound (georg's #41 decision): even opted-in, the
// learner cannot move the mover more than 1% off the hand-measured value, so its known
// ~1% median bias / wander can't materially hurt. Tighter than the estimator's own noise
// by design — we trust the shipped default more than the loop.
export const CLAMP_FRACTION = 0.01;
export const RATE_LIMIT = 0.02;                // ≤2% movement per update
// Require a BALANCED ±direction mix before an update. The implied scale is direction-
// dependent (measured: up 3.72% vs down 3.14% overshoot), so the window MEDIAN is only
// an accurate estimate of the compromise-optimum once BOTH directions are represented.
// The SE gate alone is optimistic here — it measures random-noise precision of the
// median, not whether the window is REPRESENTATIVE — so a direction-skewed small window
// passes SE<0.5% yet the median is biased (sim-confirmed: σ-model SE 0.48% at ~0.8-1.1%
// true error; requiring ≥8/direction cuts the first-update error to ~0.14%). This is the
// fix that works — an empirical-MAD gate fires EARLIER/worse, since MAD of a tiny window
// is tiny.
export const MIN_SAMPLES_PER_DIRECTION = 8;
export const DIVERGENCE_WARN = 0.02;           // >2% from default → "re-measure/re-bake" warning
export const INTERCEPT_ALARM_PX = 10;          // sustained constant offset ⇒ detector/pacing fault, not geometry
export const REJECT_RATE_ALARM = 0.5;          // reject-rate spike ⇒ detector degraded

const DEFAULTS: Record<Axis, number> = { x: 1.0, y: DEFAULT_CURVE_SCALE_Y };

/** Clamp a scale to ±CLAMP_FRACTION of THIS axis's shipped default. */
const clampToBand = (axis: Axis, v: number): number => {
  const d = DEFAULTS[axis];
  return Math.max(d * (1 - CLAMP_FRACTION), Math.min(d * (1 + CLAMP_FRACTION), v));
};

const median = (a: number[]): number => {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

export type RecordOutcome =
  | 'accepted' | 'accepted-updated'
  | 'rejected-hygiene' | 'rejected-gate' | 'rejected-prefilter' | 'rejected-disabled';

interface Sample { implied: number; planned: number; sigma: number; residual: number; sign: number }

interface AxisState {
  applied: number;
  window: Sample[];
  seen: number; accepted: number; rejected: number;
  // Detector-degraded signal: the reject rate AMONG QUALIFIED samples (those that
  // passed hygiene + the ≥150px gate and reached the pre-filter). A sub-floor move
  // (rejected-gate) is EXPECTED normal traffic — on WB pad ~50% of moves are under
  // the floor — so it must NOT count here, or the alarm fires permanently.
  recentQualified: number; recentPrefilterRejects: number;
  lastUpdate: number | null;
}

export interface AxisStatus {
  applied: number;
  estimatedScale: number | null;   // window-median implied scale (UNCLAMPED drift read); null until ≥5 samples
  shippedDefault: number;
  divergenceFromDefault: number;   // (estimate-default)/default — the drift signal, not the clamped applied
  seen: number; accepted: number; rejected: number;
  windowSize: number;
  windowBalance: { up: number; down: number }; // ±direction counts — an update needs ≥8 each
  windowSE: number | null;         // 1.25·median(σ_i)/√N, null until enough samples
  lastUpdate: number | null;
  slope: number | null;            // residual-vs-planned fit
  intercept: number | null;
  warnings: string[];
}

export interface LearnerStatus {
  experimental: true;              // #41: off-by-default opt-in; does not reliably converge
  featureEnabled: boolean;         // opted in via PIKVM_MOVER_LEARN=1 (else the whole feature is inert)
  active: boolean;                 // featureEnabled AND not frozen by the control tool
  // Human-readable so a reader can tell DISABLED apart from merely IDLE — a frozen learner
  // and a learner with nothing to learn from both sit at warm-start defaults with 0 samples,
  // which otherwise look identical (it-03400 / georgs, 2026-07-31).
  state: 'disabled' | 'idle (no qualifying samples yet)' | 'learning';
  x: AxisStatus;
  y: AxisStatus;
}

export interface ScaleLearnerOpts {
  now?: () => number;
  /** Override the env opt-in (tests). undefined ⇒ the feature is ON only when
   *  process.env.PIKVM_MOVER_LEARN === '1' (OFF by default — georg's #41 decision). */
  enabled?: boolean;
}

/** Least-squares slope+intercept of residual (achieved−planned) vs planned, over the
 *  window — the geometry-drift (slope) vs detector-fault (intercept) discriminator. */
function fitResidual(win: Sample[]): { slope: number; intercept: number } | null {
  if (win.length < 5) return null;
  const n = win.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of win) { sx += s.planned; sy += s.residual; sxx += s.planned * s.planned; sxy += s.planned * s.residual; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

export class ScaleLearner {
  private readonly now: () => number;
  // OPT-IN gate (immutable per process): the experimental feature is OFF unless
  // PIKVM_MOVER_LEARN=1. When false the learner is inert AND index.ts does not register
  // the 3 pikvm_mover_scale_* tools — a true no-op.
  private readonly envEnabled: boolean;
  private enabledFlag = true; // runtime freeze via the control tool (only meaningful when opted in)
  private dirty = false; // an applied scale changed since the last persist
  private readonly st: Record<Axis, AxisState>;

  constructor(opts: ScaleLearnerOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.envEnabled = opts.enabled ?? (process.env.PIKVM_MOVER_LEARN === '1');
    this.st = {
      x: this.freshAxis('x'),
      y: this.freshAxis('y'),
    };
  }

  private freshAxis(a: Axis): AxisState {
    return { applied: DEFAULTS[a], window: [], seen: 0, accepted: 0, rejected: 0, recentQualified: 0, recentPrefilterRejects: 0, lastUpdate: null };
  }

  /** Is the learner adapting? True only when opted in (env) AND not frozen by the tool. */
  isActive(): boolean { return this.envEnabled && this.enabledFlag; }

  /** Did the process opt into the experimental feature (PIKVM_MOVER_LEARN=1)? index.ts
   *  gates registration of the 3 pikvm_mover_scale_* tools on this — off ⇒ they vanish. */
  isFeatureEnabled(): boolean { return this.envEnabled; }

  /** The scale the mover should apply for this axis right now. Always defined,
   *  warm-started from the shipped default, never outside the clamp. */
  currentScale(axis: Axis): number { return this.st[axis].applied; }

  /**
   * Record one first-shot move sample. Returns the outcome (for status/tests).
   * Hygiene → gate(|planned|≥150) → implied → pre-filter → window → SE-gated update.
   */
  recordSample(axis: Axis, planned: number, achieved: number, sApplied: number, meta: SampleMeta = {}): RecordOutcome {
    const s = this.st[axis];
    // The kill-switch/disable FREEZES: we don't even count samples we won't learn from,
    // so status counters reflect real learning traffic, not frozen no-ops.
    if (!this.isActive()) return 'rejected-disabled';
    s.seen++;

    // Hygiene + the distance gate reject BEFORE the sample is "qualified": these are
    // expected traffic, NOT a detector-degraded signal, so they only bump `rejected`.
    if (meta.woken || meta.forced || meta.aborted || meta.lowConfidence || meta.isCorrectionShot
        || !Number.isFinite(planned) || !Number.isFinite(achieved) || Math.abs(planned) < 1) {
      s.rejected++; return 'rejected-hygiene';
    }
    if (Math.abs(planned) < MIN_PLANNED_PX) { s.rejected++; return 'rejected-gate'; }

    // A QUALIFIED sample (passed hygiene + gate, reached the pre-filter). Only here on
    // does a rejection signal a lying detector (a ≥150px move whose implied scale is
    // physically impossible = a gross V8 false-positive).
    s.recentQualified++;
    const implied = sApplied * (achieved / planned);
    if (!(implied >= PREFILTER_LO && implied <= PREFILTER_HI)) {
      s.rejected++; s.recentPrefilterRejects++; this.decayRecent(s); return 'rejected-prefilter';
    }

    s.accepted++; this.decayRecent(s);
    const sigma = (SIGMA_DETECT_PX * Math.SQRT2) / Math.abs(planned);
    // DIRECTION-NORMALISED residual: real traffic clusters at ±P (moves go back and
    // forth), so a signed residual-vs-signed-planned fit is degenerate — direction
    // asymmetry (down 3.14% vs up 3.72%) leaks into slope, noise into intercept. We
    // store the along-travel overshoot (residual · sign(planned)) against |planned|,
    // collapsing both clusters onto one line: a true SCALE error is the slope, a true
    // constant OFFSET is the intercept, and up/down asymmetry becomes spread — not a
    // false intercept.
    const sign = Math.sign(planned);
    const alongTravelResidual = (achieved - planned) * sign;
    s.window.push({ implied, planned: Math.abs(planned), sigma, residual: alongTravelResidual, sign });
    if (s.window.length > WINDOW_MAX) s.window.shift();

    // Update only when the estimate is precise enough (SE gate) AND the window is
    // representative (a balanced ±direction mix). The TARGET is the window MEDIAN of the
    // implied scale — the STABLE estimator. We deliberately do NOT use the (unbiased)
    // regression slope: on the real rig each axis sees only two distinct |planned|
    // values, so the two-cluster slope is noisy and the rate cap (which caps, not
    // averages) turns that noise into ±2-3% applied-value wander — measured worse than
    // the median's ~1% bias. Biased-but-stable beats unbiased-but-noisy for an opt-in.
    // The ±1% clamp bounds the median's residual bias so it cannot materially hurt.
    const se = this.windowSE(s);
    if (se !== null && se < SE_APPLY_THRESHOLD && this.directionBalanced(s)) {
      const target = clampToBand(axis, median(s.window.map((w) => w.implied)));
      const step = Math.max(-RATE_LIMIT * s.applied, Math.min(RATE_LIMIT * s.applied, target - s.applied));
      if (step !== 0) { s.applied += step; s.lastUpdate = this.now(); this.dirty = true; return 'accepted-updated'; }
    }
    return 'accepted';
  }

  private decayRecent(s: AxisState): void {
    // rolling decay on the qualified-sample reject-rate signal so a burst shows, then fades.
    if (s.recentQualified > WINDOW_MAX) { s.recentQualified = Math.round(s.recentQualified * 0.7); s.recentPrefilterRejects = Math.round(s.recentPrefilterRejects * 0.7); }
  }

  /** Both directions represented ≥ MIN_SAMPLES_PER_DIRECTION — the window is a fair
   *  sample of the direction-dependent implied scale, so its median isn't skewed. */
  private directionBalanced(s: AxisState): boolean {
    const up = s.window.reduce((c, w) => c + (w.sign > 0 ? 1 : 0), 0);
    return Math.min(up, s.window.length - up) >= MIN_SAMPLES_PER_DIRECTION;
  }

  private windowSE(s: AxisState): number | null {
    const n = s.window.length;
    if (n < 5) return null;
    return (1.25 * median(s.window.map((w) => w.sigma))) / Math.sqrt(n);
  }

  private axisStatus(a: Axis): AxisStatus {
    const s = this.st[a];
    const fit = fitResidual(s.window);
    // The drift signal is the UNCLAMPED estimate vs the default, NOT the applied value:
    // applied is bounded to ±1% by the clamp, so a divergence read off `applied` could
    // never report a drift bigger than the clamp — it would silence the very "re-measure"
    // signal this warning exists for. The window median (the estimator we ship) is the
    // honest read of where the true scale sits.
    const estimate = s.window.length >= 5 ? median(s.window.map((w) => w.implied)) : null;
    const divergence = ((estimate ?? s.applied) - DEFAULTS[a]) / DEFAULTS[a];
    const warnings: string[] = [];
    if (fit && Math.abs(fit.intercept) > INTERCEPT_ALARM_PX) {
      warnings.push(`constant ${fit.intercept.toFixed(1)}px landing offset (NOT a scale drift) — detector/pacing fault, re-check the detector`);
    }
    if (s.recentQualified >= 10 && s.recentPrefilterRejects / s.recentQualified > REJECT_RATE_ALARM) {
      warnings.push(`${(s.recentPrefilterRejects / s.recentQualified * 100).toFixed(0)}% of QUALIFIED (≥150px) moves rejected as physically-impossible — detector likely degraded`);
    }
    if (Math.abs(divergence) > DIVERGENCE_WARN) {
      warnings.push(`estimated scale ${(divergence * 100).toFixed(1)}% from shipped default — consider re-measuring + re-baking DEFAULT_CURVE_SCALE_${a.toUpperCase()}`);
    }
    return {
      applied: s.applied, estimatedScale: estimate, shippedDefault: DEFAULTS[a], divergenceFromDefault: divergence,
      seen: s.seen, accepted: s.accepted, rejected: s.rejected, windowSize: s.window.length,
      windowBalance: { up: s.window.reduce((c, w) => c + (w.sign > 0 ? 1 : 0), 0), down: s.window.reduce((c, w) => c + (w.sign < 0 ? 1 : 0), 0) },
      windowSE: this.windowSE(s), lastUpdate: s.lastUpdate,
      slope: fit?.slope ?? null, intercept: fit?.intercept ?? null, warnings,
    };
  }

  status(): LearnerStatus {
    const state: LearnerStatus['state'] = !this.isActive()
      ? 'disabled'
      : (this.st.x.accepted + this.st.y.accepted === 0 ? 'idle (no qualifying samples yet)' : 'learning');
    return { experimental: true, featureEnabled: this.envEnabled, active: this.isActive(), state, x: this.axisStatus('x'), y: this.axisStatus('y') };
  }

  /** Freeze at the current value: stop adapting AND stop persisting (the persistence
   *  layer checks isActive()). Does NOT revert the applied scale. */
  disable(): void { this.enabledFlag = false; }
  enable(): void { this.enabledFlag = true; }

  /** True and CLEARED when an applied scale changed since the last persist — the
   *  periodic flush uses this so it only writes when there's something to write
   *  (never per-move). disable()d/kill-switched learners are never dirty. */
  consumeDirty(): boolean { const d = this.dirty; this.dirty = false; return d; }

  /** Clear learned state and revert to shipped defaults. The persistence layer, on
   *  seeing a reset, DELETES the file (not just zeroes memory). */
  reset(): void { this.st.x = this.freshAxis('x'); this.st.y = this.freshAxis('y'); this.dirty = false; }

  /** Restore ONLY the learned applied scale (clamped, so a corrupt file can't inject
   *  an out-of-band value) + when it was last learned. Counters (seen/accepted/
   *  rejected) are deliberately SESSION-SCOPED — persisting a cumulative `accepted`
   *  alongside a session-zero `seen` made the status readout report accepted>seen,
   *  and "samples this session" is the more useful diagnostic than a cumulative count
   *  with no consumer (georgs, 2026-07-31). So a fresh process always starts the
   *  counters at 0, consistent with each other. */
  loadSnapshot(snap: Partial<Record<Axis, { applied: number; lastUpdate?: number | null }>>): void {
    for (const a of ['x', 'y'] as const) {
      const v = snap[a];
      if (v && Number.isFinite(v.applied)) {
        this.st[a].applied = clampToBand(a, v.applied);
        if (v.lastUpdate !== undefined) this.st[a].lastUpdate = v.lastUpdate;
      }
    }
  }

  /** The snapshot to persist: only the learned scale + when it was learned. NOT the
   *  counters (see loadSnapshot). */
  snapshot(): Record<Axis, { applied: number; lastUpdate: number | null }> {
    return {
      x: { applied: this.st.x.applied, lastUpdate: this.st.x.lastUpdate },
      y: { applied: this.st.y.applied, lastUpdate: this.st.y.lastUpdate },
    };
  }
}

/** Process-wide singleton the mover reads and records into. */
export const scaleLearner = new ScaleLearner();

/**
 * F2 (Round 2 Phase 2): the one recordMoveSample — previously duplicated
 * verbatim in index.ts's move_to handler and click-at.ts's clickAt(), both
 * reaching directly into the module-singleton `scaleLearner`. Takes the
 * learner as a param instead (not the singleton directly) so this stays
 * unit-testable without a process-wide global — pass `scaleLearner` at the
 * real call sites, a fresh `new ScaleLearner()` in tests.
 *
 * (#41) feeds a completed curve-one-shot's free first-shot sample to the
 * passive scale learner. The learner's own hygiene rejects a
 * faded-cursor-wake start or a forced click; its pre-filter + median absorb
 * the rest. No-op when the mover produced no sample (start or first
 * landing undetected → learnSample null).
 */
export function recordMoveSample(
  learner: ScaleLearner,
  result: { learnSample?: MoveLearnSample | null },
  appliedX: number,
  appliedY: number,
  forced: boolean,
): void {
  const ls = result.learnSample;
  if (!ls) return;
  const meta = { woken: ls.woken, forced };
  learner.recordSample('x', ls.plannedX, ls.achievedX, appliedX, meta);
  learner.recordSample('y', ls.plannedY, ls.achievedY, appliedY, meta);
}
