/**
 * Slam-to-corner mechanism: corner geometry + the emit loop that drives the
 * relative-mouse pointer into a screen corner, plus its optional post-slam
 * motion-verification check.
 *
 * F9 (Round 2 Phase 3, 2/2): extracted out of ballistics.ts to break a
 * documented-deliberate import cycle (ballistics.ts's `measureCell` calls
 * `anchorCursor`, which in turn called back into ballistics.ts for
 * slamToCorner/nudgeFromEdge/cornerTargetPx/cornerVector — safe under ESM's
 * live-binding hoisting since neither side referenced the other at
 * module-evaluation time, but still worth removing outright now that F1
 * (Round 2 Phase 3, 1/2) made slamToCorner's screenshot capture
 * caller-injected rather than hardwired to ballistics.ts's own
 * takeRawScreenshot — the last thing tying this vocabulary to ballistics.ts
 * specifically.
 *
 * Layering (matches cursor-anchor.ts's own header comment): this module is
 * pure MECHANISM (corner geometry, the raw emit loop, the optional
 * motion-verification diff) — no safety guard, no recovery policy. Those
 * live one layer up, in cursor-anchor.ts's `anchorCursor()`.
 */

import { PiKVMClient, ScreenResolution } from './client.js';
import { Cluster, DEFAULT_DETECTION_CONFIG, DetectionConfig, diffScreenshots } from './cursor-detect.js';
import { detectBoundsOrNull, getLastGoodBounds, IpadBounds } from './orientation.js';
import { sleep } from './util.js';

// ============================================================================
// Types
// ============================================================================

export type Axis = 'x' | 'y';
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

// ============================================================================
// Corner geometry
// ============================================================================

/** Exported for cursor-anchor.ts's own verification capture (see the
 *  cornerTargetPx doc below — same reasoning). */
export function cornerVector(corner: Corner): { x: -1 | 1; y: -1 | 1 } {
  switch (corner) {
    case 'top-left': return { x: -1, y: -1 };
    case 'top-right': return { x: 1, y: -1 };
    case 'bottom-left': return { x: -1, y: 1 };
    case 'bottom-right': return { x: 1, y: 1 };
  }
}

// ============================================================================
// Slam to corner
// ============================================================================

export interface SlamOptions {
  calls?: number;
  paceMs?: number;
  corner?: Corner;
  verbose?: boolean;
  /** If true, screenshots before and after the slam and checks whether a
   *  cursor-sized cluster appeared within `cornerTolerance` px of the
   *  expected corner — reusing the same diff/cluster-detection primitives
   *  measureCell already relies on for calibration. The result is returned,
   *  not acted on: slamToCorner does not retry or throw on a failed check,
   *  because the right recovery differs per caller (reject a sample, retry
   *  a different way, just warn, etc).
   *
   *  This checks "did the expected motion register", which is deliberately
   *  narrower than "is this a lock screen" — see ipad-unlock.ts's Phase 321
   *  history for why a general lock-screen classifier was rejected (false
   *  positives on legitimate non-home screens). Costs two extra screenshots
   *  + one diff; opt-in, default false. */
  verifyMotion?: boolean;
  /**
   * F1 (Round 2 Phase 3): the screenshot fn verifyMotion uses for its
   * before/after pair. REQUIRED when verifyMotion is true (throws
   * otherwise) — no default, because the choice of capture function is a
   * correctness question, not a convenience one:
   *
   * ADR 0001 (docs/adr/0001-do-not-merge-cursor-detection-and-calibration-
   * sampling-lookalikes.md): three real takeRawScreenshot variants exist on
   * purpose and must not be merged — cursor-detect.ts's exported version
   * wake-nudges before capture (±1 px, keeps the auto-fading iPad cursor
   * visible), ballistics.ts's and auto-calibrate.ts's own versions
   * deliberately don't (a nudge right before a calibration/ballistics
   * capture would contaminate the very displacement being measured).
   *
   * An optional param defaulting to any one of them would silently be
   * wrong for the other caller class. Pass the non-nudging capture for
   * calibration-adjacent call sites; read ADR 0001 before relaxing this.
   */
  screenshot?: (client: PiKVMClient) => Promise<Buffer>;
  /** Tolerance (px) for the post-slam cluster-near-corner check. Default 80.
   *  Only used when verifyMotion is true. */
  cornerTolerance?: number;
  /**
   * F1: caller-supplied bounds, when already resolved (e.g. anchorCursor's
   * guard-resolution step). `undefined` (the default) means "no hint, do
   * the normal cache-first/fresh-detect fallback"; an explicit `null` means
   * "I already tried and there's genuinely no bounds" — skips a redundant
   * detection round trip. Only used when verifyMotion is true.
   */
  boundsHint?: IpadBounds | null;
  detection?: Partial<DetectionConfig>;
}

/** Result of slamToCorner's optional post-slam motion check (verifyMotion). */
export interface SlamMotionCheck {
  /** True if a cursor-sized cluster was found within cornerTolerance px of
   *  the expected corner after the slam. False means the expected motion
   *  did not register — the slam may have been interrupted (e.g. a system
   *  gesture reinterpretation) or something else is obscuring detection.
   *  Deliberately doesn't diagnose the cause; see the verifyMotion doc on
   *  SlamOptions. */
  verified: boolean;
  /** Clusters found within tolerance of the expected corner, for diagnostics. */
  matchedClusters: Cluster[];
}

/** Corner of the RAW HDMI capture frame. Fallback only — see
 *  cornerTargetFromBounds below, which is correct for any letterboxed
 *  iPad target and should be preferred whenever bounds are available.
 *  Exported for cursor-anchor.ts's own fallback use (its bounds-guard
 *  resolution needs the same raw-frame corner when bounds are
 *  undetectable). */
export function cornerTargetPx(corner: Corner, resolution: ScreenResolution): { x: number; y: number } {
  switch (corner) {
    case 'top-left': return { x: 0, y: 0 };
    case 'top-right': return { x: resolution.width, y: 0 };
    case 'bottom-left': return { x: 0, y: resolution.height };
    case 'bottom-right': return { x: resolution.width, y: resolution.height };
  }
}

/**
 * 2026-08-24 P0 fix: `cornerTargetPx` alone computes the expected slam
 * landing point against the raw HDMI capture frame (e.g. top-left → (0,0)
 * of a 1920×1080 frame). For a letterboxed iPad target, the relative-mouse
 * cursor's actual top-left sits at the iPad's OWN content rectangle corner
 * (bounds.x, bounds.y) — typically several hundred px away from (0,0) on a
 * portrait letterbox. verifyMotion/captureVerification compared against
 * the wrong corner was DETERMINISTICALLY false for every real iPad target
 * (not probabilistic noise), live-confirmed via a screenshot-verified
 * perfect corner landing that still failed verification (distance ≈619px
 * vs the 80px default tolerance). Prefer this over cornerTargetPx whenever
 * iPad bounds are available (detected or cached); fall back to
 * cornerTargetPx only when bounds are genuinely undetectable (dark/uniform
 * frame) or the target isn't an iPad (desktop/absolute-mouse — where the
 * bounds detector's own landscape/full-frame result makes the two
 * functions coincide anyway).
 */
export function cornerTargetFromBounds(corner: Corner, bounds: IpadBounds): { x: number; y: number } {
  switch (corner) {
    case 'top-left': return { x: bounds.x, y: bounds.y };
    case 'top-right': return { x: bounds.x + bounds.width, y: bounds.y };
    case 'bottom-left': return { x: bounds.x, y: bounds.y + bounds.height };
    case 'bottom-right': return { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
  }
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
 * No verification by cursor detection by default — the caller (measureBallistics)
 * validates "we actually hit the corner" implicitly: the first cell's diff
 * will show a cursor cluster starting near the corner. If slam failed, the
 * first cell's measurement will be garbage and will be rejected by the
 * outlier filter. That's cheaper than an explicit locateCursor per slam.
 * Pass verifyMotion:true (see SlamOptions) to opt into an explicit check
 * instead, for callers (like unlockIpad) that don't have their own
 * downstream signal to fall back on.
 */
export async function slamToCorner(
  client: PiKVMClient,
  options: SlamOptions = {},
): Promise<SlamMotionCheck | undefined> {
  const corner = options.corner ?? 'top-left';
  // Pace matters on iPadOS: rapid slams to the edge appear to be interpreted
  // as a system gesture (observed: iPad went to lock screen after a 28x @ 15ms
  // slam from mid-screen to top-left). 60 ms between calls is slow enough for
  // iPadOS to treat it as ordinary pointer movement. NOTE 2026-08-24: a later
  // controlled retest (N=30 each) found the lock risk present at a
  // non-trivial rate at BOTH 15ms and 60ms — pace alone isn't a reliable
  // mitigation. See verifyMotion for a check that doesn't depend on pace.
  const paceMs = options.paceMs ?? 60;
  const resolution = await client.getResolution();
  const calls = options.calls ?? Math.ceil(Math.max(resolution.width, resolution.height) / 100) + 8;
  const vec = cornerVector(corner);
  const verifyMotion = options.verifyMotion ?? false;
  // F1: no default screenshot fn — see SlamOptions.screenshot's ADR-0001 doc
  // for why silently picking one would be a correctness bug, not a convenience.
  if (verifyMotion && !options.screenshot) {
    throw new Error('slamToCorner: verifyMotion:true requires options.screenshot (no default — see SlamOptions.screenshot doc).');
  }

  if (options.verbose) {
    console.error(`[slam] ${corner} × ${calls} calls @ ${paceMs}ms`);
  }

  const before = verifyMotion ? await options.screenshot!(client) : null;

  for (let i = 0; i < calls; i++) {
    await client.mouseMoveRelative(127 * vec.x, 127 * vec.y);
    if (paceMs > 0) await sleep(paceMs);
  }

  if (!verifyMotion || !before) return undefined;

  // One more small nudge in-corner right before the verification screenshot:
  // iPadOS fades a static cursor after ~300ms, and the slam loop's last
  // sleep may already have crossed that. Mirrors the warm-up-probe trick
  // measureCell uses before its own before/after pair.
  await client.mouseMoveRelative(3 * vec.x, 3 * vec.y);
  await sleep(50);
  const after = await options.screenshot!(client);

  const detection = { ...DEFAULT_DETECTION_CONFIG, ...options.detection };
  const tolerance = options.cornerTolerance ?? 80;
  // P0 fix (2026-08-24): use the iPad's own detected bounds corner, not the
  // raw capture-frame corner — see cornerTargetFromBounds's doc. F1: an
  // explicit boundsHint (including null — "I already tried, no bounds")
  // skips a redundant detection round trip; undefined falls back to the
  // original cache-first/fresh-detect chain, then to the raw-frame corner
  // only if bounds are genuinely undetectable.
  const bounds = options.boundsHint !== undefined
    ? options.boundsHint
    : getLastGoodBounds() ?? await detectBoundsOrNull(client, {
      verbose: options.verbose,
      logPrefix: 'slam-verify',
    });
  const expected = bounds ? cornerTargetFromBounds(corner, bounds) : cornerTargetPx(corner, resolution);

  let clusters: Cluster[];
  try {
    clusters = await diffScreenshots(before, after, detection);
  } catch (err) {
    if (options.verbose) {
      console.error(`[slam] verifyMotion diff threw: ${(err as Error).message}`);
    }
    return { verified: false, matchedClusters: [] };
  }

  const matchedClusters = clusters.filter((c) => {
    const dx = c.centroidX - expected.x;
    const dy = c.centroidY - expected.y;
    return Math.sqrt(dx * dx + dy * dy) <= tolerance;
  });

  if (options.verbose) {
    console.error(
      `[slam] verifyMotion: ${matchedClusters.length}/${clusters.length} cluster(s) within ${tolerance}px of expected (${expected.x},${expected.y})`,
    );
  }

  return { verified: matchedClusters.length > 0, matchedClusters };
}
