/**
 * Approximate-absolute move-to-pixel for PiKVM targets in relative mouse
 * mode (mouse.absolute=false, e.g. iPad).
 *
 * **Motion-as-probe architecture (Phase 3):** the detection signal is the
 * real movement we're emitting anyway, not synthetic probes. Flow:
 *
 *   1. Origin discovery — find where the cursor currently is (strategy).
 *   2. Warmup + screenshot A (cursor rendered at start position).
 *   3. Emit open-loop move + screenshot B (cursor at landing).
 *   4. diff(A, B) → two cursor clusters separated by the commanded travel.
 *      pre ≈ origin + warmup; post ≈ actual landing. Compute live
 *      px/mickey from the real motion, not a different-magnitude probe.
 *   5. If |target − post| exceeds tolerance, loop: emit correction delta,
 *      screenshot C, diff B/C, update observed position. No probes.
 *
 * The diff has displacement on the order of the full open-loop travel
 * (often 500+ px on HDMI), so cursor clusters are easy to separate from
 * widget/icon noise (which typically changes tens of px). iPadOS's cursor
 * morphing still contaminates, but we mitigate by (a) expecting iPad users
 * to disable Pointer Animations in Accessibility settings and (b) filtering
 * candidate pairs by proximity to origin/predicted plus expected direction.
 */

import { PiKVMClient, ScreenResolution } from './client.js';
import {
  BallisticsProfile,
  lookupPxPerMickey,
  profileIsFreshFor,
  slamToCorner,
} from './ballistics.js';
import {
  Cluster,
  CursorTemplate,
  DecodedScreenshot,
  DEFAULT_DETECTION_CONFIG,
  decodeScreenshot,
  diffScreenshotsDecoded,
  extractCursorTemplateDecoded,
  findCursorByTemplateSet,
  locateCursor,
} from './cursor-detect.js';
import {
  DEFAULT_TEMPLATE_DIR,
  LEGACY_TEMPLATE_PATH,
  loadTemplateSet,
  migrateLegacyTemplate,
  persistTemplate,
} from './template-set.js';
import {
  detectBoundsOrNull,
  getLastGoodBounds,
  slamOriginFromBounds,
  LEGACY_PORTRAIT_SLAM_ORIGIN,
} from './orientation.js';
import { sleep } from './util.js';

export type MoveStrategy = 'detect-then-move' | 'slam-then-move' | 'assume-at';
export type Axis = 'x' | 'y';

export interface MoveToOptions {
  /** Cursor origin discovery. */
  strategy?: MoveStrategy;
  assumeCursorAt?: { x: number; y: number };
  slamOriginPx?: { x: number; y: number };
  slamFirst?: boolean;

  profile?: BallisticsProfile | null;
  fallbackPxPerMickey?: number;
  chunkMagnitude?: number;
  chunkPaceMs?: number;
  postMoveSettleMs?: number;

  /** Enable closed-loop correction (default true). */
  correct?: boolean;
  /** Max correction passes. Default 2. */
  maxCorrectionPasses?: number;
  /** Tolerance for early-exit (px). If observed |residual| below this in
   *  both axes, stop. Default 25. */
  minResidualPx?: number;

  /** Warmup move emitted before screenshot A so the cursor is rendered.
   *  Mickeys; default 8. */
  warmupMickeys?: number;
  /** Max distance (px) from origin where the "pre" cluster may be.
   *  Default 120. */
  preWindow?: number;
  /** Max distance (px) from predicted landing where the "post" cluster may be.
   *  Default 600 — wide enough to tolerate 2× acceleration variance on a
   *  iPad-size target. */
  postWindow?: number;

  /** Forwarded to slamToCorner when slam strategy is used. */
  slamCalls?: number;
  slamPaceMs?: number;
  verbose?: boolean;

  // -- Phase C: linear-region final approach -------------------------------
  // iPadOS pointer acceleration is velocity-dependent. Slow, small moves
  // land in a near-1:1 region with low variance — the only regime in which
  // open-loop emission is trustworthy. Once we're within
  // `linearTriggerResidualPx` of the target, switch to small-magnitude
  // slow-pace bursts and tighten the convergence target so passes stop at
  // single-digit residuals instead of bottoming out around `minResidualPx`.

  /** Per-call mickey size during the linear-region approach. Default 8 —
   *  small enough that iPadOS doesn't kick acceleration in. */
  linearChunkMagnitude?: number;
  /** Inter-call pace during the linear approach. Default 60 ms — slow
   *  enough that consecutive deltas don't accumulate into a fast burst. */
  linearChunkPaceMs?: number;
  /** Residual at which we drop into the linear regime. Default 100 px. */
  linearTriggerResidualPx?: number;
  /** Convergence target during the linear regime. Default 3 px. */
  linearResidualPx?: number;
  /** Max linear-regime passes (independent of `maxCorrectionPasses`).
   *  Default 4. */
  linearMaxPasses?: number;
  /** Per-axis sanity bounds for the live ratio update. Default [0.3, 5];
   *  loosened from the original [0.5, 3] which was rejecting real bursts
   *  on iPadOS and silently reverting to fallback. */
  ratioClampLo?: number;
  ratioClampHi?: number;

  /** When set, every frame captured during this move (shotA, shotB,
   *  per-pass shotC) is written to this directory as a JPEG. Use only
   *  for debugging — the disk traffic adds latency. */
  debugDir?: string;

  /** Calibration probe size in mickeys. Emitted along the dominant axis
   *  before the open-loop emission, diff'd against pre-probe screenshot
   *  to learn the iPad's real px/mickey ratio fresh per-call. Default 40
   *  — large enough to produce a clear cluster pair, small enough not
   *  to overshoot. Set to 0 to disable (uses fallback ratio for
   *  open-loop, learns from open-loop diff as before). */
  calibrationProbeMickeys?: number;

  /** When true, refuse to fall back to slam-to-corner if detect-then-move
   *  fails. Throw instead. On iPad targets, slam-to-top-left triggers the
   *  iPadOS hot-corner gesture and re-locks the screen — silent slam
   *  fallback destroys the test environment. The MCP tool layer sets
   *  this true when the target reports `mouse.absolute=false`. Default
   *  false (preserves existing behaviour for non-iPad targets). */
  forbidSlamFallback?: boolean;
}

export interface CorrectionPass {
  detectedCursor: { x: number; y: number };
  livePxPerMickey: number;
  correctionMickeys: { x: number; y: number };
  /** How the post-correction position was determined. `motion`: motion-
   *  diff succeeded. `template`: motion-diff failed and template-match
   *  succeeded. `predicted`: both detection paths failed; we trusted
   *  the open-loop prediction (and probably introduced error). */
  mode: 'motion' | 'template' | 'predicted';
  /** Free-form diagnostic: failure reason when motion-diff returned
   *  null, template-match score when fallback fired, etc. */
  reason: string | null;
}

/** A single step in moveToPixel's per-pass accounting. Tracks both the
 *  open-loop probe and every correction so the caller can see exactly
 *  where convergence stalled. */
export interface MovePassDiagnostic {
  /** 0 = the initial open-loop emission; 1..N = correction passes. */
  pass: number;
  /** Which detection path produced the post-position estimate. */
  mode: 'motion' | 'template' | 'predicted';
  /** Position estimate after this pass (motion-diff post centroid,
   *  template-match centre, or open-loop prediction). */
  detectedAt: { x: number; y: number };
  /** Euclidean residual to target. */
  residualPx: number;
  /** px/mickey ratio used to plan this pass's emission. */
  ratioUsed: { x: number; y: number };
  /** Why the chosen mode was used (motion-diff failure reason, template
   *  score, or "ok"). */
  reason: string | null;
  /** True if this pass was emitted in the slow/small linear-region
   *  approach mode (Phase C). */
  linearPhase: boolean;
}

export interface MoveToResult {
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  target: { x: number; y: number };
  predicted: { x: number; y: number };
  emittedMickeys: { x: number; y: number };
  usedPxPerMickey: { x: number; y: number };
  chunkCount: number;
  strategy: MoveStrategy;
  corrections: CorrectionPass[];
  /** Per-pass accounting (open-loop + each correction). */
  diagnostics: MovePassDiagnostic[];
  /** Best-known cursor position after all moves. Comes from the last
   *  successful motion-diff or template-match detection; null if no
   *  detection ever succeeded (in which case the caller should treat
   *  accuracy as uncertain). */
  finalDetectedPosition: { x: number; y: number } | null;
  /** Final residual (Euclidean px from target to finalDetectedPosition).
   *  null when finalDetectedPosition is null. */
  finalResidualPx: number | null;
  resolution: ScreenResolution;
  message: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ============================================================================
// Stale-template-match guard.
//
// Problem: template-match has stable false positives — e.g., a button or
// glyph in the iPad UI that scores 0.74-0.82 against the cursor template.
// When motion-diff is failing in a noisy context, the algorithm trusts
// template-match. If the false positive is at a fixed location, every
// correction pass "finds" the cursor there and emits the same correction,
// burning the pass budget without progress.
//
// Detection: if template-match returns the same position (within 5 px)
// after we emitted ≥30 mickeys of correction in between, treat as stale
// and reject the match — the real cursor moved with the emission, but
// the false positive didn't.
// ============================================================================

/** Phase 12: ratio-update guard. Each correction pass that succeeds
 *  via motion-diff updates the live px/mickey ratio used for the next
 *  emission. If the diff picked a wrong cluster pair (e.g. a widget
 *  animation pair instead of the real cursor pair), the resulting
 *  "live ratio" can be wildly off — live data caught Y ratio
 *  degrading to 0.34 (real iPad Y is 1.5–3.0), after which every
 *  subsequent correction barely moved the cursor. Reject updates
 *  that:
 *    - drift > 2× away from the prior trusted ratio in one pass
 *    - fall outside the absolute [0.5, 4.0] range that bounds iPad
 *      pointer-acceleration variance across known contexts
 *
 *  When `prev` is null (no prior measurement), the absolute-range
 *  check still applies. Pure helper for unit testability. */
export function isRatioUpdatePlausible(
  prev: number | null,
  candidate: number,
): boolean {
  if (candidate < 0.5 || candidate > 4.0) return false;
  if (prev === null) return true;
  const ratio = candidate > prev ? candidate / prev : prev / candidate;
  return ratio <= 2.0;
}

/** Phase 11: locality-aware ranking for multi-template match results.
 *  When the cursor was just at `expectedNear` (e.g. a confirmed prior
 *  position from the previous correction pass), prefer candidates
 *  within `radiusPx` of that prior over far high-scoring matches. The
 *  high-score-everywhere strategy picks stable false positives at iPad
 *  UI elements; this anchors selection to recent ground-truth.
 *
 *  When `expectedNear` is null, OR when no candidates fall within the
 *  radius, falls back to global highest-score selection — preserves
 *  the existing behaviour for cold-start (no prior known position)
 *  and for legitimate large moves (cursor is now far from the prior).
 *
 *  Pure helper, unit-tested. Generic over the candidate shape so it
 *  can be applied to FindCursorResult, FindCursorSetResult, or any
 *  future variant with `position` and `score`. */
export function pickNearestPlausibleMatch<T extends { position: { x: number; y: number }; score: number }>(
  matches: T[],
  expectedNear: { x: number; y: number } | null,
  radiusPx: number,
): T | null {
  if (matches.length === 0) return null;
  if (expectedNear) {
    const within = matches.filter((m) =>
      Math.hypot(m.position.x - expectedNear.x, m.position.y - expectedNear.y) <= radiusPx,
    );
    if (within.length > 0) {
      return within.reduce((a, b) => (a.score > b.score ? a : b));
    }
  }
  return matches.reduce((a, b) => (a.score > b.score ? a : b));
}

/** Phase 10: origin-verification predicate. After template-match
 *  claims the cursor is at `claimed`, we emit a small probe move and
 *  inspect the post-cluster centroid in the resulting motion-diff.
 *  The post cluster should land near `claimed + probeOffsetPx`. If
 *  it's far from that prediction (or right back at `claimed` — meaning
 *  the cursor didn't move at all), the template-match origin was a
 *  stable false positive at a fixed UI element and we must fall
 *  through to a fresh probe-and-diff.
 *
 *  Pure helper so the decision is unit-tested independently of the
 *  PiKVMClient. `tolerance` is in pixels — generous enough to absorb
 *  iPad pointer-acceleration drift and JPEG-noise centroid wobble. */
export function isOriginProbeMatchPlausible(
  claimed: { x: number; y: number },
  observedPost: { x: number; y: number },
  probeOffsetPx: { x: number; y: number },
  tolerance = 40,
): boolean {
  const predicted = {
    x: claimed.x + probeOffsetPx.x,
    y: claimed.y + probeOffsetPx.y,
  };
  const distToPredicted = Math.hypot(observedPost.x - predicted.x, observedPost.y - predicted.y);
  if (distToPredicted > tolerance) return false;
  // Also reject if observed post is right back at the claimed origin —
  // that means the cursor did not move at all, so the claimed origin
  // can't be the real cursor (the real cursor would have moved).
  const distToClaimed = Math.hypot(observedPost.x - claimed.x, observedPost.y - claimed.y);
  const probeMag = Math.hypot(probeOffsetPx.x, probeOffsetPx.y);
  if (distToClaimed < probeMag * 0.25) return false;
  return true;
}

/** Phase 9: cap a correction-pass emission so a single pass can't run
 *  away on a stale ratio. Live data showed 1/3 trials emit (-13, 105)
 *  Y mickeys (553 px overshoot) when motion-diff was blind for two
 *  passes and the observed ratio drifted. Scales both axes
 *  proportionally so direction is preserved when one axis exceeds the
 *  cap. Pure function for unit testability. */
export function capCorrectionMickeys(
  mickeysX: number,
  mickeysY: number,
  cap: number,
): { x: number; y: number } {
  const absX = Math.abs(mickeysX);
  const absY = Math.abs(mickeysY);
  const max = Math.max(absX, absY);
  if (max === 0 || max <= cap) return { x: mickeysX, y: mickeysY };
  const scale = cap / max;
  return {
    x: Math.round(mickeysX * scale),
    y: Math.round(mickeysY * scale),
  };
}

/** Phase 6: clamp the open-loop emit so the projected cursor landing
 *  stays inside the screen bounds (with a small margin). When the
 *  ballistic ratio is stale or context-dependent, an unclamped open-loop
 *  can shoot the cursor off-screen, which loses motion-diff (no post
 *  cluster) and template-match (no cursor pixels in any frame). The
 *  clamp keeps the cursor in-frame so subsequent verification has a
 *  chance to recover the position.
 *
 *  Pure function so it can be unit-tested standalone. Returns the
 *  signed mickey counts to actually emit. Inputs with ratio ≤ 0 are
 *  returned unchanged (no projection possible). */
export function clampMickeysToScreen(
  origin: { x: number; y: number },
  signedMickeysX: number,
  signedMickeysY: number,
  ratioX: number,
  ratioY: number,
  bounds: { width: number; height: number },
  margin = 20,
): { x: number; y: number } {
  let x = signedMickeysX;
  let y = signedMickeysY;
  if (ratioX > 0) {
    const projectedX = origin.x + x * ratioX;
    if (projectedX < margin) {
      x = Math.ceil((margin - origin.x) / ratioX);
    } else if (projectedX > bounds.width - margin) {
      x = Math.floor((bounds.width - margin - origin.x) / ratioX);
    }
  }
  if (ratioY > 0) {
    const projectedY = origin.y + y * ratioY;
    if (projectedY < margin) {
      y = Math.ceil((margin - origin.y) / ratioY);
    } else if (projectedY > bounds.height - margin) {
      y = Math.floor((bounds.height - margin - origin.y) / ratioY);
    }
  }
  return { x, y };
}

/** Phase 4: blind-pass circuit breaker. Returns true if the last 2
 *  diagnostic entries are both `predicted` mode — i.e., motion-diff and
 *  template-match have BOTH failed twice in a row. Continuing to emit
 *  corrections in this state compounds error (each pass shifts
 *  `currentPos` by an unverified prediction whose ratio may be stale).
 *  Caller should break out of the correction loop and trust the last
 *  verified position rather than burn the rest of the pass budget.
 *
 *  Exported for unit tests. */
export function shouldAbortBlindCorrections(diagnostics: MovePassDiagnostic[]): boolean {
  if (diagnostics.length < 2) return false;
  const last = diagnostics[diagnostics.length - 1];
  const secondLast = diagnostics[diagnostics.length - 2];
  return last.mode === 'predicted' && secondLast.mode === 'predicted';
}

/** Returns true if `current` should be rejected as a stale repeat of
 *  `previous` after a correction whose magnitude is `emittedMickeys`.
 *  Exported for unit tests. */
export function isStaleTemplateMatch(
  current: { x: number; y: number },
  previous: { x: number; y: number } | null,
  emittedMickeys: number,
): boolean {
  if (previous === null) return false;
  const drift = Math.hypot(current.x - previous.x, current.y - previous.y);
  // 5 px drift threshold: real cursor + JPEG noise rarely produces less
  // than this when actually re-detected.
  // 30 mickey emission threshold: smaller corrections may legitimately
  // not move the cursor enough to register a different match.
  return drift < 5 && emittedMickeys >= 30;
}

// ============================================================================
// Cursor template SET cache. Captured on every successful motion-diff that
// passes the looksLikeCursor gate, persisted to a templates directory, and
// reused as a non-perturbing detection fallback when motion-diff fails.
//
// Phase 3: a single cached template is brittle across backdrops — once the
// cursor moves over a different wallpaper or panel, NCC drops below threshold
// and template-match stops contributing. The set-aware cache iterates every
// captured template and uses whichever scores highest at match time.
// ============================================================================

let cachedTemplates: CursorTemplate[] | undefined; // undefined = unloaded

async function getCachedTemplates(): Promise<CursorTemplate[]> {
  if (cachedTemplates !== undefined) return cachedTemplates;
  // Migrate the legacy single-file template into the set directory so older
  // installs don't lose their cache when this code ships.
  await migrateLegacyTemplate(LEGACY_TEMPLATE_PATH, DEFAULT_TEMPLATE_DIR).catch(() => undefined);
  cachedTemplates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR).catch(() => []);
  return cachedTemplates;
}

/** Validate that a candidate template region looks plausibly like a
 *  cursor: at least one bright (≥170 channel) achromatic pixel
 *  (R,G,B within 30 of each other), and average saturation across
 *  the region is low. Rejects icon corners and colored UI elements
 *  that motion-diff sometimes mistakes for the cursor. Exported for
 *  unit tests. */
export function looksLikeCursor(t: CursorTemplate): boolean {
  const px = t.width * t.height;
  let brightAchromatic = 0;
  let totalSaturation = 0;
  for (let i = 0; i < px; i++) {
    const o = i * 3;
    const r = t.rgb[o], g = t.rgb[o + 1], b = t.rgb[o + 2];
    const cMin = Math.min(r, g, b);
    const cMax = Math.max(r, g, b);
    const sat = cMax - cMin;
    totalSaturation += sat;
    if (cMin >= 170 && sat <= 30) brightAchromatic++;
  }
  // Need ≥ 4% of the template to be bright-achromatic (cursor pixels)
  // and average saturation < 50 (whole region is mostly grayscale).
  const meanSat = totalSaturation / px;
  return brightAchromatic >= px * 0.04 && meanSat < 50;
}

async function maybePersistTemplate(
  screenshot: DecodedScreenshot,
  cursorPos: { x: number; y: number },
): Promise<void> {
  try {
    // 24 px (down from 32) tightens the crop around the iPad's ~22px
    // arrow cursor, reducing background contamination that hurts cross-
    // wallpaper template matching. See cursor-detect.test.ts for the
    // contract.
    const t = extractCursorTemplateDecoded(screenshot, cursorPos, 24);
    // Reject templates that don't look cursor-like — protects against
    // motion-diff picking a wrong pair (icon corner, animated widget)
    // and the bad capture poisoning all future template matches in a
    // self-reinforcing loop.
    if (!looksLikeCursor(t)) return;

    // Phase 3: route through the set-aware persistence layer. It dedups
    // perceptually-similar captures (same cursor over same backdrop) and
    // caps the directory at TEMPLATE_SET_CAP, dropping the oldest when
    // a new perceptually-distinct backdrop arrives.
    const existing = await getCachedTemplates();
    const result = await persistTemplate(DEFAULT_TEMPLATE_DIR, t, existing);
    cachedTemplates = result.kept;
  } catch {
    // Best-effort; failing to persist is non-fatal.
  }
}

// ============================================================================
// Origin discovery (Phase 5: wakeup nudge before template-match)
// ============================================================================

/** Nudge the cursor a few mickeys to wake it from iPadOS's faded
 *  state before any detection runs. iPadOS hides the pointer after
 *  ~1s of inactivity; a screenshot taken during that fade window
 *  shows no cursor pixels and template-match returns garbage scores
 *  against UI elements. The +30/-30 round-trip is small enough not
 *  to disturb the cursor's position significantly (some asymmetric
 *  acceleration drift is OK — `discoverOrigin` is about to read the
 *  cursor's actual position next anyway). */
export async function wakeupCursor(
  client: PiKVMClient,
  settleMs = 150,
): Promise<void> {
  await client.mouseMoveRelative(30, 0);
  await sleep(80);
  await client.mouseMoveRelative(-30, 0);
  await sleep(settleMs);
}

async function discoverOrigin(
  client: PiKVMClient,
  options: MoveToOptions,
): Promise<{ point: { x: number; y: number }; method: MoveStrategy }> {
  const requested = options.strategy
    ?? (options.slamFirst === false ? 'assume-at' : 'detect-then-move');

  // Debug capture: when debugDir is set, save every screenshot used in
  // origin discovery and label it with what was claimed/found. This is
  // the raw evidence for "did template-match really see the cursor?"
  // questions — without these frames we're guessing.
  const debugDir = options.debugDir ?? null;
  let debugCounter = 0;
  const saveDebug = async (label: string, buf: Buffer): Promise<void> => {
    if (!debugDir) return;
    const fs = await import('fs');
    await fs.promises.mkdir(debugDir, { recursive: true });
    const tag = String(debugCounter++).padStart(2, '0');
    await fs.promises.writeFile(`${debugDir}/${tag}-${label}.jpg`, buf);
  };

  if (requested === 'assume-at') {
    if (!options.assumeCursorAt) {
      throw new Error("strategy='assume-at' requires assumeCursorAt");
    }
    return { point: options.assumeCursorAt, method: 'assume-at' };
  }

  if (requested === 'detect-then-move') {
    // PRIMARY: template-match against a single screenshot. When a cached
    // cursor template exists and the cursor IS visible, this is faster
    // and more accurate than probe-and-diff — no cursor movement
    // perturbs the planning. Template-match origin is imperfect (stable
    // FPs at iPad UI elements at score 0.83) but empirically still
    // better than always-probe (Phase 10 measured locateCursor failing
    // 3/5 trials on the iPad home screen — see docs/troubleshooting/
    // ipad-cursor-detection.md for the full evaluation).
    const tmplSet = await getCachedTemplates();
    if (tmplSet.length > 0) {
      // Phase 5: wake the cursor so template-match has a fresh
      // visible cursor to score against. Without this, faded-cursor
      // screenshots produced false-positive matches at iPad UI
      // elements (live-bench: 9/10 trials were undetected without
      // this nudge).
      await wakeupCursor(client);
      const shot = await decodeScreenshot((await client.screenshot()).buffer);
      await saveDebug('origin-shot-postWakeup', shot.buffer);
      const found = findCursorByTemplateSet(shot, tmplSet, {
        verbose: options.verbose,
      });
      if (found) {
        if (options.verbose) {
          console.error(
            `[move-to] template-match found cursor at (${found.position.x},${found.position.y}) score=${found.score.toFixed(3)} (template #${found.templateIndex} of ${tmplSet.length}) — using as origin (skipped probe-and-diff)`,
          );
        }
        return { point: found.position, method: 'detect-then-move' };
      }
      if (options.verbose) {
        console.error(`[move-to] template-match below threshold across ${tmplSet.length} cached template(s); falling through to probe-and-diff`);
      }
    }
    // FALLBACK: locateCursor probe-and-diff. Used when no template is
    // cached yet (first-run) or the template scored below threshold
    // (different wallpaper, very different lighting, etc.).
    const located = await locateCursor(client, {
      probeDelta: 20,
      settleMs: 120,
      // detection.brightnessFloor defaults to 100 inside locateCursor,
      // matching detectMotion's default (works on dimmed-modal contexts).
      maxAttempts: 2,
      verbose: options.verbose,
    });
    if (located) {
      // located.position is the cursor's CURRENT position (post-probe);
      // locateCursor no longer attempts a fake restore. Move-to plans
      // its open-loop emission from this position.
      return { point: located.position, method: 'detect-then-move' };
    }
    if (options.verbose) {
      console.error('[move-to] template-match AND locateCursor both failed');
    }
    if (options.forbidSlamFallback) {
      throw new Error(
        'moveToPixel: detect-then-move failed (motion-diff and template-match both ' +
        'returned no cursor) and slam fallback forbidden (forbidSlamFallback=true, set ' +
        'when target is iPad to avoid hot-corner re-lock). ' +
        'Try waking the iPad first, or pass strategy="assume-at" with assumeCursorAt.',
      );
    }
    if (options.verbose) console.error('[move-to] detect-then-move failed; falling back to slam');
  }

  // Auto-detect iPad bounds for the slam origin if not explicitly set,
  // so landscape and non-default-letterbox iPads work without configuration.
  // Fast path: if we already have a sane cached detection from earlier in
  // this process, reuse it instead of re-decoding + re-scanning a fresh
  // screenshot (~50 ms saving per call on tight loops).
  let slamOrigin = options.slamOriginPx;
  if (!slamOrigin) {
    let bounds = getLastGoodBounds();
    if (bounds) {
      if (options.verbose) {
        console.error(
          `[move-to] using cached ${bounds.orientation} bounds ${bounds.width}×${bounds.height} (no re-detection)`,
        );
      }
    } else {
      bounds = await detectBoundsOrNull(client, {
        verbose: options.verbose,
        logPrefix: 'move-to',
      });
    }
    if (bounds) {
      slamOrigin = slamOriginFromBounds(bounds);
      if (options.verbose) {
        console.error(
          `[move-to] auto-detected ${bounds.orientation} slam-origin (${slamOrigin.x},${slamOrigin.y})`,
        );
      }
    } else {
      slamOrigin = LEGACY_PORTRAIT_SLAM_ORIGIN;
    }
  }

  await slamToCorner(client, {
    calls: options.slamCalls,
    paceMs: options.slamPaceMs,
    corner: 'top-left',
    verbose: options.verbose,
  });
  return { point: slamOrigin, method: 'slam-then-move' };
}

// ============================================================================
// Chunked relative emission
// ============================================================================

async function emitChunked(
  client: PiKVMClient,
  totalX: number,
  totalY: number,
  chunkMag: number,
  chunkPaceMs: number,
): Promise<number> {
  let remX = Math.abs(totalX);
  let remY = Math.abs(totalY);
  const sx = Math.sign(totalX);
  const sy = Math.sign(totalY);
  let chunks = 0;
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(chunkMag, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(chunkMag, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    chunks++;
    if (chunkPaceMs > 0 && (remX > 0 || remY > 0)) await sleep(chunkPaceMs);
  }
  return chunks;
}

// ============================================================================
// Motion diff — find a cursor pair whose displacement matches a commanded
// move, anchored by a known starting neighbourhood and a predicted landing.
// ============================================================================

interface MotionPair {
  pre: Cluster;
  post: Cluster;
  displacement: { x: number; y: number };
  livePxPerMickey: number;
}

/** Return shape for `detectMotion`. On success carries the pair; on
 *  failure carries a structured reason so callers can surface it in
 *  diagnostics rather than silently trusting prediction. */
interface MotionDiffResult {
  pair: MotionPair | null;
  /** Compact human-readable failure reason; null on success. Rendered into
   *  CorrectionPass.reason and the [move-to] WARN log line. */
  reason: string | null;
  /** Cluster bookkeeping for diagnostics. */
  rawClusters: number;
  sizedClusters: number;
  preCandidates: number;
  postCandidates: number;
}

/** Exported for unit tests. Not part of the public MCP tool surface.
 *
 *  `requireAchromatic` (Phase 1): when true, sized clusters whose mean
 *  RGB has a saturation > 40 (i.e. one channel ≥ 40 brighter than the
 *  darkest) are rejected before pair scoring. iPadOS cursor is gray
 *  (R≈G≈B); colored animated widgets (clock-second hand, weather icons)
 *  produce chromatic clusters that this filter removes. Default false
 *  for backward compat with existing tests; `moveToPixel` enables it
 *  for iPad use.
 *
 *  `template` (Phase 2): when provided, every valid candidate pair has
 *  its post-cluster region scored against the template; the combined
 *  geometric+template score re-ranks pair selection. Lets a slightly-
 *  worse-positioned but template-matching pair beat a better-positioned
 *  but template-mismatching pair (e.g. icon-corner geometry beating the
 *  real cursor on noisy home-screen diffs). */
export function detectMotion(
  a: DecodedScreenshot,
  b: DecodedScreenshot,
  expectedStart: { x: number; y: number },
  expectedEnd: { x: number; y: number },
  commandedMickeys: { x: number; y: number },
  preWindow: number,
  postWindow: number,
  verbose: boolean,
  clusterMin: number = 8,
  clusterMax: number = 90,
  brightnessFloor: number = 100,
  requireAchromatic: boolean = false,
  templates: CursorTemplate[] = [],
): MotionDiffResult {
  // brightnessFloor lowered from 170 → 100. Cursor pixels rendered over
  // a dimmed-modal scrim or a dark wallpaper land in 100–160 range; the
  // 170 floor was rejecting them entirely and motion-diff returned zero
  // clusters. 100 still rejects most non-cursor noise (dark UI elements
  // are below 100 per channel) while catching cursor on dim contexts.
  // Verified empirically with a frame-by-frame trace 2026-04-25.
  const clusters = diffScreenshotsDecoded(a, b, {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor,
    mergeRadius: 18,
  });

  // Cursor is typically 15-50 px steady, can blur to ~70 px during fast
  // bursts. Tighten this range to reject iPadOS pointer-effect highlights
  // on icons (which are 100+ px) and widget animations (variable).
  const sized = clusters.filter((c) => c.pixels >= clusterMin && c.pixels <= clusterMax);

  const dist = (c: Cluster, p: { x: number; y: number }) =>
    Math.hypot(c.centroidX - p.x, c.centroidY - p.y);

  const preCandidatesWindow = sized.filter((c) => dist(c, expectedStart) <= preWindow);
  let postCandidates = sized.filter((c) => dist(c, expectedEnd) <= postWindow);

  // Phase 1: optional cluster-level achromatic filter applied to POST
  // candidates only. The post-cluster's mean colour comes from frame B
  // at cursor pixels — for the cursor it's gray (R≈G≈B); for a colored
  // widget animation it's the widget's chromatic colour. The PRE cluster's
  // mean is whatever was underneath (often the wallpaper, possibly
  // chromatic) so filtering pre would reject real cursors over colored
  // wallpapers. Filtering at the CLUSTER level — not pixel level — keeps
  // anti-aliased cursor edges intact.
  if (requireAchromatic) {
    const before = postCandidates.length;
    postCandidates = postCandidates.filter((c) => {
      if (c.meanR === undefined || c.meanG === undefined || c.meanB === undefined) {
        return true; // no color info → don't filter
      }
      const sat = Math.max(c.meanR, c.meanG, c.meanB) -
        Math.min(c.meanR, c.meanG, c.meanB);
      return sat <= 40;
    });
    if (verbose) {
      console.error(
        `[motion] achromatic filter: ${before} post-candidates → ${postCandidates.length} achromatic`,
      );
    }
  }

  // Fallback: if the windowed pre-search came up empty but we have
  // multiple sized clusters, the cursor probably wasn't where we
  // expected (slam mis-anchored, prior trial drifted, modal trapping,
  // etc.). Open the pre-pool to ALL sized clusters; the direction +
  // magnitude validation downstream still keeps bad pairs out.
  let preCandidates = preCandidatesWindow;
  let preWindowExpanded = false;
  if (preCandidatesWindow.length === 0 && sized.length >= 2) {
    preCandidates = sized;
    preWindowExpanded = true;
  }

  if (verbose) {
    console.error(
      `[motion] ${clusters.length} total, ${sized.length} cursor-sized [${clusterMin}-${clusterMax}px]; ` +
        `pre-cands(window=${preWindow}@${Math.round(expectedStart.x)},${Math.round(expectedStart.y)})=${preCandidatesWindow.length}` +
        `${preWindowExpanded ? ` →expanded to ${preCandidates.length} (no pre in window)` : ''}, ` +
        `post-cands(window=${postWindow}@${Math.round(expectedEnd.x)},${Math.round(expectedEnd.y)})=${postCandidates.length}`,
    );
  }

  const result = (pair: MotionPair | null, reason: string | null): MotionDiffResult => ({
    pair, reason,
    rawClusters: clusters.length,
    sizedClusters: sized.length,
    preCandidates: preCandidates.length,
    postCandidates: postCandidates.length,
  });

  if (sized.length === 0) {
    return result(null, `no clusters in ${clusterMin}-${clusterMax}px size range (raw=${clusters.length})`);
  }
  if (preCandidates.length === 0 && postCandidates.length === 0) {
    return result(null, 'no pre or post candidates within search windows');
  }
  if (preCandidates.length === 0) {
    return result(null, `no pre candidate within ${preWindow}px of expected start (and only ${sized.length} sized cluster total)`);
  }
  if (postCandidates.length === 0) {
    return result(null, `no post candidate within ${postWindow}px of expected end`);
  }

  // Commanded direction in px (approximate — magnitude is approximate
  // because we haven't measured the actual ratio yet; we use direction only
  // for pair validation).
  const expectedDx = expectedEnd.x - expectedStart.x;
  const expectedDy = expectedEnd.y - expectedStart.y;
  const expectedDist = Math.hypot(expectedDx, expectedDy);
  const unit = expectedDist > 0
    ? { x: expectedDx / expectedDist, y: expectedDy / expectedDist }
    : { x: 1, y: 0 };

  const maxMickeys = Math.max(Math.abs(commandedMickeys.x), Math.abs(commandedMickeys.y));

  // Phase 2: collect ALL valid pairs (don't early-bind to best). The
  // template-validation pass below re-ranks them when a template is
  // available; without a template we still pick by max geometric score.
  const validPairs: { pair: MotionPair; geomScore: number; templateScore: number }[] = [];
  for (const pre of preCandidates) {
    for (const post of postCandidates) {
      if (pre === post) continue;
      const dispX = post.centroidX - pre.centroidX;
      const dispY = post.centroidY - pre.centroidY;
      const dispMag = Math.hypot(dispX, dispY);
      if (dispMag < 10) continue; // too short — probably the same cluster or noise

      // Direction must roughly match commanded (dot product along unit).
      const along = dispX * unit.x + dispY * unit.y;
      if (along <= 0) continue;
      // Reject pairs whose direction diverges > 45° from commanded.
      if (along / dispMag < 0.7) continue;

      const livePxPerMickey = maxMickeys > 0 ? dispMag / maxMickeys : 1;
      // Sanity: ratio must be in [0.3, 4] — iPad is ~1-2, anything wilder
      // is probably a bad pair.
      if (livePxPerMickey < 0.3 || livePxPerMickey > 4) continue;

      // Score: prefer pairs whose post is close to expectedEnd AND pre is
      // close to expectedStart, with similar sizes.
      const sizeRatio = Math.max(pre.pixels, post.pixels) /
        Math.max(1, Math.min(pre.pixels, post.pixels));
      if (sizeRatio > 4) continue;

      const geomScore =
        -dist(post, expectedEnd)
        - dist(pre, expectedStart)
        - 30 * Math.log2(sizeRatio);
      validPairs.push({
        pair: {
          pre,
          post,
          displacement: { x: dispX, y: dispY },
          livePxPerMickey,
        },
        geomScore,
        templateScore: 0,
      });
    }
  }

  // Phase 2 + 3: when at least one template is cached, score each
  // candidate's post-cluster region against the WHOLE template set.
  // The combined ranking (geometric + template) lets a slightly-worse-
  // positioned but template-matching pair beat a better-positioned but
  // template-mismatching pair (the home-screen icon-corner failure mode).
  // Multi-template ensures we still recover detection across backdrops
  // the cursor visits during a session.
  if (templates.length > 0 && validPairs.length > 0) {
    for (const cand of validPairs) {
      const tm = findCursorByTemplateSet(b, templates, {
        searchCentre: { x: cand.pair.post.centroidX, y: cand.pair.post.centroidY },
        searchWindow: 30,
        minScore: 0,        // accept anything; we use score for ranking
        step: 2,
      });
      cand.templateScore = tm?.score ?? 0;
    }
  }

  // Combined ranking: geometric score plus 100×templateScore. Template
  // score in [0,1] dominates the geometric (typically [-300, 0] for
  // close-to-expected pairs) when present.
  let best: { pair: MotionPair; score: number; templateScore: number } | null = null;
  for (const cand of validPairs) {
    const total = cand.geomScore + cand.templateScore * 100;
    if (!best || total > best.score) {
      best = {
        pair: cand.pair,
        score: total,
        templateScore: cand.templateScore,
      };
    }
  }

  if (verbose && best) {
    const tmplPart = templates.length > 0
      ? ` template=${best.templateScore.toFixed(3)}`
      : '';
    console.error(
      `[motion] picked pre=(${best.pair.pre.centroidX},${best.pair.pre.centroidY},${best.pair.pre.pixels}px) ` +
        `post=(${best.pair.post.centroidX},${best.pair.post.centroidY},${best.pair.post.pixels}px) ` +
        `disp=(${best.pair.displacement.x},${best.pair.displacement.y}) ratio=${best.pair.livePxPerMickey.toFixed(3)}${tmplPart}`,
    );
  }

  if (best) return result(best.pair, null);
  return result(null, `${preCandidates.length}×${postCandidates.length} cands considered, no pair passed direction/sanity filters`);
}

// ============================================================================
// Main entry
// ============================================================================

export async function moveToPixel(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: MoveToOptions = {},
): Promise<MoveToResult> {
  const resolution = await client.getResolution(true);

  // Phase B defaults — tuned from live observation of this iPad:
  // - fallback 1.3 → 1.0  (the linear-region value)
  // - minResidualPx 25 → 8
  // - maxCorrectionPasses 2 → 5
  // - cluster filter 10-60 → 8-90 (handles motion blur on fast bursts)
  // - ratio clamp [0.5, 3] → [0.3, 5] (don't reject real bursts)
  const fallback = options.fallbackPxPerMickey ?? 1.0;
  const chunkMag = options.chunkMagnitude ?? 60;
  const chunkPaceMs = options.chunkPaceMs ?? 20;
  const postSettleMs = options.postMoveSettleMs ?? 30;
  const doCorrect = options.correct !== false;
  const maxPasses = options.maxCorrectionPasses ?? 5;
  const minResidualPx = options.minResidualPx ?? 8;
  const warmupMickeys = options.warmupMickeys ?? 8;
  const preWindow = options.preWindow ?? 120;
  const postWindow = options.postWindow ?? 600;
  const verbose = options.verbose ?? false;
  const ratioLo = options.ratioClampLo ?? 0.3;
  const ratioHi = options.ratioClampHi ?? 5;
  // Phase C: linear-region approach knobs.
  const linChunkMag = options.linearChunkMagnitude ?? 8;
  const linChunkPaceMs = options.linearChunkPaceMs ?? 60;
  const linTriggerPx = options.linearTriggerResidualPx ?? 100;
  const linResidualPx = options.linearResidualPx ?? 3;
  const linMaxPasses = options.linearMaxPasses ?? 4;
  // Cursor cluster size range (Phase B): widened from 10-60 to 8-90.
  const clusterMin = 8;
  const clusterMax = 90;

  // Phase B: validate ballistics profile freshness against current
  // resolution. A profile measured on a different device silently
  // mis-predicts every move; better to drop it and warn.
  let profile: BallisticsProfile | null = options.profile ?? null;
  if (profile) {
    const profileRes = profile.resolution;
    if (!profileIsFreshFor(profile, resolution)) {
      if (verbose) {
        console.error(
          `[move-to] WARN profile resolution ${profileRes.width}×${profileRes.height} ` +
            `does not match current ${resolution.width}×${resolution.height}; dropping profile, using fallback ${fallback}`,
        );
      }
      profile = null;
    }
  }

  const pxPerMickeyX =
    (profile && lookupPxPerMickey(profile, 'x', chunkMag, 'slow')) ?? fallback;
  const pxPerMickeyY =
    (profile && lookupPxPerMickey(profile, 'y', chunkMag, 'slow')) ?? fallback;

  const targetX = clamp(Math.round(target.x), 0, resolution.width - 1);
  const targetY = clamp(Math.round(target.y), 0, resolution.height - 1);

  // 1. Origin discovery
  const discovered = await discoverOrigin(client, options);
  const origin = discovered.point;
  const actualStrategy = discovered.method;

  const dxPx = targetX - origin.x;
  const dyPx = targetY - origin.y;
  const rawMickeysX = Math.round(Math.abs(dxPx) / pxPerMickeyX);
  const rawMickeysY = Math.round(Math.abs(dyPx) / pxPerMickeyY);
  const signX = dxPx >= 0 ? 1 : -1;
  const signY = dyPx >= 0 ? 1 : -1;

  const predicted = {
    x: origin.x + signX * rawMickeysX * pxPerMickeyX,
    y: origin.y + signY * rawMickeysY * pxPerMickeyY,
  };

  // 2. Calibration probe — measure iPadOS effective px/mickey ratio
  //    fresh BEFORE the open-loop emission. iPadOS pointer acceleration
  //    varies per-context (1.0–1.7× observed live). The original code
  //    only learned ratio AFTER the open-loop emission, by which point
  //    a 1.0-vs-1.5 mismatch had already over-shot the target by 250+ px.
  //
  //    Probe: emit `calibProbeMickeys` (default 40) along the dominant
  //    axis at slow pace, diff against pre-probe screenshot. The detected
  //    cluster pair gives us a real px/mickey for THIS device + THIS
  //    context. If diff fails, fall through to fallback ratio.
  const calibProbeMickeys = options.calibrationProbeMickeys ?? 40;
  const warmupAxis: Axis = Math.abs(dxPx) >= Math.abs(dyPx) ? 'x' : 'y';
  const warmupSign = warmupAxis === 'x' ? signX : signY;

  let calibratedRatioX = pxPerMickeyX;
  let calibratedRatioY = pxPerMickeyY;
  let calibrationReason: string = `using fallback ratio ${fallback}`;

  // Phase 2 + 3: fetch the cached cursor template SET once. Passed to
  // every detectMotion call so it can re-rank candidate pairs by template
  // match. Empty array if no templates have been captured yet (first-run).
  const sessionTemplates = await getCachedTemplates();

  // shotA-pre captured BEFORE the calibration probe; shotA captured AFTER.
  // diff(shotA-pre, shotA) measures the calibration probe's effect.
  const shotAPre = await decodeScreenshot((await client.screenshot()).buffer);

  const calibX = warmupAxis === 'x' ? calibProbeMickeys * warmupSign : 0;
  const calibY = warmupAxis === 'y' ? calibProbeMickeys * warmupSign : 0;
  if (calibProbeMickeys > 0) {
    // Emit calibration probe slow + chunked so the diff reliably catches
    // both pre and post cursor positions.
    await emitChunked(client, calibX, calibY, 20, 30);
    await sleep(150);
  }

  // 3. Screenshot A — captured AFTER calibration probe. shotAPre vs shotA
  //    yields calibration ratio; shotA vs shotB yields open-loop ratio.
  const shotA = await decodeScreenshot((await client.screenshot()).buffer);

  // postWarmupExpected: where the cursor is now, after the calibration
  // probe. Initial estimate uses fallback ratio; will be refined if
  // calibration succeeds.
  const calibExpectedEnd = {
    x: origin.x + calibX * pxPerMickeyX,
    y: origin.y + calibY * pxPerMickeyY,
  };

  if (calibProbeMickeys > 0 && doCorrect) {
    const calibResult = detectMotion(
      shotAPre,
      shotA,
      origin,
      calibExpectedEnd,
      { x: calibX, y: calibY },
      preWindow,
      Math.max(postWindow, 200),
      verbose,
      clusterMin,
      clusterMax,
      100,                  // brightnessFloor (default)
      true,                 // requireAchromatic — Phase 1
      sessionTemplates,     // Phase 2 + 3: template-validated pair selection (multi-template)
    );
    if (calibResult.pair) {
      const measured = calibResult.pair.livePxPerMickey;
      if (measured >= ratioLo && measured <= ratioHi) {
        calibratedRatioX = warmupAxis === 'x' ? measured : calibratedRatioX;
        calibratedRatioY = warmupAxis === 'y' ? measured : calibratedRatioY;
        // Apply same ratio to other axis as a best guess (acceleration
        // typically symmetric across X/Y in iPadOS).
        if (warmupAxis === 'x') calibratedRatioY = measured;
        else calibratedRatioX = measured;
        calibrationReason = `calibration probe measured ratio ${measured.toFixed(3)} on ${warmupAxis}-axis (using for both)`;
        if (verbose) {
          console.error(
            `[move-to] CALIBRATION: ${calibProbeMickeys}-mickey ${warmupAxis} probe measured ratio=${measured.toFixed(3)} (was using fallback ${fallback})`,
          );
        }
      } else {
        calibrationReason = `calibration ratio ${measured.toFixed(3)} out of [${ratioLo}, ${ratioHi}] sanity range; falling back`;
      }
    } else {
      calibrationReason = `calibration probe diff failed: ${calibResult.reason}; falling back`;
    }
  }

  // Re-plan open-loop using calibrated ratio.
  const dxPxNow = targetX - (origin.x + calibX * calibratedRatioX);
  const dyPxNow = targetY - (origin.y + calibY * calibratedRatioY);
  const planRatioX = calibratedRatioX;
  const planRatioY = calibratedRatioY;
  const rawMickeysXNow = Math.round(Math.abs(dxPxNow) / planRatioX);
  const rawMickeysYNow = Math.round(Math.abs(dyPxNow) / planRatioY);
  const signXNow = dxPxNow >= 0 ? 1 : -1;
  const signYNow = dyPxNow >= 0 ? 1 : -1;

  const postCalibPos = {
    x: origin.x + calibX * calibratedRatioX,
    y: origin.y + calibY * calibratedRatioY,
  };
  // Phase 6: clamp open-loop to keep projected cursor landing inside
  // the screen. iPad ratio variance (1.0–2.0× observed) means a stale
  // ratio can plan an emission that pushes the cursor off-screen, which
  // loses motion-diff (no post cluster) and template-match (no cursor
  // pixels). Clamp keeps cursor in-frame so verification can recover.
  const clampedOpen = clampMickeysToScreen(
    postCalibPos,
    signXNow * rawMickeysXNow,
    signYNow * rawMickeysYNow,
    planRatioX,
    planRatioY,
    { width: resolution.width, height: resolution.height },
  );
  const openMickeysX = clampedOpen.x;
  const openMickeysY = clampedOpen.y;
  const predictedPostOpen = {
    x: postCalibPos.x + openMickeysX * planRatioX,
    y: postCalibPos.y + openMickeysY * planRatioY,
  };

  const postWarmupExpected = postCalibPos;

  if (verbose && (openMickeysX !== signXNow * rawMickeysXNow || openMickeysY !== signYNow * rawMickeysYNow)) {
    console.error(
      `[move-to] open-loop CLAMPED to keep cursor on-screen: ` +
        `(${signXNow * rawMickeysXNow},${signYNow * rawMickeysYNow}) → (${openMickeysX},${openMickeysY})`,
    );
  }

  // 4. Open-loop emission — uses calibrated ratio + remaining-distance plan.
  const chunkCount = await emitChunked(client, openMickeysX, openMickeysY, chunkMag, chunkPaceMs);

  // Settle briefly so the streamer catches up and cursor is still visible.
  if (postSettleMs > 0) await sleep(postSettleMs);

  // 5. Screenshot B
  const shotB = await decodeScreenshot((await client.screenshot()).buffer);

  // 6. Motion diff (open-loop)
  const corrections: CorrectionPass[] = [];
  const diagnostics: MovePassDiagnostic[] = [];
  let finalDetectedPosition: { x: number; y: number } | null = null;
  let observedRatioX = calibratedRatioX;
  let observedRatioY = calibratedRatioY;
  let currentPos: { x: number; y: number };
  let openLoopMode: 'motion' | 'template' | 'predicted' = 'predicted';
  let openLoopReason: string | null = null;

  // Debug: when debugDir is set, dump every captured frame so failures
  // can be inspected. discoverOrigin already saved 00-origin-shot;
  // here we save the calibration pair + open-loop pair, and per-pass
  // correction shots are saved below.
  const debugDir = options.debugDir ?? null;
  if (debugDir) {
    const fs = await import('fs');
    await fs.promises.mkdir(debugDir, { recursive: true });
    await fs.promises.writeFile(`${debugDir}/01-shotAPre-preCalib.jpg`, shotAPre.buffer);
    await fs.promises.writeFile(`${debugDir}/02-shotA-postCalib.jpg`, shotA.buffer);
    await fs.promises.writeFile(`${debugDir}/03-shotB-postOpenLoop.jpg`, shotB.buffer);
    // Also dump a metadata file describing each frame's context so
    // someone reviewing the screenshots later knows what to look for.
    const meta = [
      `Target: (${targetX},${targetY})`,
      `Origin (claimed): (${Math.round(origin.x)},${Math.round(origin.y)}) via ${actualStrategy}`,
      `Calibration probe: ${calibX} X, ${calibY} Y mickeys`,
      `Calibration result: ${calibrationReason}`,
      `Open-loop emit: ${openMickeysX} X, ${openMickeysY} Y mickeys`,
      `Plan ratio: (${planRatioX.toFixed(3)}, ${planRatioY.toFixed(3)})`,
      `Predicted post-open-loop: (${Math.round(predictedPostOpen.x)},${Math.round(predictedPostOpen.y)})`,
      ``,
      `LOOK FOR:`,
      `  00-origin-shot: cursor at claimed origin (${Math.round(origin.x)},${Math.round(origin.y)})`,
      `  01-shotAPre: cursor pre-calibration-probe`,
      `  02-shotA: cursor post-calibration-probe (after ${calibX}X,${calibY}Y mickeys)`,
      `  03-shotB: cursor post-open-loop (should be near predicted)`,
      `  04+ pass-shotC: cursor post-correction (look at residual)`,
    ].join('\n');
    await fs.promises.writeFile(`${debugDir}/META.txt`, meta);
  }

  const motionResult = doCorrect
    ? detectMotion(
        shotA,
        shotB,
        postWarmupExpected,
        predictedPostOpen,
        { x: openMickeysX, y: openMickeysY },
        preWindow,
        postWindow,
        verbose,
        clusterMin,
        clusterMax,
        100,                  // brightnessFloor (default)
        true,                 // requireAchromatic — Phase 1
        sessionTemplates,     // Phase 2 + 3
      )
    : null;

  if (motionResult && motionResult.pair) {
    const motion = motionResult.pair;
    currentPos = { x: motion.post.centroidX, y: motion.post.centroidY };
    // Update ratios from observed motion (only for the dominant axis).
    if (Math.abs(openMickeysX) > Math.abs(openMickeysY)) {
      observedRatioX = Math.abs(motion.displacement.x) / Math.max(1, Math.abs(openMickeysX));
    } else {
      observedRatioY = Math.abs(motion.displacement.y) / Math.max(1, Math.abs(openMickeysY));
    }
    if (observedRatioX < ratioLo || observedRatioX > ratioHi) observedRatioX = fallback;
    if (observedRatioY < ratioLo || observedRatioY > ratioHi) observedRatioY = fallback;
    finalDetectedPosition = { ...currentPos };
    openLoopMode = 'motion';
    openLoopReason = `live ratio ${motion.livePxPerMickey.toFixed(3)}`;
    await maybePersistTemplate(shotB, currentPos);
  } else {
    // Motion-diff failed. Try template matching as a fallback.
    const motionFailReason = motionResult ? motionResult.reason : 'correction disabled';
    if (verbose && doCorrect) {
      console.error(`[move-to] motion-diff returned null: ${motionFailReason}`);
    }
    if (sessionTemplates.length > 0) {
      const found = findCursorByTemplateSet(shotB, sessionTemplates, {
        searchCentre: predictedPostOpen,
        searchWindow: postWindow,
        // Phase 11: cursor was at postWarmupExpected before the
        // open-loop emit; predictedPostOpen is where it SHOULD be now.
        // Both are plausible anchors for locality ranking — but the
        // real cursor is somewhere along the path between them, not
        // at the iPad UI's stable false-positive locations 200+ px
        // from either. Anchor to predicted landing with a generous
        // radius that covers acceleration variance.
        expectedNear: predictedPostOpen,
        expectedNearRadius: 200,
        verbose,
      });
      if (found) {
        currentPos = found.position;
        finalDetectedPosition = { ...currentPos };
        openLoopMode = 'template';
        openLoopReason = `template-match score=${found.score.toFixed(3)} tpl#${found.templateIndex}/${sessionTemplates.length} (motion: ${motionFailReason})`;
        if (verbose) {
          console.error(
            `[move-to] motion-diff failed; template-match recovered cursor at (${found.position.x},${found.position.y}) score=${found.score.toFixed(3)} via template #${found.templateIndex}/${sessionTemplates.length}`,
          );
        }
      } else {
        currentPos = { ...predictedPostOpen };
        openLoopMode = 'predicted';
        openLoopReason = `template-match below threshold across ${sessionTemplates.length} templates (motion: ${motionFailReason})`;
        if (verbose) {
          console.error(
            `[move-to] WARN open-loop: motion-diff (${motionFailReason}) AND template-match (${sessionTemplates.length} cached) both failed; trusting prediction`,
          );
        }
      }
    } else {
      currentPos = { ...predictedPostOpen };
      openLoopMode = 'predicted';
      openLoopReason = `no template cached (motion: ${motionFailReason})`;
      if (verbose && doCorrect) {
        console.error(
          `[move-to] WARN open-loop: motion-diff failed (${motionFailReason}) and no cursor template cached; trusting prediction`,
        );
      }
    }
  }

  // Track template-match position to catch stable false positives.
  let lastTemplateMatch: { x: number; y: number } | null =
    openLoopMode === 'template' ? { ...currentPos } : null;

  diagnostics.push({
    pass: 0,
    mode: openLoopMode,
    detectedAt: { ...currentPos },
    residualPx: Math.hypot(currentPos.x - targetX, currentPos.y - targetY),
    ratioUsed: { x: observedRatioX, y: observedRatioY },
    reason: openLoopReason,
    linearPhase: false,
  });

  // 7. Correction passes — each diffs before/after its own delta.
  let prevShot = shotB;
  let prevPos = currentPos;
  let linearEntered = false;
  let totalPasses = 0;

  if (doCorrect) {
    // Combined budget: at most maxPasses gross + linMaxPasses linear.
    // We always ALLOW the linear phase to start once residual drops
    // below the trigger; it has its own pass budget.
    let grossPassesUsed = 0;
    let linearPassesUsed = 0;

    while (true) {
      const errX = targetX - currentPos.x;
      const errY = targetY - currentPos.y;
      const residual = Math.hypot(errX, errY);

      // Decide which regime we're in. Phase C: enter linear region as
      // soon as residual is small enough that small/slow chunks can
      // span it without acceleration kicking in.
      const useLinear = residual <= linTriggerPx;
      const passLimit = useLinear ? linMaxPasses : maxPasses;
      const passUsed = useLinear ? linearPassesUsed : grossPassesUsed;
      const stopPx = useLinear ? linResidualPx : minResidualPx;
      const usedChunkMag = useLinear ? linChunkMag : chunkMag;
      const usedChunkPaceMs = useLinear ? linChunkPaceMs : chunkPaceMs;

      if (residual < stopPx) {
        if (verbose) {
          console.error(
            `[move-to] pass ${totalPasses}: residual ${residual.toFixed(1)}px within ${useLinear ? 'linear' : 'gross'} tolerance ${stopPx}px; done.`,
          );
        }
        break;
      }
      if (passUsed >= passLimit) {
        if (verbose) {
          console.error(
            `[move-to] ${useLinear ? 'linear' : 'gross'} pass budget exhausted at ${passLimit}; remaining residual ${residual.toFixed(1)}px`,
          );
        }
        break;
      }

      if (useLinear && !linearEntered) {
        linearEntered = true;
        if (verbose) {
          console.error(
            `[move-to] entering LINEAR phase: residual=${residual.toFixed(1)}px ≤ ${linTriggerPx}px; ` +
              `chunkMag=${linChunkMag} pace=${linChunkPaceMs}ms target≤${linResidualPx}px`,
          );
        }
      }

      const rawCorrX = Math.round(errX / observedRatioX);
      const rawCorrY = Math.round(errY / observedRatioY);
      // Phase 9: cap a single correction-pass emission so a stale ratio
      // can't run away. Live data: 1/3 trials emitted (-13, +105) Y
      // mickeys → 553 px overshoot when motion-diff was blind. Cap is
      // tighter in linear mode (small careful steps) than gross.
      const correctionCap = useLinear ? 25 : 80;
      const capped = capCorrectionMickeys(rawCorrX, rawCorrY, correctionCap);
      const corrMickeysX = capped.x;
      const corrMickeysY = capped.y;
      if (corrMickeysX === 0 && corrMickeysY === 0) {
        if (verbose) console.error(`[move-to] pass ${totalPasses + 1}: zero-mickey correction; cannot improve further.`);
        break;
      }
      if (verbose && (corrMickeysX !== rawCorrX || corrMickeysY !== rawCorrY)) {
        console.error(
          `[move-to] pass ${totalPasses + 1}: capped (${rawCorrX},${rawCorrY}) → (${corrMickeysX},${corrMickeysY}) at ${correctionCap}`,
        );
      }

      const newPredicted = {
        x: currentPos.x + corrMickeysX * observedRatioX,
        y: currentPos.y + corrMickeysY * observedRatioY,
      };

      if (verbose) {
        console.error(
          `[move-to] ${useLinear ? 'linear' : 'gross'} pass ${totalPasses + 1}: ` +
            `err=(${errX.toFixed(1)},${errY.toFixed(1)}) → mickeys=(${corrMickeysX},${corrMickeysY}) ` +
            `@ ratio=(${observedRatioX.toFixed(3)},${observedRatioY.toFixed(3)}) chunk=${usedChunkMag} pace=${usedChunkPaceMs}ms`,
        );
      }

      await emitChunked(client, corrMickeysX, corrMickeysY, usedChunkMag, usedChunkPaceMs);
      await sleep(postSettleMs);
      const shotC = await decodeScreenshot((await client.screenshot()).buffer);
      if (debugDir) {
        const tag = String(totalPasses + 1).padStart(2, '0');
        const phaseTag = useLinear ? 'L' : 'G';
        await import('fs').then((fs) =>
          fs.promises.writeFile(`${debugDir}/${tag}-${phaseTag}-pass-shotC.jpg`, shotC.buffer)
        );
      }

      const cResult = detectMotion(
        prevShot,
        shotC,
        prevPos,
        newPredicted,
        { x: corrMickeysX, y: corrMickeysY },
        preWindow,
        postWindow,
        verbose,
        clusterMin,
        clusterMax,
        100,                  // brightnessFloor (default)
        true,                 // requireAchromatic — Phase 1
        sessionTemplates,     // Phase 2 + 3
      );

      let passMode: 'motion' | 'template' | 'predicted' = 'predicted';
      let passReason: string | null = null;

      if (cResult.pair) {
        const cMotion = cResult.pair;
        currentPos = { x: cMotion.post.centroidX, y: cMotion.post.centroidY };
        if (Math.abs(corrMickeysX) > Math.abs(corrMickeysY)) {
          const r = Math.abs(cMotion.displacement.x) / Math.max(1, Math.abs(corrMickeysX));
          if (r >= ratioLo && r <= ratioHi) observedRatioX = r;
        } else {
          const r = Math.abs(cMotion.displacement.y) / Math.max(1, Math.abs(corrMickeysY));
          if (r >= ratioLo && r <= ratioHi) observedRatioY = r;
        }
        finalDetectedPosition = { ...currentPos };
        passMode = 'motion';
        passReason = `live ratio ${cMotion.livePxPerMickey.toFixed(3)}`;
      } else {
        // Motion-diff failed on correction — try template match before
        // falling back to prediction.
        const motionFailReason = cResult.reason ?? 'unknown';
        let templated = false;
        if (sessionTemplates.length > 0) {
          const found = findCursorByTemplateSet(shotC, sessionTemplates, {
            searchCentre: newPredicted,
            searchWindow: postWindow,
            // Phase 11: small correction emits move the cursor only a
            // few tens of pixels. The cursor is near `prevPos`
            // (last-known-good position), not at iPad UI false-positive
            // locations far away. Anchor selection there.
            expectedNear: prevPos,
            expectedNearRadius: 100,
            verbose,
          });
          if (found) {
            // Stable false-positive guard: if template-match returns the
            // same spot it returned last pass after we emitted significant
            // mickeys, the match is not the cursor — the cursor moved.
            const emittedMag = Math.hypot(corrMickeysX, corrMickeysY);
            if (isStaleTemplateMatch(found.position, lastTemplateMatch, emittedMag)) {
              if (verbose) {
                console.error(
                  `[move-to] WARN pass ${totalPasses + 1}: template-match returned stale position (${found.position.x},${found.position.y}) after ${emittedMag.toFixed(0)} mickeys emitted — rejecting as stable false positive`,
                );
              }
              passMode = 'predicted';
              passReason = `template-match stale at (${found.position.x},${found.position.y}) after ${emittedMag.toFixed(0)} mickeys`;
              currentPos = newPredicted;
              templated = true;
            } else {
              currentPos = found.position;
              finalDetectedPosition = { ...currentPos };
              lastTemplateMatch = { ...found.position };
              passMode = 'template';
              passReason = `template score=${found.score.toFixed(3)} (motion: ${motionFailReason})`;
              templated = true;
              if (verbose) {
                console.error(
                  `[move-to] WARN pass ${totalPasses + 1}: motion-diff failed (${motionFailReason}); template-match recovered cursor at (${found.position.x},${found.position.y}) score=${found.score.toFixed(3)}`,
                );
              }
            }
          }
        }
        if (!templated) {
          currentPos = newPredicted;
          passMode = 'predicted';
          passReason = `motion: ${motionFailReason}; no template fallback`;
          if (verbose) {
            console.error(
              `[move-to] WARN pass ${totalPasses + 1}: motion-diff failed (${motionFailReason}) AND template-match unavailable; trusting prediction`,
            );
          }
        }
      }

      corrections.push({
        detectedCursor: cResult.pair
          ? { x: cResult.pair.post.centroidX, y: cResult.pair.post.centroidY }
          : { x: Math.round(currentPos.x), y: Math.round(currentPos.y) },
        livePxPerMickey: cResult.pair?.livePxPerMickey ?? (observedRatioX + observedRatioY) / 2,
        correctionMickeys: { x: corrMickeysX, y: corrMickeysY },
        mode: passMode,
        reason: passReason,
      });

      diagnostics.push({
        pass: totalPasses + 1,
        mode: passMode,
        detectedAt: { ...currentPos },
        residualPx: Math.hypot(currentPos.x - targetX, currentPos.y - targetY),
        ratioUsed: { x: observedRatioX, y: observedRatioY },
        reason: passReason,
        linearPhase: useLinear,
      });

      prevShot = shotC;
      prevPos = currentPos;
      totalPasses++;
      if (useLinear) linearPassesUsed++;
      else grossPassesUsed++;

      // Phase 4: blind-pass circuit breaker. After 2 consecutive
      // predicted-mode passes (motion-diff blind AND template-match
      // unable to recover), every further emission shifts currentPos by
      // an unverified prediction whose ratio may be stale — error
      // compounds. Bail out and trust the last verified position rather
      // than burn budget overshooting.
      if (shouldAbortBlindCorrections(diagnostics)) {
        if (verbose) {
          console.error(
            `[move-to] CIRCUIT BREAKER: 2 consecutive predicted passes; aborting correction loop to avoid compounding overshoot. residual=${diagnostics[diagnostics.length - 1].residualPx.toFixed(1)}px`,
          );
        }
        break;
      }
    }
  }

  const shot = await client.screenshot();

  const finalResidualPx = finalDetectedPosition
    ? Math.hypot(finalDetectedPosition.x - targetX, finalDetectedPosition.y - targetY)
    : null;

  const parts: string[] = [];
  parts.push(`Target (${targetX},${targetY}).`);
  parts.push(`Origin via ${actualStrategy} at (${Math.round(origin.x)},${Math.round(origin.y)}).`);
  parts.push(
    `Open-loop emitted ${Math.abs(openMickeysX)}X+${Math.abs(openMickeysY)}Y mickeys in ${chunkCount} chunk(s); ` +
      `default px/mickey=(${pxPerMickeyX.toFixed(2)},${pxPerMickeyY.toFixed(2)}).`,
  );
  parts.push(`Open-loop landing via ${openLoopMode}: ${openLoopReason ?? 'n/a'}.`);
  if (corrections.length > 0) {
    const grossCount = corrections.filter((_, i) => !diagnostics[i + 1]?.linearPhase).length;
    const linearCount = corrections.length - grossCount;
    parts.push(
      `${corrections.length} correction pass(es) (${grossCount} gross, ${linearCount} linear); ` +
        `last applied (${corrections[corrections.length - 1].correctionMickeys.x},${corrections[corrections.length - 1].correctionMickeys.y}) mickeys.`,
    );
    const lastFailures = corrections.filter((c) => c.mode !== 'motion').length;
    if (lastFailures > 0) {
      parts.push(`${lastFailures}/${corrections.length} pass(es) used template/predicted fallback (motion-diff blind).`);
    }
  }
  if (linearEntered) {
    parts.push(`Linear approach engaged; final ratio ≈ (${observedRatioX.toFixed(2)}, ${observedRatioY.toFixed(2)}).`);
  }
  if (finalDetectedPosition && finalResidualPx !== null) {
    parts.push(
      `Final cursor at (${finalDetectedPosition.x},${finalDetectedPosition.y}); ` +
        `residual (${finalDetectedPosition.x - targetX},${finalDetectedPosition.y - targetY}) = ${finalResidualPx.toFixed(1)}px.`,
    );
  } else if (doCorrect) {
    parts.push('Final position not detected — click accuracy uncertain.');
  }
  if (actualStrategy === 'slam-then-move' && options.strategy === 'detect-then-move') {
    parts.push('WARNING: detect-origin fell back to slam; iPad may have re-locked via hot corner.');
  }

  return {
    screenshot: shot.buffer,
    screenshotWidth: shot.screenshotWidth,
    screenshotHeight: shot.screenshotHeight,
    target: { x: targetX, y: targetY },
    predicted: predictedPostOpen,
    emittedMickeys: { x: Math.abs(openMickeysX), y: Math.abs(openMickeysY) },
    usedPxPerMickey: { x: observedRatioX, y: observedRatioY },
    chunkCount,
    strategy: actualStrategy,
    corrections,
    diagnostics,
    finalDetectedPosition,
    finalResidualPx,
    resolution,
    message: parts.join(' '),
  };
}
