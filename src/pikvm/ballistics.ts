/**
 * Mouse ballistics measurement and profile management for relative-mouse HID.
 *
 * iPadOS applies non-disableable pointer acceleration to relative USB HID
 * deltas, so 1 emitted mickey ≠ 1 moved pixel. To "click at screen coordinate
 * (x, y)" we need an empirical curve: pixels-per-mickey as a function of
 * (per-call delta magnitude, pace between calls). This module:
 *
 *   1. Slams the pointer into a screen corner to establish a known origin.
 *   2. Sweeps (axis × magnitude × pace × rep) and measures the pixel
 *      displacement produced by each parameter combination.
 *   3. Persists the resulting profile to disk for reuse.
 *   4. Exposes a lookup function that consumers (move-to, click-at) use to
 *      convert a desired pixel distance into a sequence of relative deltas.
 *
 * See /Users/georg/.claude/plans/we-have-not-have-vivid-stallman.md
 */

import { promises as fs } from 'fs';
import path from 'path';
import { PiKVMClient, ScreenResolution } from './client.js';
import {
  Cluster,
  DEFAULT_DETECTION_CONFIG,
  DetectionConfig,
  diffScreenshots,
  locateCursor,
} from './cursor-detect.js';
import { sleep } from './util.js';

// ============================================================================
// Types
// ============================================================================

export type Axis = 'x' | 'y';
export type Pace = 'fast' | 'slow';
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface BallisticsSample {
  axis: Axis;
  magnitude: number;
  pace: Pace;
  callCount: number;
  mickeysEmitted: number;
  pixelsMeasured: number;
  pxPerMickey: number;
  rep: number;
}

export interface BallisticsProfile {
  version: 1;
  createdAt: string;
  resolution: ScreenResolution;
  samples: BallisticsSample[];
  // Per-axis/pace/magnitude median of pxPerMickey, pre-aggregated for quick
  // lookups. Keyed as `${axis}:${pace}:${magnitude}`.
  medians: Record<string, number>;
}

export interface MeasureBallisticsOptions {
  magnitudes?: number[];      // default [5, 10, 20, 40, 80, 127]
  paces?: Pace[];             // default ['fast', 'slow']
  axes?: Axis[];              // default ['x', 'y']
  reps?: number;              // default 2
  callsPerCell?: number;      // default 5 (calls of `magnitude` per rep)
  slowPaceMs?: number;        // default 30 ms between calls in 'slow'
  settleMs?: number;          // default 400 ms after deltas, before screenshot
  slamCalls?: number;         // default computed from resolution
  slamPaceMs?: number;        // default 15 ms between slam calls
  nudgeCalls?: number;        // default 20 — away-from-edge calls after slam
  nudgeCallPaceMs?: number;   // default 5 ms between nudge calls
  cornerTolerance?: number;   // default 80 px — post-slam cluster must land
                              // within this box from the expected corner
  noiseFrames?: number;       // default 4 — baseline frames for noise capture
  noiseIntervalMs?: number;   // default 500 — gap between baseline frames
  noiseExcludeRadius?: number; // default 50 px around a noise centroid
  detection?: Partial<DetectionConfig>;
  profilePath?: string;       // default ./data/ballistics.json
  verbose?: boolean;
}

export interface MeasureBallisticsResult {
  success: boolean;
  profile: BallisticsProfile | null;
  profilePath: string;
  samplesAccepted: number;
  samplesRejected: number;
  durationMs: number;
  message: string;
}

// ============================================================================
// Helpers
// ============================================================================

async function takeRawScreenshot(client: PiKVMClient): Promise<Buffer> {
  const result = await client.screenshot();
  return result.buffer;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cornerVector(corner: Corner): { x: -1 | 1; y: -1 | 1 } {
  switch (corner) {
    case 'top-left': return { x: -1, y: -1 };
    case 'top-right': return { x: 1, y: -1 };
    case 'bottom-left': return { x: -1, y: 1 };
    case 'bottom-right': return { x: 1, y: 1 };
  }
}

function defaultProfilePath(): string {
  return path.resolve(process.cwd(), 'data', 'ballistics.json');
}

// ============================================================================
// Noise baseline
// ============================================================================

export interface NoiseBaseline {
  centroids: Array<{ x: number; y: number; size: number }>;
  frames: number;
}

/**
 * Characterise "always-animating" regions (clock widgets, weather tickers,
 * pointer-trail fades, etc.) by taking several screenshots with NO mouse
 * input and diffing consecutive pairs. Anything that consistently shows up
 * is background noise we need to filter out of cursor-detection diffs.
 */
export async function captureNoiseBaseline(
  client: PiKVMClient,
  options: {
    frames?: number;
    intervalMs?: number;
    detection?: DetectionConfig;
    verbose?: boolean;
  } = {},
): Promise<NoiseBaseline> {
  const frames = options.frames ?? 4;
  const intervalMs = options.intervalMs ?? 500;
  const detection = options.detection ?? DEFAULT_DETECTION_CONFIG;

  const shots: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    shots.push(await takeRawScreenshot(client));
    if (i < frames - 1) await sleep(intervalMs);
  }

  // Collect every cluster from every consecutive diff.
  const all: Cluster[] = [];
  for (let i = 0; i < shots.length - 1; i++) {
    try {
      const clusters = await diffScreenshots(shots[i], shots[i + 1], detection);
      all.push(...clusters);
    } catch {
      // dimensions mismatch between frames — ignore, we'll still have some data
    }
  }

  // Deduplicate: any cluster whose centroid is within mergeRadius of another
  // collapses to a single noise centroid (with max size we've ever seen).
  const deduped: Array<{ x: number; y: number; size: number }> = [];
  const radius = detection.mergeRadius;
  for (const c of all) {
    const existing = deduped.find((d) => {
      const dx = d.x - c.centroidX;
      const dy = d.y - c.centroidY;
      return Math.sqrt(dx * dx + dy * dy) <= radius;
    });
    if (existing) {
      existing.size = Math.max(existing.size, c.pixels);
    } else {
      deduped.push({ x: c.centroidX, y: c.centroidY, size: c.pixels });
    }
  }

  if (options.verbose) {
    console.error(`[noise-baseline] ${deduped.length} persistent regions from ${frames} frames:`);
    for (const d of deduped.slice(0, 8).sort((a, b) => b.size - a.size)) {
      console.error(`  (${d.x},${d.y}) size=${d.size}px`);
    }
  }

  return { centroids: deduped, frames };
}

/**
 * Reject clusters that overlap known noise regions. This is a hard filter:
 * if the cursor happens to be over a noise region (e.g. clock widget),
 * we'd rather lose that sample than mistake the widget's animation for
 * the cursor. With multi-axis sampling across several reps, we have
 * enough other samples to get a reliable median.
 */
function filterOutNoise(
  clusters: Cluster[],
  noise: NoiseBaseline | null,
  excludeRadius: number,
): Cluster[] {
  if (!noise || noise.centroids.length === 0) return clusters;
  return clusters.filter((c) => {
    for (const n of noise.centroids) {
      const dx = n.x - c.centroidX;
      const dy = n.y - c.centroidY;
      if (Math.sqrt(dx * dx + dy * dy) <= excludeRadius) return false;
    }
    return true;
  });
}

// ============================================================================
// Slam to corner
// ============================================================================

export interface SlamOptions {
  calls?: number;
  paceMs?: number;
  corner?: Corner;
  verbose?: boolean;
}

export interface NudgeOptions {
  calls?: number;      // default 5 — each emits ±127 per axis
  paceMs?: number;     // default 10
  away?: Corner;       // which corner to move AWAY from (opposite of slam target)
  onlyAxis?: Axis;     // if set, move only along this axis (perpendicular to
                       // the measurement axis, so the measurement starts
                       // with maximum travel room)
  verbose?: boolean;
}

/**
 * After a slam, the cursor is pinned at a screen edge. iPadOS applies an
 * "edge dead zone" that absorbs the first ~100-200 mickeys of any movement
 * away from the edge — the cursor doesn't visibly travel until that budget
 * is spent. Observed empirically on this iPad: 127 mickeys = no movement;
 * 635 mickeys = 475 px travel.
 *
 * This nudge emits enough deltas in the "away" direction to comfortably
 * exceed the dead zone, placing the cursor in open space where measurements
 * and cursor detection are clean.
 */
export async function nudgeFromEdge(
  client: PiKVMClient,
  options: NudgeOptions = {},
): Promise<void> {
  const away = options.away ?? 'top-left';
  const calls = options.calls ?? 5;
  const paceMs = options.paceMs ?? 10;
  // Invert the corner: moving AWAY from top-left means +x, +y.
  const vec = cornerVector(away);
  let dx = -127 * vec.x;
  let dy = -127 * vec.y;
  if (options.onlyAxis === 'x') dy = 0;
  if (options.onlyAxis === 'y') dx = 0;
  if (options.verbose) {
    console.error(`[nudge] away from ${away}: ${calls} × (${dx},${dy}) @ ${paceMs}ms`);
  }
  for (let i = 0; i < calls; i++) {
    await client.mouseMoveRelative(dx, dy);
    if (paceMs > 0) await sleep(paceMs);
  }
}

/**
 * Drive the pointer into a screen corner by emitting many full-range deltas
 * in that direction. iPadOS clamps the pointer at the screen edge regardless
 * of acceleration, so after enough calls we have a deterministic origin.
 *
 * No verification by cursor detection here — the caller (measureBallistics)
 * validates "we actually hit the corner" implicitly: the first cell's diff
 * will show a cursor cluster starting near the corner. If slam failed, the
 * first cell's measurement will be garbage and will be rejected by the
 * outlier filter. That's cheaper than an explicit locateCursor per slam.
 */
export async function slamToCorner(
  client: PiKVMClient,
  options: SlamOptions = {},
): Promise<void> {
  const corner = options.corner ?? 'top-left';
  // Pace matters on iPadOS: rapid slams to the edge appear to be interpreted
  // as a system gesture (observed: iPad went to lock screen after a 28x @ 15ms
  // slam from mid-screen to top-left). 60 ms between calls is slow enough for
  // iPadOS to treat it as ordinary pointer movement.
  const paceMs = options.paceMs ?? 60;
  const resolution = await client.getResolution();
  const calls = options.calls ?? Math.ceil(Math.max(resolution.width, resolution.height) / 100) + 8;
  const vec = cornerVector(corner);

  if (options.verbose) {
    console.error(`[slam] ${corner} × ${calls} calls @ ${paceMs}ms`);
  }

  for (let i = 0; i < calls; i++) {
    await client.mouseMoveRelative(127 * vec.x, 127 * vec.y);
    if (paceMs > 0) await sleep(paceMs);
  }
}

// ============================================================================
// Measurement
// ============================================================================

export interface PairSelectionOptions {
  /** Min pixel count for a cluster to be a candidate. Below this is noise. */
  cursorMinPixels?: number;   // default 12
  /** Max pixel count for a cluster to be a candidate. Above this is usually
   *  a widget or large UI region, not the cursor. */
  cursorMaxPixels?: number;   // default 150
  /** Two cursor positions (before/after) should have similar visual
   *  signatures, so their pixel counts should be close. Max ratio
   *  larger/smaller allowed. */
  sizeRatioLimit?: number;    // default 2.5
  /** Maximum off-axis displacement, as a fraction of on-axis displacement.
   *  The cursor moves nearly straight when commanded +x or +y; a pair with
   *  large off-axis drift is probably two unrelated clusters. */
  offAxisToleranceRatio?: number; // default 0.35
  /** Minimum absolute on-axis displacement (px). Smaller than this is
   *  probably two samples of the same near-stationary cluster. */
  minOnAxisPx?: number;       // default 25
}

/**
 * Pick the cluster pair that best matches an expected delta vector.
 *
 * We assume the cursor is a small-to-medium bright cluster whose before-move
 * and after-move signatures have similar pixel counts. We reject obvious
 * widget regions (too big) and sub-cursor noise (too small) up front, then
 * find the pair whose displacement aligns with the commanded direction with
 * minimal off-axis drift and matching sizes.
 */
function orderClustersByDirection(
  clusters: Cluster[],
  expectedDirection: { x: number; y: number },
  options: PairSelectionOptions = {},
): [Cluster, Cluster] | null {
  const minPx = options.cursorMinPixels ?? 12;
  const maxPx = options.cursorMaxPixels ?? 150;
  const sizeRatioLimit = options.sizeRatioLimit ?? 2.5;
  const offAxisTol = options.offAxisToleranceRatio ?? 0.35;
  const minOnAxisPx = options.minOnAxisPx ?? 25;

  // Keep only cursor-sized clusters.
  const candidates = clusters.filter((c) => c.pixels >= minPx && c.pixels <= maxPx);
  if (candidates.length < 2) return null;

  const expectedAxis: 'x' | 'y' = Math.abs(expectedDirection.x) >= Math.abs(expectedDirection.y) ? 'x' : 'y';
  const sign = expectedAxis === 'x'
    ? Math.sign(expectedDirection.x)
    : Math.sign(expectedDirection.y);

  let best: { pair: [Cluster, Cluster]; score: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      // 1. Size consistency — a cursor at different positions should have
      //    similar pixel counts.
      const sizeRatio = Math.max(a.pixels, b.pixels) / Math.max(1, Math.min(a.pixels, b.pixels));
      if (sizeRatio > sizeRatioLimit) continue;

      // 2. Direction — the larger magnitude cluster's position minus the
      //    smaller should match the commanded sign.
      const dx = b.centroidX - a.centroidX;
      const dy = b.centroidY - a.centroidY;
      const axisDisp = expectedAxis === 'x' ? dx : dy;
      const offAxisAbs = expectedAxis === 'x' ? Math.abs(dy) : Math.abs(dx);
      const onAxisAbs = Math.abs(axisDisp);
      if (onAxisAbs < minOnAxisPx) continue;

      // 3. Off-axis hard cap — cursor moves mostly on-axis.
      if (offAxisAbs > onAxisAbs * offAxisTol) continue;

      // 4. Align direction.
      const alignedAxis = sign * axisDisp;
      if (alignedAxis <= 0) continue;

      // 5. Score: prefer larger on-axis, lower off-axis, tighter size match.
      const score = alignedAxis - offAxisAbs - 10 * (sizeRatio - 1);
      if (!best || score > best.score) {
        best = { pair: [a, b], score };
      }
    }
  }

  return best ? best.pair : null;
}

async function measureCell(
  client: PiKVMClient,
  axis: Axis,
  magnitude: number,
  pace: Pace,
  rep: number,
  noise: NoiseBaseline | null,
  options: Required<Omit<MeasureBallisticsOptions, 'detection' | 'profilePath' | 'verbose' | 'axes' | 'magnitudes' | 'paces'>> & {
    detection: DetectionConfig;
    verbose: boolean;
    noiseExcludeRadius: number;
  },
): Promise<BallisticsSample | null> {
  // Reset: slam to top-left, then nudge past the edge dead zone so the
  // cursor sits in open space where movement registers and detection is
  // clean.
  await slamToCorner(client, {
    calls: options.slamCalls,
    paceMs: options.slamPaceMs,
    corner: 'top-left',
    verbose: false,
  });
  // Nudge PERPENDICULAR to the measurement axis so the cursor stays near
  // the edge it will travel away from (maximising measurement headroom).
  // For +x measurements: nudge down (onlyAxis=y), cursor lands at left-middle.
  // For +y measurements: nudge right (onlyAxis=x), cursor lands at top-middle.
  await nudgeFromEdge(client, {
    calls: options.nudgeCalls,
    paceMs: options.nudgeCallPaceMs,
    away: 'top-left',
    onlyAxis: axis === 'x' ? 'y' : 'x',
    verbose: false,
  });

  // Warm-up probe: a small move right before screenshot A so the cursor is
  // guaranteed visible (iPadOS fades the cursor ~300 ms after movement
  // stops). The probe itself contributes negligibly to the measurement.
  await client.mouseMoveRelative(5, 0);
  await sleep(50);
  const before = await takeRawScreenshot(client);

  const dx = axis === 'x' ? magnitude : 0;
  const dy = axis === 'y' ? magnitude : 0;
  const paceMs = pace === 'fast' ? 0 : options.slowPaceMs;

  for (let i = 0; i < options.callsPerCell; i++) {
    await client.mouseMoveRelative(dx, dy);
    if (paceMs > 0) await sleep(paceMs);
  }
  // Screenshot B immediately — the cursor was just moved and is still
  // rendered, before iPadOS has a chance to fade it.
  const after = await takeRawScreenshot(client);

  let clusters: Cluster[];
  try {
    clusters = await diffScreenshots(before, after, options.detection);
  } catch (err) {
    if (options.verbose) {
      console.error(`[cell ${axis}/${magnitude}/${pace}/r${rep}] diff threw: ${(err as Error).message}`);
    }
    return null;
  }

  const rawCount = clusters.length;
  clusters = filterOutNoise(clusters, noise, options.noiseExcludeRadius);

  if (options.verbose) {
    const top = [...clusters].sort((a, b) => b.pixels - a.pixels).slice(0, 6);
    console.error(
      `[cell ${axis}/${magnitude}/${pace}/r${rep}] raw=${rawCount} afterNoise=${clusters.length} top6=${top
        .map((c) => `(${c.centroidX},${c.centroidY},${c.pixels}px)`)
        .join(' ')}`,
    );
  }

  if (clusters.length < 2) {
    if (options.verbose) {
      console.error(`[cell ${axis}/${magnitude}/${pace}/r${rep}] only ${clusters.length} cluster(s) after noise filter`);
    }
    return null;
  }

  const ordered = orderClustersByDirection(clusters, { x: dx, y: dy });
  if (!ordered) {
    if (options.verbose) {
      console.error(`[cell ${axis}/${magnitude}/${pace}/r${rep}] no cluster pair aligned with (${dx},${dy})`);
    }
    return null;
  }
  const [pre, post] = ordered;

  const displaced = axis === 'x'
    ? post.centroidX - pre.centroidX
    : post.centroidY - pre.centroidY;

  if (displaced <= 0) {
    if (options.verbose) {
      console.error(`[cell ${axis}/${magnitude}/${pace}/r${rep}] non-positive displacement ${displaced}`);
    }
    return null;
  }

  const mickeysEmitted = magnitude * options.callsPerCell;
  const pxPerMickey = displaced / mickeysEmitted;

  if (options.verbose) {
    console.error(
      `[cell ${axis}/${magnitude}/${pace}/r${rep}] pre=(${pre.centroidX},${pre.centroidY}) post=(${post.centroidX},${post.centroidY}) mickeys=${mickeysEmitted} px=${displaced} ratio=${pxPerMickey.toFixed(4)}`,
    );
  }

  return {
    axis,
    magnitude,
    pace,
    callCount: options.callsPerCell,
    mickeysEmitted,
    pixelsMeasured: displaced,
    pxPerMickey,
    rep,
  };
}

export async function measureBallistics(
  client: PiKVMClient,
  userOptions: MeasureBallisticsOptions = {},
): Promise<MeasureBallisticsResult> {
  const startedAt = Date.now();
  const options = {
    magnitudes: userOptions.magnitudes ?? [5, 10, 20, 40, 80, 127],
    paces: userOptions.paces ?? (['fast', 'slow'] as Pace[]),
    axes: userOptions.axes ?? (['x', 'y'] as Axis[]),
    reps: userOptions.reps ?? 2,
    callsPerCell: userOptions.callsPerCell ?? 5,
    slowPaceMs: userOptions.slowPaceMs ?? 30,
    settleMs: userOptions.settleMs ?? 150,
    slamCalls: userOptions.slamCalls ?? 0, // 0 = auto, resolved in slamToCorner
    slamPaceMs: userOptions.slamPaceMs ?? 15,
    nudgeCalls: userOptions.nudgeCalls ?? 5,
    nudgeCallPaceMs: userOptions.nudgeCallPaceMs ?? 10,
    cornerTolerance: userOptions.cornerTolerance ?? 80,
    noiseFrames: userOptions.noiseFrames ?? 4,
    noiseIntervalMs: userOptions.noiseIntervalMs ?? 500,
    noiseExcludeRadius: userOptions.noiseExcludeRadius ?? 30,
    detection: { ...DEFAULT_DETECTION_CONFIG, ...userOptions.detection },
    profilePath: userOptions.profilePath ?? defaultProfilePath(),
    verbose: userOptions.verbose ?? false,
  };

  const resolution = await client.getResolution(true);

  // Capture noise baseline before touching the mouse so the cursor isn't
  // moving in any of the baseline frames.
  const noise = await captureNoiseBaseline(client, {
    frames: options.noiseFrames,
    intervalMs: options.noiseIntervalMs,
    detection: options.detection,
    verbose: options.verbose,
  });

  const samples: BallisticsSample[] = [];
  let rejected = 0;

  for (const axis of options.axes) {
    for (const magnitude of options.magnitudes) {
      for (const pace of options.paces) {
        for (let rep = 1; rep <= options.reps; rep++) {
          const sample = await measureCell(client, axis, magnitude, pace, rep, noise, options);
          if (sample) {
            samples.push(sample);
          } else {
            rejected++;
          }
        }
      }
    }
  }

  if (samples.length === 0) {
    return {
      success: false,
      profile: null,
      profilePath: options.profilePath,
      samplesAccepted: 0,
      samplesRejected: rejected,
      durationMs: Date.now() - startedAt,
      message: 'No valid samples collected. Check that the cursor is visible on screen and the display is not going to sleep.',
    };
  }

  const medians = computeMedians(samples);
  const profile: BallisticsProfile = {
    version: 1,
    createdAt: new Date().toISOString(),
    resolution,
    samples,
    medians,
  };

  await saveProfile(profile, options.profilePath);

  return {
    success: true,
    profile,
    profilePath: options.profilePath,
    samplesAccepted: samples.length,
    samplesRejected: rejected,
    durationMs: Date.now() - startedAt,
    message: `Collected ${samples.length} samples (${rejected} rejected) in ${((Date.now() - startedAt) / 1000).toFixed(0)}s. Profile written to ${options.profilePath}.`,
  };
}

// ============================================================================
// Median aggregation and lookup
// ============================================================================

function medianKey(axis: Axis, pace: Pace, magnitude: number): string {
  return `${axis}:${pace}:${magnitude}`;
}

function computeMedians(samples: BallisticsSample[]): Record<string, number> {
  const buckets = new Map<string, number[]>();
  for (const s of samples) {
    const key = medianKey(s.axis, s.pace, s.magnitude);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s.pxPerMickey);
  }
  const out: Record<string, number> = {};
  for (const [key, values] of buckets) {
    out[key] = median(values);
  }
  return out;
}

/**
 * Pixels per mickey for a given (axis, magnitude, pace). Interpolates along
 * the magnitude dimension when the exact magnitude wasn't sampled.
 */
export function lookupPxPerMickey(
  profile: BallisticsProfile,
  axis: Axis,
  magnitude: number,
  pace: Pace,
): number | null {
  // Exact hit
  const exact = profile.medians[medianKey(axis, pace, magnitude)];
  if (exact !== undefined) return exact;

  // Interpolate across sampled magnitudes for this axis+pace
  const sampled: Array<{ mag: number; value: number }> = [];
  for (const key of Object.keys(profile.medians)) {
    const [a, p, m] = key.split(':');
    if (a === axis && p === pace) {
      sampled.push({ mag: Number(m), value: profile.medians[key] });
    }
  }
  if (sampled.length === 0) return null;
  sampled.sort((a, b) => a.mag - b.mag);

  if (magnitude <= sampled[0].mag) return sampled[0].value;
  if (magnitude >= sampled[sampled.length - 1].mag) return sampled[sampled.length - 1].value;

  for (let i = 0; i < sampled.length - 1; i++) {
    const lo = sampled[i];
    const hi = sampled[i + 1];
    if (magnitude >= lo.mag && magnitude <= hi.mag) {
      const t = (magnitude - lo.mag) / (hi.mag - lo.mag);
      return lo.value + t * (hi.value - lo.value);
    }
  }
  return null;
}

// ============================================================================
// Persistence
// ============================================================================

export async function saveProfile(profile: BallisticsProfile, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf8');
}

export async function loadProfile(filePath: string): Promise<BallisticsProfile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BallisticsProfile;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported ballistics profile version: ${parsed.version}`);
    }
    return parsed;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

export function profileIsFreshFor(
  profile: BallisticsProfile | null,
  resolution: ScreenResolution,
): profile is BallisticsProfile {
  if (!profile) return false;
  return (
    profile.resolution.width === resolution.width &&
    profile.resolution.height === resolution.height
  );
}

// Re-export helpers used by callers that don't want to know about cursor-detect
export { locateCursor };
