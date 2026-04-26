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
  /** Severity bucket. */
  severity: 'normal' | 'dim' | 'very-dim';
  /** Operator-facing one-liner with recovery guidance. Empty string when
   *  severity is 'normal'. */
  hint: string;
}

/**
 * Threshold below which cursor detection has reliably failed in live tests.
 *
 * Calibration data points (2026-04-26, iPad-content region only — full-frame
 * means are dragged down by ~67% letterbox bars):
 *  - 29/255: hidden security popup with darkening modal overlay → cursor
 *    detection failed every probe.
 *  - 41/255: bright iPad home screen with DARK wallpaper (blue/teal gradient,
 *    mostly low-luminance pixels with a few bright widgets) → cursor
 *    detection works. False-positive at threshold=50.
 *
 * Threshold of 35 separates these two regimes: catches the popup case
 * (29) without flagging dark-wallpaper iPads (41) as unworkable.
 */
export const VERY_DIM_THRESHOLD = 35;
/** Threshold below which cursor detection is intermittently unreliable. */
export const DIM_THRESHOLD = 60;

/**
 * Bucket the brightness mean into normal / dim / very-dim. Pure function;
 * test inputs directly.
 */
export function classifyBrightness(mean: number): {
  severity: BrightnessReport['severity'];
  hint: string;
} {
  if (mean < VERY_DIM_THRESHOLD) {
    return {
      severity: 'very-dim',
      hint:
        ' ⚠ VERY DIM — cursor detection will likely fail. Possible causes: ' +
        '(1) iPad brightness setting too low (Settings → Display & Brightness, ' +
        'turn Auto-Brightness OFF — software wakes do NOT restore brightness), ' +
        '(2) a security/permission popup is open with a darkening modal overlay. ' +
        'The popup may be positioned off the HDMI capture frame (only the dim ' +
        'shadow shows) but is STILL INTERACTIVE — try sending Escape via ' +
        'pikvm_key, then Enter, then Cmd+Period via pikvm_shortcut to dismiss ' +
        'it without needing a visible target. Look at the iPad screen ' +
        'directly to confirm.',
    };
  }
  if (mean < DIM_THRESHOLD) {
    return {
      severity: 'dim',
      hint:
        ' ⚠ DIM — cursor detection may fail intermittently. iPad auto-brightness ' +
        'may be reducing the display, or a partially-transparent overlay may be ' +
        'in front of the home screen.',
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
  const { severity, hint } = classifyBrightness(mean);
  return { mean, meanR, meanG, meanB, severity, hint };
}

/** Format a brightness report as a single line for operator output. */
export function formatBrightnessReport(report: BrightnessReport): string {
  return (
    `Screen brightness: mean=${report.mean.toFixed(0)}/255 ` +
    `(R=${report.meanR.toFixed(0)}, G=${report.meanG.toFixed(0)}, B=${report.meanB.toFixed(0)}).` +
    report.hint
  );
}
