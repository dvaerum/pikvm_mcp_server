/**
 * Screen brightness analysis for cursor-detection diagnostics.
 *
 * iPadOS auto-dims the display after inactivity. On a dim frame, cursor
 * pixels can fall below the cursor-detection brightness floor (100), which
 * makes every locateCursor probe fail. Surfacing the average brightness in
 * pikvm_health_check (and elsewhere) lets the operator notice this BEFORE
 * wasting retry attempts.
 *
 * Pure functions live here so tests can pin the threshold logic without
 * spinning up the MCP handler. The handler (src/index.ts) wires this into
 * the health-check report.
 *
 * Phase 37 (v0.5.22, 2026-04-26).
 */

import sharp from 'sharp';

export interface BrightnessReport {
  /** Mean of (channel-mean-R + channel-mean-G + channel-mean-B) / 3, in
   *  [0, 255]. Approximates luminance without paying for a colourspace
   *  conversion. */
  mean: number;
  meanR: number;
  meanG: number;
  meanB: number;
  /** Mean of per-channel stddev across R,G,B. High stddev means the frame
   *  has BOTH bright and dark pixels (cursor will be detectable against the
   *  contrast). Low stddev means uniform brightness — either uniform bright
   *  (cursor faint against bright bg) or uniform dark (cursor faint against
   *  dark bg). Phase 48: stddev is a better gate than mean for dark-mode UI,
   *  where mean is low (~20) but UI text/icons provide enough contrast for
   *  cursor detection. */
  stddev: number;
  /** Severity bucket. */
  severity: 'normal' | 'dim' | 'very-dim';
  /** Operator-facing one-liner with recovery guidance. Empty string when
   *  severity is 'normal'. */
  hint: string;
}

/**
 * Phase 48 (v0.5.36, 2026-04-26): switch from mean-based to stddev-based
 * gating because dark-mode iPad apps (Settings, Files in dark mode, etc.)
 * legitimately have low mean (~20/255) but are NOT a problem for cursor
 * detection — the cursor pixels (~150-200) contrast against the dark
 * background, producing high local stddev and clear motion-diff clusters.
 *
 * Calibration data points (2026-04-26, iPad-content region only):
 *  - mean=20, stddev<2:  Settings dark mode (cursor detectable, gate
 *    should NOT fire — but mean<35 fired Phase 38 false-positively).
 *  - mean=29, stddev<2:  hidden security popup with darkening overlay
 *    (cursor detection broken — gate SHOULD fire).
 *  - mean=41, stddev>5:  bright home screen with dark wallpaper (cursor
 *    detectable, gate should NOT fire).
 *
 * The discriminator is stddev, NOT mean. Low stddev = uniform low-contrast
 * surface = cursor blends in. The popup overlay creates uniform darkening
 * across the iPad bounds; dark-mode apps preserve UI text/icon contrast.
 *
 * Pre-Phase-48 thresholds were on `mean`. Now we additionally gate on
 * `stddev`: only flag VERY DIM if BOTH mean < VERY_DIM_THRESHOLD AND
 * stddev < MIN_STDDEV_FOR_CONTRAST. That allows dark-mode UI through.
 */
export const VERY_DIM_THRESHOLD = 35;
/** Threshold below which cursor detection is intermittently unreliable. */
export const DIM_THRESHOLD = 60;
/** Minimum stddev (mean across RGB channels) for the frame to be considered
 *  to have enough internal contrast for cursor detection. Below this, the
 *  frame is uniform — either uniform bright or uniform dark — and the
 *  cursor cluster won't separate from the background. Calibrated against
 *  Phase 48 live data points (popup overlay at stddev<2; dark-mode UI at
 *  stddev>5). */
export const MIN_STDDEV_FOR_CONTRAST = 3;

/**
 * Bucket the brightness reading into normal / dim / very-dim. Pure
 * function; test inputs directly.
 *
 * Phase 48: takes BOTH mean and stddev. A frame is only flagged as
 * very-dim if mean is low AND stddev is also low (uniform dark surface).
 * Dark-mode UI has low mean but high stddev (text/icon contrast), so
 * passes the gate.
 */
export function classifyBrightness(mean: number, stddev: number = 100): {
  severity: BrightnessReport['severity'];
  hint: string;
} {
  // Phase 48: high contrast (stddev) means cursor is detectable regardless
  // of mean luminance — dark-mode UI passes here.
  if (stddev >= MIN_STDDEV_FOR_CONTRAST && mean < VERY_DIM_THRESHOLD) {
    // Borderline: low mean but contrast present. Soft warning only.
    return {
      severity: 'dim',
      hint:
        ' ⚠ DIM (low mean, but contrast present — likely dark-mode UI). ' +
        'Cursor detection should still work; if it fails, raise concern.',
    };
  }
  if (mean < VERY_DIM_THRESHOLD && stddev < MIN_STDDEV_FOR_CONTRAST) {
    return {
      severity: 'very-dim',
      hint:
        ' ⚠ VERY DIM — uniform dark frame, cursor detection will likely fail. ' +
        'Possible causes: (1) iPad brightness setting too low (Settings → ' +
        'Display & Brightness, turn Auto-Brightness OFF), (2) a security/' +
        'permission popup with a uniform darkening modal overlay. The popup ' +
        'may be off the HDMI capture frame but is STILL INTERACTIVE — try ' +
        'sending Escape via pikvm_key, then Enter, then Cmd+Period via ' +
        'pikvm_shortcut to dismiss it. Look at the iPad screen directly.',
    };
  }
  if (mean < DIM_THRESHOLD) {
    return {
      severity: 'dim',
      hint:
        ' ⚠ DIM — cursor detection may fail intermittently. iPad auto-brightness ' +
        'may be reducing the display, or a partially-transparent overlay may be ' +
        'in front of the screen.',
    };
  }
  return { severity: 'normal', hint: '' };
}

export interface AnalyzeBrightnessOptions {
  /** Restrict the brightness calculation to a region of the frame. Critical
   *  on iPad-portrait deployments where the HDMI frame includes ~67% black
   *  letterbox bars — computing mean over the full frame misclassifies a
   *  fully-bright iPad as VERY DIM (live-verified 2026-04-26: iPad on
   *  bright home screen still reported mean=41/255 over the full 1920×1080
   *  frame because the letterbox dragged the mean down).
   *
   *  Pass the detected iPad bounds here so the report reflects actual
   *  display brightness, not the geometric framing of the capture. */
  region?: { x: number; y: number; width: number; height: number };
}

/**
 * Compute brightness report for a JPEG/PNG buffer. Uses sharp.stats() which
 * is fast (~5 ms on a 1920x1080 frame).
 *
 * When `options.region` is supplied, the calculation is restricted to that
 * rectangle (sharp.extract). Without it, the full frame is analysed.
 */
export async function analyzeBrightness(
  buffer: Buffer,
  options: AnalyzeBrightnessOptions = {},
): Promise<BrightnessReport> {
  const pipeline = options.region
    ? sharp(buffer).extract({
        left: options.region.x,
        top: options.region.y,
        width: options.region.width,
        height: options.region.height,
      })
    : sharp(buffer);
  const stats = await pipeline.stats();
  if (stats.channels.length < 3) {
    throw new Error(`brightness: expected ≥3 channels, got ${stats.channels.length}`);
  }
  const meanR = stats.channels[0].mean;
  const meanG = stats.channels[1].mean;
  const meanB = stats.channels[2].mean;
  const mean = (meanR + meanG + meanB) / 3;
  // Phase 48: stddev across R,G,B. sharp.stats() exposes per-channel stdev.
  const stddev = (stats.channels[0].stdev + stats.channels[1].stdev + stats.channels[2].stdev) / 3;
  const { severity, hint } = classifyBrightness(mean, stddev);
  return { mean, meanR, meanG, meanB, stddev, severity, hint };
}

/** Format a brightness report as a single line for operator output. */
export function formatBrightnessReport(report: BrightnessReport): string {
  return (
    `Screen brightness: mean=${report.mean.toFixed(0)}/255, stddev=${report.stddev.toFixed(1)} ` +
    `(R=${report.meanR.toFixed(0)}, G=${report.meanG.toFixed(0)}, B=${report.meanB.toFixed(0)}).` +
    report.hint
  );
}
