/**
 * pikvm_mouse_click_at's core orchestration (Phase 4/F5 extraction,
 * 2026-08-24): move-then-verify-then-click, with three safety gates
 * (brightness, cursor-verified, correct-element residual) that can each
 * abort the click before it fires. Previously a 290-line function inline
 * in index.ts with zero real behavioral test coverage (only text-grep
 * tests that regexed index.ts as a string — see click-at.test.ts's header
 * for what replaced them).
 *
 * `clickAt()` returns a `ClickAtOutcome` discriminated union instead of an
 * MCP `CallToolResult` — index.ts's shrunk handler owns arg-parsing (raw
 * `args: Record<string, unknown>` → typed `ClickAtRequest`) and rendering
 * (`ClickAtOutcome` → `CallToolResult`); this module owns the actual
 * decision logic and HID/screenshot orchestration. `outcome.message` is
 * the complete, final human-readable text for each outcome — including
 * capture-advisory lines where the pre-extraction code included them.
 * That inclusion is NOT uniform across outcomes (see the `brightness-abort`
 * doc below) — preserved exactly as it was, not "fixed" as part of this
 * extraction; flag to the manager separately if that gap should close.
 */
import { PiKVMClient } from './client.js';
import { BallisticsProfile } from './ballistics.js';
import { HidPolicy } from './hid-mode.js';
import { MoveStrategy, moveToPixel } from './move-to.js';
import { scaleLearner } from './scale-learner.js';
import {
  biasCorrectedAimPoint,
  isScreenTooDimForCursorDetection,
  residualForSkip,
  verifyClickByDiff,
  type ClickVerifyOptions,
} from './click-verify.js';
import { analyzeBrightness } from './brightness.js';
import { ipadContentRegionFromBuffer } from './orientation.js';
import {
  capturePhaseAdvisory,
  formatCaptureLines,
  type CaptureConfig,
  type CaptureSaved,
} from './capture.js';

export type ClickButton = 'left' | 'right' | 'middle' | 'up' | 'down';

export interface ClickAtRequest {
  client: PiKVMClient;
  /** null means the dispatch preamble's moverGate() would have refused
   *  this call already (unknown/settling HID mode) — clickAt reports
   *  'mode-unknown' rather than assuming a caller-side guarantee. */
  policy: HidPolicy | null;
  target: { x: number; y: number };
  button: ClickButton;
  /** Explicit strategy override. Undefined → policy.strategy. */
  strategy?: MoveStrategy;
  assumeCursorAt?: { x: number; y: number };
  profile: BallisticsProfile | null;
  verifyClick: boolean;
  verifySettleMs: number;
  verifyRegionHalfPx?: number;
  verifyMinChangeFraction?: number;
  expectRegion?: { x: number; y: number; width: number; height: number };
  /** Retained only for its brightness-gate default + advisory note — the
   *  old "force maxRetries=0" effect is universal now (retry removed
   *  2026-07-28). */
  singleTap: boolean;
  /** Escape hatch: click at the predicted position even when the cursor
   *  can't be localized. Never a silent success — the outcome is always
   *  reported UNVERIFIED. */
  force: boolean;
  /** Explicit override. Undefined → VERY_DIM_THRESHOLD-equivalent
   *  (policy.dimThreshold) on iPad, 0 for singleTap, else policy default. */
  minBrightness?: number;
  /** Explicit override. Undefined → policy.maxResidualPx. */
  maxResidualPx?: number;
  capture?: CaptureConfig;
  verbose?: boolean;
}

export type ClickAtOutcome =
  | { kind: 'mode-unknown'; message: string }
  | { kind: 'brightness-abort'; message: string; mean: number; threshold: number }
  | { kind: 'cursor-unverified'; message: string; screenshot: Buffer; captured: (CaptureSaved | null)[] }
  | {
      kind: 'residual-skip';
      message: string;
      residualPx: number;
      maxResidualPx: number;
      screenshot: Buffer;
      captured: (CaptureSaved | null)[];
    }
  | {
      kind: 'clicked';
      message: string;
      /** true when force:true fired the click at a predicted position the
       *  cursor could not be localized to confirm — see ClickAtRequest.force. */
      forcedUnverified: boolean;
      screenshot: Buffer;
      captured: (CaptureSaved | null)[];
    };

/** (#41) feed the free first-shot sample to the passive scale learner. The
 *  learner's own hygiene rejects a faded-cursor-wake start or a forced
 *  click; its pre-filter + median absorb the rest. iPad/relative only. */
function recordMoveSample(
  result: { learnSample?: { plannedX: number; plannedY: number; achievedX: number; achievedY: number; woken: boolean } | null },
  appliedX: number,
  appliedY: number,
  forced: boolean,
): void {
  if (!result.learnSample) return;
  const { plannedX, plannedY, achievedX, achievedY, woken } = result.learnSample;
  scaleLearner.recordSample('x', plannedX, achievedX, appliedX, { woken, forced });
  scaleLearner.recordSample('y', plannedY, achievedY, appliedY, { woken, forced });
}

export async function clickAt(req: ClickAtRequest): Promise<ClickAtOutcome> {
  // ADR-0002 Phase 1: the dispatch preamble's moverGate() check already
  // refuses the call if the mode is unknown/settling before clickAt is
  // ever reached in production — checked here too (not asserted) so a
  // future dispatch-gate change can't silently let a null policy reach
  // the mover.
  const policy = req.policy;
  if (!policy) {
    return { kind: 'mode-unknown', message: 'Error: HID mode unknown or settling — refusing to click.' };
  }

  const { client, target, button } = req;
  const captured: (CaptureSaved | null)[] = [];
  if (req.capture) captured.push(await capturePhaseAdvisory(client, req.capture, 'before'));

  const strategyStr = req.strategy ?? policy.strategy;
  const singleTap = req.singleTap;
  const force = req.force;
  // Phase 38 / v0.5.26: explicit override mirrors the auto-policy:
  // policy.dimThreshold on iPad targets, 0 elsewhere. M6: singleTap
  // defaults to 0 too — a dimmed PIN-sheet modal must not false-abort a
  // deliberate keypad tap (still overridable explicitly).
  const minBrightness = req.minBrightness !== undefined
    ? req.minBrightness
    : (singleTap ? 0 : policy.dimThreshold);

  // Phase 136 / Phase 156: iPad targets get chunkPaceMs=100ms open-loop
  // default; desktop uses caller's default.
  const chunkPace = policy.chunkPaceMs;
  // Compute the acceptance gate (maxResidualPx) ONCE, here, so the SAME
  // value both (a) threads into the mover — which derives its correction
  // gate strictly below it, re-shooting a residual in the dead band
  // instead of skipping it — and (b) drives the post-move skip check
  // below. Computing it in two places was the hole that let the mover's
  // correction gate (30) drift above the clicker's acceptance gate (25),
  // stranding [25,30) residuals (2026-07-31, fixed by 95ec05f in
  // curve-mover.ts; this single-computation invariant is what keeps it
  // fixed — see click-at.test.ts's drift-bug regression test).
  const effectiveMaxResidualPx = req.maxResidualPx !== undefined ? req.maxResidualPx : policy.maxResidualPx;
  // task #38: on iPad the tap lands ~5.9px ABOVE the detected pointer, so
  // aim the pointer that much LOWER to land the tap on the requested
  // target. The move AND the residual gate use this aim (cursor-near-aim
  // ⟺ tap-near-target); the verify region stays on the original target,
  // where the tap's UI effect actually appears. Desktop/absolute clicks
  // by coordinates → no offset.
  const aimPoint = policy.applyTapBias ? biasCorrectedAimPoint(target) : target;
  // (#41) capture the scale actually in force so the post-move sample is
  // recorded against it (impliedScale = achieved/planned × sApplied).
  const learnScaleX = scaleLearner.currentScale('x');
  const learnScaleY = scaleLearner.currentScale('y');
  const moveOpts = {
    strategy: strategyStr,
    assumeCursorAt: req.assumeCursorAt,
    profile: req.profile,
    acceptGatePx: effectiveMaxResidualPx,
    curveScaleX: learnScaleX,
    curveScaleY: learnScaleY,
    forbidSlamFallback: policy.forbidSlamFallback,
    // Desktop full-frame degrade: the Phase-32 slam guard exists ONLY to
    // avoid the iPadOS hot-corner re-lock, so it must be disarmed in
    // absolute/desktop mode — otherwise a blank/uniform desktop frame
    // false-aborts with "target type undetermined" (the guard presumes an
    // undetermined target is an iPad).
    forbidSlamOnIpad: policy.forbidSlamOnIpad,
    ...(chunkPace !== undefined ? { chunkPaceMs: chunkPace } : {}),
  };
  const verifyOpts: ClickVerifyOptions = {
    ...(req.verifyRegionHalfPx !== undefined
      ? { region: { x: target.x, y: target.y, halfWidth: req.verifyRegionHalfPx, halfHeight: req.verifyRegionHalfPx } }
      : {}),
    // expectRegion takes precedence over the target-centered `region` —
    // verifyClickByDecodedFrames honours regionRect first.
    ...(req.expectRegion !== undefined ? { regionRect: req.expectRegion } : {}),
    ...(req.verifyMinChangeFraction !== undefined ? { minChangedFraction: req.verifyMinChangeFraction } : {}),
  };

  // Phase 38: brightness precheck (single-attempt path — always runs).
  // Phase 38b (v0.5.27): scope the brightness measurement to detected
  // iPad bounds so letterbox bars don't trigger false-positive dim
  // verdicts on a bright iPad-portrait screen.
  //
  // NOTE (preserved pre-extraction behavior, not fixed here): unlike the
  // other three abort paths below, this one does NOT append
  // formatCaptureLines(captured) to its message — the pre-extraction
  // handler never did either. Flag to the manager if this inconsistency
  // should close; out of scope for a pure extraction.
  if (minBrightness > 0) {
    try {
      const shot0 = await client.screenshot();
      const region = await ipadContentRegionFromBuffer(shot0.buffer, { verbose: false });
      const brightness = await analyzeBrightness(shot0.buffer, { region });
      // Phase 48 severity gate: abort ONLY on a UNIFORMLY dim frame (low
      // mean AND low stddev → 'very-dim'), not on any low-mean frame. A
      // dark-but-CONTRASTY modal (a dimmed PIN sheet: mean ~27 but high
      // stddev from the keypad digits → severity 'dim') is perfectly
      // clickable and must pass.
      if (isScreenTooDimForCursorDetection({ mean: brightness.mean, severity: brightness.severity, minBrightness })) {
        return {
          kind: 'brightness-abort',
          mean: brightness.mean,
          threshold: minBrightness,
          message:
            `Click aborted: iPad display blocked ` +
            `(mean brightness=${brightness.mean.toFixed(0)}/255, threshold=${minBrightness}). ` +
            `iPad auto-brightness does NOT affect HDMI — dim HDMI means an ` +
            `iOS modal/security prompt is dimming the screen. Try ` +
            `pikvm_key Escape, Enter, or Cmd+Period to dismiss blindly; ` +
            `if none work, a human must dismiss the prompt physically on the iPad.`,
        };
      }
    } catch {
      // Precheck failure is non-fatal — fall through to the click.
    }
  }

  // Retry removed (2026-07-28): clicks are single-attempt. Positioning is
  // deterministic (curve-one-shot ~2-3px), faded cursors are recovered by
  // the M2 wake (#33), and the retry loop's only remaining effect was the
  // keypad double-fire / dismiss-escape harm.
  const result = await moveToPixel(client, aimPoint, moveOpts);
  if (!policy.mouseAbsolute) recordMoveSample(result, learnScaleX, learnScaleY, force);

  // False-success safety fix (2026-07-27): on a relative-mouse (iPad)
  // target a null finalDetectedPosition means the mover could NOT verify
  // where the cursor is — e.g. a fully-faded cursor makes curve-one-shot's
  // V8 start-detection fail. Clicking blind taps the stale faded
  // position, not the target — unacceptable for a PIN/payment. Report
  // NOT-LANDED instead of firing. (Desktop/absolute positions by
  // coordinates, not detection, so this gate is iPad-only.) force:true is
  // the explicit escape hatch — fires the click anyway at the predicted
  // position and flags the result UNVERIFIED.
  const forcedUnverified = !policy.mouseAbsolute && result.finalDetectedPosition === null && force;
  if (!policy.mouseAbsolute && result.finalDetectedPosition === null && !force) {
    return {
      kind: 'cursor-unverified',
      screenshot: result.screenshot,
      captured,
      message:
        result.message +
        `\nClick NOT performed: the cursor position could not be verified ` +
        `(the pointer is likely faded/off-screen), so no ${button} click was sent. ` +
        `Wake the cursor first (a small pikvm_mouse_move) or retry once the screen is active` +
        `, or pass force:true to click anyway at the predicted position (returns an ` +
        `UNVERIFIED result — landing not confirmed).` +
        formatCaptureLines(captured),
    };
  }

  // Phase 88 correct-element gate: even a VERIFIED cursor can sit too far
  // from target — motion-diff can lock onto an adjacent feature, and a
  // click 50-100px off registers on the wrong element (live-verified
  // 2026-04-27: residual 78px activated the Apple Account row instead of
  // Software Update). Skip rather than click the wrong thing. iPad-only
  // (desktop positions by coordinates); maxResidualPx<=0/undefined
  // disables the gate.
  if (!policy.mouseAbsolute && result.finalDetectedPosition) {
    const maxResidualPx = effectiveMaxResidualPx; // same value threaded into the mover above
    if (maxResidualPx !== undefined && maxResidualPx > 0) {
      const skipResidual = residualForSkip(result.finalDetectedPosition, aimPoint, maxResidualPx);
      if (skipResidual !== null) {
        return {
          kind: 'residual-skip',
          residualPx: skipResidual,
          maxResidualPx,
          screenshot: result.screenshot,
          captured,
          message:
            result.message +
            `\nClick NOT performed: the cursor landed ${skipResidual.toFixed(1)}px from ` +
            `target (> maxResidualPx=${maxResidualPx}) — clicking would risk hitting an ` +
            `adjacent element, so no ${button} click was sent. Loosen maxResidualPx if a ` +
            `near-target click is acceptable; if a popup may be occluding the target, run ` +
            `pikvm_dismiss_popup then re-click.` +
            formatCaptureLines(captured),
        };
      }
    }
  }

  // Brief pause so iPadOS registers the cursor as stationary before click.
  await new Promise((r) => setTimeout(r, 80));
  // Pre-click screenshot AFTER cursor has settled at target, so the
  // pre→post diff isolates the click's UI effect from cursor motion.
  const preShot = req.verifyClick ? await client.screenshot() : null;
  // M8: "during" = pre-button-down cursor-alive frame, same point as the
  // predown proof-shot.
  if (req.capture) captured.push(await capturePhaseAdvisory(client, req.capture, 'during'));
  await client.mouseClick(button);
  // Wait for the UI to render before capturing the post-click frame.
  await new Promise((r) => setTimeout(r, req.verifySettleMs));
  const shot = await client.screenshot();
  // M8: "after" reuses the post-click frame (no extra screenshot).
  if (req.capture) captured.push(await capturePhaseAdvisory(client, req.capture, 'after', shot.buffer));

  let verificationText = '';
  if (req.verifyClick && preShot) {
    try {
      const verification = await verifyClickByDiff(preShot.buffer, shot.buffer, verifyOpts);
      verificationText = `\n${verification.message}`;
    } catch (err) {
      verificationText = `\nClick verification skipped: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }

  const singleTapNote = singleTap
    ? `\n(singleTap: tapped ONCE, no retry — the verification below is ADVISORY only; the tap fired regardless of the reported screen change. Use this for keypads/PIN pads so a sub-threshold effect never re-taps the key.)`
    : '';
  const clickLine = forcedUnverified
    ? `\n⚠ Clicked ${button} UNVERIFIED at the predicted position (force:true): the cursor could NOT be localized, so the LANDING IS NOT CONFIRMED — do not treat this as a successful tap. Inspect the screenshot / screenChanged below to judge whether it landed; if it didn't, wake the cursor (pikvm_mouse_move) or fix HID (pikvm_usb_reconnect) and retry.`
    : `\nClicked ${button} at approximate position. Post-click screenshot attached.`;

  return {
    kind: 'clicked',
    forcedUnverified,
    screenshot: shot.buffer,
    captured,
    message: result.message + clickLine + singleTapNote + verificationText + formatCaptureLines(captured),
  };
}
