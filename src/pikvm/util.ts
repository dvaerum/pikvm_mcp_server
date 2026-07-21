/**
 * Cross-module helpers used by the pikvm/ implementation modules.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Median of a numeric array. Returns NaN for an empty array. Used by the
 * calibration (auto-calibrate) and ballistics sampling pipelines to aggregate
 * per-round ratios outlier-resistantly.
 */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
