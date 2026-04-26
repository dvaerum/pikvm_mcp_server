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

/** Threshold below which cursor detection has reliably failed in live tests. */
export const VERY_DIM_THRESHOLD = 50;
/** Threshold below which cursor detection is intermittently unreliable. */
export const DIM_THRESHOLD = 80;

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
        ' ⚠ VERY DIM — cursor detection will likely fail. Check iPad brightness setting; ' +
        'wake the screen via pikvm_ipad_unlock or Cmd+H.',
    };
  }
  if (mean < DIM_THRESHOLD) {
    return {
      severity: 'dim',
      hint:
        ' ⚠ DIM — cursor detection may fail intermittently. iPad auto-brightness ' +
        'may be reducing the display.',
    };
  }
  return { severity: 'normal', hint: '' };
}

/**
 * Compute brightness report for a JPEG/PNG buffer. Uses sharp.stats() which
 * is fast (~5 ms on a 1920x1080 frame).
 */
export async function analyzeBrightness(buffer: Buffer): Promise<BrightnessReport> {
  const stats = await sharp(buffer).stats();
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
