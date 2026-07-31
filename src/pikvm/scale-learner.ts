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
 * The whole thing is a fail-safe: unwritable state → learn in-memory; disabled (MCP
 * tool or PIKVM_MOVER_LEARN=0 env kill-switch) → freeze at the current value; any
 * garbage sample (faded-cursor-wake start, forced click, abort, low-confidence
 * detection, correction shot) → rejected before it can move the scale.
 */
import { DEFAULT_CURVE_SCALE_Y } from './curve-mover.js';

export type Axis = 'x' | 'y';

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
export const CLAMP_LO = 0.85, CLAMP_HI = 1.15; // absolute sanity clamp on the applied scale
export const RATE_LIMIT = 0.02;                // ≤2% movement per update
export const DIVERGENCE_WARN = 0.02;           // >2% from default → "re-measure/re-bake" warning
export const INTERCEPT_ALARM_PX = 10;          // sustained constant offset ⇒ detector/pacing fault, not geometry
export const REJECT_RATE_ALARM = 0.5;          // reject-rate spike ⇒ detector degraded

const DEFAULTS: Record<Axis, number> = { x: 1.0, y: DEFAULT_CURVE_SCALE_Y };

const median = (a: number[]): number => {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

export type RecordOutcome =
  | 'accepted' | 'accepted-updated'
  | 'rejected-hygiene' | 'rejected-gate' | 'rejected-prefilter' | 'rejected-disabled';

interface Sample { implied: number; planned: number; sigma: number; residual: number }

interface AxisState {
  applied: number;
  window: Sample[];
  seen: number; accepted: number; rejected: number;
  recentRejects: number; recentSeen: number; // rolling reject-rate signal
  lastUpdate: number | null;
}

export interface AxisStatus {
  applied: number;
  shippedDefault: number;
  divergenceFromDefault: number;   // (applied-default)/default
  seen: number; accepted: number; rejected: number;
  windowSize: number;
  windowSE: number | null;         // 1.25·median(σ_i)/√N, null until enough samples
  lastUpdate: number | null;
  slope: number | null;            // residual-vs-planned fit
  intercept: number | null;
  warnings: string[];
}

export interface LearnerStatus {
  enabled: boolean;
  killSwitch: boolean;             // PIKVM_MOVER_LEARN=0
  x: AxisStatus;
  y: AxisStatus;
}

export interface ScaleLearnerOpts {
  now?: () => number;
  /** override the env read (tests). undefined ⇒ read process.env.PIKVM_MOVER_LEARN. */
  killSwitch?: boolean;
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
  private killSwitch: boolean;
  private enabledFlag = true;
  private dirty = false; // an applied scale changed since the last persist
  private readonly st: Record<Axis, AxisState>;

  constructor(opts: ScaleLearnerOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.killSwitch = opts.killSwitch ?? (process.env.PIKVM_MOVER_LEARN === '0');
    this.st = {
      x: this.freshAxis('x'),
      y: this.freshAxis('y'),
    };
  }

  private freshAxis(a: Axis): AxisState {
    return { applied: DEFAULTS[a], window: [], seen: 0, accepted: 0, rejected: 0, recentRejects: 0, recentSeen: 0, lastUpdate: null };
  }

  /** Is the learner adapting? False when disabled by tool OR the env kill-switch. */
  isActive(): boolean { return this.enabledFlag && !this.killSwitch; }

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
    s.seen++; s.recentSeen++;
    const bumpReject = (): void => { s.rejected++; s.recentRejects++; this.decayRecent(s); };

    if (meta.woken || meta.forced || meta.aborted || meta.lowConfidence || meta.isCorrectionShot
        || !Number.isFinite(planned) || !Number.isFinite(achieved) || Math.abs(planned) < 1) {
      bumpReject(); return 'rejected-hygiene';
    }
    if (Math.abs(planned) < MIN_PLANNED_PX) { bumpReject(); return 'rejected-gate'; }

    const implied = sApplied * (achieved / planned);
    if (!(implied >= PREFILTER_LO && implied <= PREFILTER_HI)) { bumpReject(); return 'rejected-prefilter'; }

    s.accepted++; this.decayRecent(s);
    const sigma = (SIGMA_DETECT_PX * Math.SQRT2) / Math.abs(planned);
    s.window.push({ implied, planned: Math.abs(planned), sigma, residual: achieved - planned });
    if (s.window.length > WINDOW_MAX) s.window.shift();

    const se = this.windowSE(s);
    if (se !== null && se < SE_APPLY_THRESHOLD) {
      const target = Math.max(CLAMP_LO, Math.min(CLAMP_HI, median(s.window.map((w) => w.implied))));
      const step = Math.max(-RATE_LIMIT * s.applied, Math.min(RATE_LIMIT * s.applied, target - s.applied));
      if (step !== 0) { s.applied += step; s.lastUpdate = this.now(); this.dirty = true; return 'accepted-updated'; }
    }
    return 'accepted';
  }

  private decayRecent(s: AxisState): void {
    // simple rolling window on the reject-rate signal so a burst shows, then fades.
    if (s.recentSeen > WINDOW_MAX) { s.recentSeen = Math.round(s.recentSeen * 0.7); s.recentRejects = Math.round(s.recentRejects * 0.7); }
  }

  private windowSE(s: AxisState): number | null {
    const n = s.window.length;
    if (n < 5) return null;
    return (1.25 * median(s.window.map((w) => w.sigma))) / Math.sqrt(n);
  }

  private axisStatus(a: Axis): AxisStatus {
    const s = this.st[a];
    const fit = fitResidual(s.window);
    const divergence = (s.applied - DEFAULTS[a]) / DEFAULTS[a];
    const warnings: string[] = [];
    if (fit && Math.abs(fit.intercept) > INTERCEPT_ALARM_PX) {
      warnings.push(`constant ${fit.intercept.toFixed(1)}px landing offset (NOT a scale drift) — detector/pacing fault, re-check the detector`);
    }
    if (s.recentSeen >= 10 && s.recentRejects / s.recentSeen > REJECT_RATE_ALARM) {
      warnings.push(`reject-rate ${(s.recentRejects / s.recentSeen * 100).toFixed(0)}% — detector likely degraded`);
    }
    if (Math.abs(divergence) > DIVERGENCE_WARN) {
      warnings.push(`scale ${(divergence * 100).toFixed(1)}% from shipped default — consider re-measuring + re-baking DEFAULT_CURVE_SCALE_${a.toUpperCase()}`);
    }
    return {
      applied: s.applied, shippedDefault: DEFAULTS[a], divergenceFromDefault: divergence,
      seen: s.seen, accepted: s.accepted, rejected: s.rejected, windowSize: s.window.length,
      windowSE: this.windowSE(s), lastUpdate: s.lastUpdate,
      slope: fit?.slope ?? null, intercept: fit?.intercept ?? null, warnings,
    };
  }

  status(): LearnerStatus {
    return { enabled: this.enabledFlag, killSwitch: this.killSwitch, x: this.axisStatus('x'), y: this.axisStatus('y') };
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

  /** Load a persisted snapshot (applied scales + counters). Clamped on the way in so
   *  a corrupt file can't inject an out-of-band scale. */
  loadSnapshot(snap: Partial<Record<Axis, { applied: number; accepted?: number; lastUpdate?: number | null }>>): void {
    for (const a of ['x', 'y'] as const) {
      const v = snap[a];
      if (v && Number.isFinite(v.applied)) {
        this.st[a].applied = Math.max(CLAMP_LO, Math.min(CLAMP_HI, v.applied));
        if (v.accepted) this.st[a].accepted = v.accepted;
        if (v.lastUpdate !== undefined) this.st[a].lastUpdate = v.lastUpdate;
      }
    }
  }

  /** The snapshot to persist (scales + provenance counters). */
  snapshot(): Record<Axis, { applied: number; accepted: number; lastUpdate: number | null }> {
    return {
      x: { applied: this.st.x.applied, accepted: this.st.x.accepted, lastUpdate: this.st.x.lastUpdate },
      y: { applied: this.st.y.applied, accepted: this.st.y.accepted, lastUpdate: this.st.y.lastUpdate },
    };
  }
}

/** Process-wide singleton the mover reads and records into. */
export const scaleLearner = new ScaleLearner();
