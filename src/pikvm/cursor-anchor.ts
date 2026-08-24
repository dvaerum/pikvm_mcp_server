/**
 * Unified cursor-anchoring primitive: slam-to-corner + safety guard +
 * optional verification + optional recovery.
 *
 * Consolidates what used to be 3 independently-evolving copies of this
 * logic: move-to.ts's `discoverOrigin` (Layers 1/2/3 iPad-lock guard),
 * ipad-unlock.ts's `unlockIpad` + `ipadGoHome` (verify + key-sequence
 * recovery), and ballistics.ts's `measureCell` (no guard, synthetic-scene
 * calibration slam). See docs/troubleshooting/ipad-safety-guards.md for
 * the hot-corner-lock failure mode the guard exists to prevent.
 *
 * Migrated call-site by call-site, each gated on real hardware before the
 * next: move-to.ts first (highest traffic), then ipad-unlock.ts's two
 * call sites, then ballistics.ts last. See git history / PR descriptions
 * for the per-call-site gate results.
 */

import { PiKVMClient } from './client.js';
import {
  Axis,
  Corner,
  cornerTargetFromBounds,
  cornerTargetPx,
  cornerVector,
  nudgeFromEdge,
  slamToCorner,
} from './ballistics.js';
import { Cluster, DEFAULT_DETECTION_CONFIG, DetectionConfig, diffScreenshots } from './cursor-detect.js';
import {
  detectBoundsOrNull,
  getLastGoodBounds,
  IpadBounds,
  LEGACY_PORTRAIT_SLAM_ORIGIN,
  slamOriginFromBounds,
} from './orientation.js';
import { sleep } from './util.js';

export type AnchorGuard =
  // Layers 1/2/3 (docs/troubleshooting/ipad-safety-guards.md): refuses to
  // slam when the target looks like (or might be) an iPad-portrait
  // letterbox, unless the caller passed an explicit slamOriginPx. Throws
  // on refusal — this is move-to.ts's discoverOrigin behavior today.
  | {
      kind: 'bounds-guard';
      /** move-to.ts's forbidSlamOnIpad=false opt-out. Gates ONLY the
       *  refusal-throw — origin computation (cache-first via
       *  getLastGoodBounds(), else fresh detection, else LEGACY_PORTRAIT
       *  fallback) is identical either way. This matters because
       *  forbidSlamOnIpad:false isn't a rare test escape hatch: hid-mode.ts's
       *  policy() sets it for every real desktop/absolute-mouse target, so
       *  silently dropping the cache path here would be a live perf
       *  regression, not just a guard-semantics change. Default false
       *  (today's always-refuse-on-undetermined behavior). */
      allowOnUndetermined?: boolean;
    }
  // Layer 5: caller has already established slamming is safe (e.g. a lock
  // screen has no active hot corner) and takes responsibility. Never
  // throws on the safety question — unlockIpad, ipadGoHome.
  | { kind: 'caller-asserted'; reason: string }
  // measureCell: synthetic calibration scene, no iPad-lock risk, no guard.
  | { kind: 'none-calibration' };

export type AnchorRecovery =
  | { kind: 'none' }
  // unlockIpad's Esc→Enter→Space, then re-attempt the slam+verify once.
  | { kind: 'key-sequence-retry' }
  // ipadGoHome's Phase-231 Esc+Enter. No re-attempt — caller inspects the
  // returned screenshot itself, matching ipadGoHome's existing messaging.
  | { kind: 'defensive-keys' };

export interface AnchorRequest {
  client: PiKVMClient;
  /** Corner to slam to. Default 'top-left' — the only corner any current
   *  call site uses, but kept general rather than hardcoded. */
  corner?: Corner;
  /** REQUIRED, no default — a new call site can't compile without naming
   *  its safety posture. */
  guard: AnchorGuard;
  /**
   * ADR 0001 (docs/adr/0001-do-not-merge-cursor-detection-and-calibration-
   * sampling-lookalikes.md): three real takeRawScreenshot variants exist on
   * purpose and must not be merged — cursor-detect.ts's exported version
   * wake-nudges before capture (±1 px, keeps the auto-fading iPad cursor
   * visible), ballistics.ts's and auto-calibrate.ts's private versions
   * deliberately don't (a nudge right before a calibration/ballistics
   * capture would contaminate the very displacement being measured).
   *
   * REQUIRED, no default: an optional param defaulting to the only
   * *exported* variant (the "natural" default) would silently contaminate
   * every ballistics measurement — a numeric regression no test catches,
   * only a live N≥80 bench would ever surface it. Pass the non-nudging
   * capture for calibration-adjacent call sites; read ADR 0001 before
   * relaxing this.
   */
  screenshot: (client: PiKVMClient) => Promise<Buffer>;
  /** Whether anchorCursor takes a before/after screenshot pair (via
   *  `screenshot`) to compute `verified` at all. Default false: `verified`
   *  stays null, `screenshot` is never called for this purpose, `selfGate`
   *  is irrelevant (nothing to gate on). This is the zero-cost path —
   *  move-to.ts's bounds-guard migration relies on the default to stay
   *  byte-for-byte behavior-identical to today (no new round trips). */
  captureVerification?: boolean;
  /**
   * Whether anchorCursor itself acts on a failed verification — throws (no
   * `recovery` configured) or runs `recovery`. NOT whether verification is
   * computed: when `captureVerification` is true, `verified` is always
   * populated regardless of this flag. Callers that want to read the
   * result and decide for themselves (measureCell, matching #62's
   * existing reject-the-cell-no-retry behavior) set this false and inspect
   * `AnchorResult.verified` on their own. Default true. Irrelevant when
   * `captureVerification` is false (nothing computed to gate on).
   */
  selfGate?: boolean;
  /** Default { kind: 'none' }. */
  recovery?: AnchorRecovery;
  /** Post-slam nudge away from the slammed corner, past iPadOS's edge dead
   *  zone, so the cursor sits in open space (measureCell's use case — the
   *  ballistics sweep needs room to travel). Runs after verification/
   *  recovery, using nudgeFromEdge's own built-in call-count/pace. Pass
   *  false or omit to skip. */
  nudge?: { away?: Corner; onlyAxis?: Axis } | false;
  slamCalls?: number;
  paceMs?: number;
  /** Tolerance (px) for the post-slam "landed near corner" check. Only
   *  used when `captureVerification` is true. Default 80 (matches
   *  slamToCorner's own SlamOptions.cornerTolerance default). */
  cornerTolerance?: number;
  /** Caller-supplied slam origin. Also the bounds-guard escape hatch: an
   *  explicit slamOriginPx means the caller has taken responsibility for
   *  where the slam lands, so the iPad-letterbox refusal doesn't apply. */
  slamOriginPx?: { x: number; y: number };
  detection?: Partial<DetectionConfig>;
  verbose?: boolean;
}

export interface AnchorResult {
  /** Post-slam origin in HDMI pixel coordinates. */
  origin: { x: number; y: number };
  /** Result of the post-slam "landed near corner" check. null when
   *  `captureVerification` was false (or defaulted false) — no check ran. */
  verified: boolean | null;
  /** Whether `recovery` ran (verification failed and selfGate was true). */
  recoveryAttempted: boolean;
  /** iPad bounds used to compute `origin`, when detection ran. Null for
   *  guard:'none-calibration' (no detection) or when the caller supplied
   *  slamOriginPx directly (detection skipped). */
  bounds: IpadBounds | null;
}

/**
 * Layers 1/2/3 (docs/troubleshooting/ipad-safety-guards.md), moved
 * verbatim from move-to.ts's discoverOrigin. The thrown error string is
 * intentionally unchanged (including its "moveToPixel:" prefix) — callers
 * pattern-match on it; see cursor-anchor.test.ts's byte-identical
 * assertion.
 */
async function resolveBoundsGuardOrigin(
  req: AnchorRequest,
  guard: Extract<AnchorGuard, { kind: 'bounds-guard' }>,
): Promise<{ origin: { x: number; y: number }; bounds: IpadBounds | null }> {
  const client = req.client;
  let slamOrigin = req.slamOriginPx;
  let detectedBounds: IpadBounds | null = null;
  if (!slamOrigin) {
    detectedBounds = getLastGoodBounds();
    if (detectedBounds) {
      if (req.verbose) {
        console.error(
          `[cursor-anchor] using cached ${detectedBounds.orientation} bounds ${detectedBounds.width}×${detectedBounds.height} (no re-detection)`,
        );
      }
    } else {
      detectedBounds = await detectBoundsOrNull(client, {
        verbose: req.verbose,
        logPrefix: 'cursor-anchor',
      });
    }
    if (detectedBounds) {
      slamOrigin = slamOriginFromBounds(detectedBounds);
      if (req.verbose) {
        console.error(
          `[cursor-anchor] auto-detected ${detectedBounds.orientation} slam-origin (${slamOrigin.x},${slamOrigin.y})`,
        );
      }
    } else {
      slamOrigin = LEGACY_PORTRAIT_SLAM_ORIGIN;
    }
  }

  const callerProvidedOrigin = req.slamOriginPx !== undefined;
  const knownNonIpad = detectedBounds !== null && detectedBounds.orientation === 'landscape';
  if (!guard.allowOnUndetermined && !knownNonIpad && !callerProvidedOrigin) {
    const reason = detectedBounds
      ? `iPad-portrait letterbox detected (bounds ${detectedBounds.width}×${detectedBounds.height})`
      : `target type undetermined (bounds detection failed — frame too dark or unrecognised) ` +
        `and slam-origin defaulted to LEGACY_PORTRAIT, which presumes iPad`;
    throw new Error(
      `moveToPixel: refusing slam-then-move — ${reason}. ` +
      `Slam-to-corner on an iPad triggers the iPadOS hot-corner gesture and ` +
      `re-locks the screen mid-session. Options: ` +
      `(1) use strategy='detect-then-move' (recommended for iPad), ` +
      `(2) pass slamOriginPx explicitly if you know the target is non-iPad, ` +
      `(3) pass forbidSlamOnIpad=false to opt out (only safe if iPad ` +
      `hot-corners are disabled).`,
    );
  }

  return { origin: slamOrigin, bounds: detectedBounds };
}

/** Layer 5: caller has already decided slamming is safe. Best-effort bounds
 *  detection purely to compute a sane origin — never throws. */
async function resolveCallerAssertedOrigin(
  req: AnchorRequest,
): Promise<{ origin: { x: number; y: number }; bounds: IpadBounds | null }> {
  if (req.slamOriginPx) {
    return { origin: req.slamOriginPx, bounds: null };
  }
  const bounds = await detectBoundsOrNull(req.client, {
    verbose: req.verbose,
    logPrefix: 'cursor-anchor',
  });
  return {
    origin: bounds ? slamOriginFromBounds(bounds) : LEGACY_PORTRAIT_SLAM_ORIGIN,
    bounds,
  };
}

/** measureCell: synthetic scene, no guard, no detection. */
function resolveCalibrationOrigin(
  req: AnchorRequest,
): { origin: { x: number; y: number }; bounds: IpadBounds | null } {
  return { origin: req.slamOriginPx ?? LEGACY_PORTRAIT_SLAM_ORIGIN, bounds: null };
}

/**
 * Post-slam "did the expected motion land near the corner" check —
 * mirrors slamToCorner's own verifyMotion (ballistics.ts), reimplemented
 * against a caller-injected screenshot fn (ADR 0001: slamToCorner's own
 * verifyMotion is hardwired to ballistics.ts's private non-nudging
 * takeRawScreenshot, which isn't right for every anchorCursor call site —
 * e.g. move-to.ts wants the wake-nudging variant when it opts in at all).
 */
async function verifySlamLanded(
  req: AnchorRequest,
  before: Buffer,
  corner: Corner,
  bounds: IpadBounds | null,
): Promise<{ verified: boolean; matchedClusters: Cluster[] }> {
  const client = req.client;
  // One more small nudge in-corner right before the verification
  // screenshot: iPadOS fades a static cursor after ~300ms, and the slam
  // loop's last pace-sleep may already have crossed that. Mirrors
  // slamToCorner's own verifyMotion trick.
  const vec = cornerVector(corner);
  await client.mouseMoveRelative(3 * vec.x, 3 * vec.y);
  await sleep(50);
  const after = await req.screenshot(client);

  const detection = { ...DEFAULT_DETECTION_CONFIG, ...req.detection };
  const tolerance = req.cornerTolerance ?? 80;
  // P0 fix (2026-08-24): use the iPad's own detected bounds corner, not
  // the raw capture-frame corner — see cornerTargetFromBounds's doc in
  // ballistics.ts. `bounds` is threaded from anchorCursor's own guard
  // resolution when available (zero extra detection cost); falls back to
  // the raw-frame corner only if bounds are genuinely unavailable.
  const expected = bounds
    ? cornerTargetFromBounds(corner, bounds)
    : cornerTargetPx(corner, await client.getResolution());

  let clusters: Cluster[];
  try {
    clusters = await diffScreenshots(before, after, detection);
  } catch (err) {
    if (req.verbose) {
      console.error(`[cursor-anchor] verify diff threw: ${(err as Error).message}`);
    }
    return { verified: false, matchedClusters: [] };
  }

  const matchedClusters = clusters.filter((c) => {
    const dx = c.centroidX - expected.x;
    const dy = c.centroidY - expected.y;
    return Math.sqrt(dx * dx + dy * dy) <= tolerance;
  });

  if (req.verbose) {
    console.error(
      `[cursor-anchor] verify: ${matchedClusters.length}/${clusters.length} cluster(s) within ${tolerance}px of expected (${expected.x},${expected.y})`,
    );
  }

  return { verified: matchedClusters.length > 0, matchedClusters };
}

async function runSlam(req: AnchorRequest, corner: Corner): Promise<void> {
  await slamToCorner(req.client, {
    calls: req.slamCalls,
    paceMs: req.paceMs,
    corner,
    verbose: req.verbose,
    // anchorCursor owns verification itself (against the injected
    // screenshot fn) rather than delegating to slamToCorner's own
    // verifyMotion, which is hardwired to ballistics.ts's private
    // non-nudging capture. See verifySlamLanded's doc.
    verifyMotion: false,
  });
}

export async function anchorCursor(req: AnchorRequest): Promise<AnchorResult> {
  const corner = req.corner ?? 'top-left';
  const captureVerification = req.captureVerification ?? false;
  const selfGate = req.selfGate ?? true;
  const recovery = req.recovery ?? { kind: 'none' };

  let resolved: { origin: { x: number; y: number }; bounds: IpadBounds | null };
  switch (req.guard.kind) {
    case 'bounds-guard':
      resolved = await resolveBoundsGuardOrigin(req, req.guard);
      break;
    case 'caller-asserted':
      resolved = await resolveCallerAssertedOrigin(req);
      break;
    case 'none-calibration':
      resolved = resolveCalibrationOrigin(req);
      break;
  }

  let verified: boolean | null = null;
  let recoveryAttempted = false;

  if (!captureVerification) {
    await runSlam(req, corner);
  } else {
    // Bounds for the verification corner target: reuse whatever the guard
    // resolution already detected (zero extra cost for bounds-guard/
    // caller-asserted callers that didn't supply an explicit slamOriginPx).
    // Otherwise best-effort cache-first/fresh-detect — measureCell's
    // none-calibration guard never detects for origin purposes, but
    // verification still needs real bounds when the target IS a real
    // letterboxed iPad (see cornerTargetFromBounds's doc: the P0 bug this
    // fixes was found via exactly this call path). Never throws.
    const verificationBounds = resolved.bounds
      ?? getLastGoodBounds()
      ?? await detectBoundsOrNull(req.client, { verbose: req.verbose, logPrefix: 'cursor-anchor' });
    const before = await req.screenshot(req.client);
    await runSlam(req, corner);
    const check = await verifySlamLanded(req, before, corner, verificationBounds);
    verified = check.verified;

    if (!verified && selfGate) {
      if (recovery.kind === 'none') {
        throw new Error(
          `anchorCursor: slam motion did not verify (guard=${req.guard.kind}) and no recovery configured. ` +
          `Pass a recovery (key-sequence-retry / defensive-keys) or set selfGate:false to handle this yourself.`,
        );
      }
      recoveryAttempted = true;
      if (recovery.kind === 'key-sequence-retry') {
        // unlockIpad's existing retry: Esc → Enter → Space, then
        // re-attempt the slam+verify once.
        if (req.verbose) {
          console.error('[cursor-anchor] slam motion not verified — retrying via key sequence before re-slamming');
        }
        await req.client.sendKey('Escape');
        await sleep(200);
        await req.client.sendKey('Enter');
        await sleep(600);
        await req.client.sendKey('Space');
        await sleep(400);
        const retryBefore = await req.screenshot(req.client);
        await runSlam(req, corner);
        const retryCheck = await verifySlamLanded(req, retryBefore, corner, verificationBounds);
        verified = retryCheck.verified;
      } else if (recovery.kind === 'defensive-keys') {
        // ipadGoHome's Phase-231 belt-and-suspenders: Esc + Enter, no
        // re-attempt — caller inspects the returned screenshot itself,
        // matching ipadGoHome's existing messaging pattern.
        if (req.verbose) {
          console.error('[cursor-anchor] slam motion not verified — sending defensive Esc+Enter');
        }
        await req.client.sendKey('Escape');
        await sleep(200);
        await req.client.sendKey('Enter');
        await sleep(600);
      }
    }
  }

  if (req.nudge) {
    await nudgeFromEdge(req.client, {
      away: req.nudge.away,
      onlyAxis: req.nudge.onlyAxis,
      verbose: req.verbose,
    });
  }

  return {
    origin: resolved.origin,
    verified,
    recoveryAttempted,
    bounds: resolved.bounds,
  };
}

// Re-exported so call sites migrating to anchorCursor don't need a second
// import from ballistics.ts just for the shared Corner/Axis types.
export type { Axis, Corner };
