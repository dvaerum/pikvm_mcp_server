/**
 * Single-shot absolute-coordinate move-then-verify for real desktop/
 * absolute-mode targets (HidPolicy.mouseAbsolute === true).
 *
 * Faithful to the design in
 * docs/move-to-pixel-absolute-mode-fix-design.md, mirroring the Rust
 * port's implementation (rust/mover/src/move_to/absolute_move.rs,
 * PR #96, live-confirmed on real hardware): absolute-mode positioning
 * needs none of moveToPixel's relative-mickey calibration/correction
 * machinery — an absolute HID coordinate maps directly and
 * deterministically to a screen pixel. Root cause this fixes:
 * moveToPixel's legacy body exclusively emits RELATIVE HID reports via
 * client.mouseMoveRelative(), which per ADR-0002 is a documented silent
 * no-op into an absolute-assembled gadget — real, currently-shipping
 * bug, confirmed live (task_4b034fc4e018, it-03400/IT-02634).
 */

import { PiKVMClient } from './client.js';
import {
  decodeScreenshot,
  findCursorByTemplateSet,
  takeRawScreenshot,
  type Point,
} from './cursor-detect.js';
import { getCachedTemplates } from './move-to.js';
import type { MoveToOptions, MoveToResult } from './move-to.js';

/** Radius (px) within which a post-move cursor-template match counts as
 *  "landed at the target" rather than a stray far-away false positive.
 *  Generous compared to the relative-mode correction loop's tolerances
 *  (Phase 29's 40px icon-tolerance) because absolute positioning has no
 *  accumulation error to correct for — a match this far out is either a
 *  genuine landing at a slightly-offset render point (cursor hotspot
 *  vs. sprite origin) or a real problem (dead/unattached gadget), not
 *  something worth an iterative retry over. */
const VERIFY_RADIUS_PX = 60;

export async function moveToPixelAbsolute(
  client: PiKVMClient,
  target: { x: number; y: number },
  options: MoveToOptions,
): Promise<MoveToResult> {
  const resolution = await client.getResolution(true);
  const targetX = Math.max(0, Math.min(resolution.width - 1, Math.round(target.x)));
  const targetY = Math.max(0, Math.min(resolution.height - 1, Math.round(target.y)));

  await client.mouseMove(targetX, targetY);

  const settleMs = options.postMoveSettleMs ?? 300;
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  const afterRaw = await takeRawScreenshot(client);
  const after = await decodeScreenshot(afterRaw);

  // Single verification pass — no correction loop. Locality-aware
  // template match (same discipline the Rust mirror already uses):
  // require a match within VERIFY_RADIUS_PX of the target rather than
  // accepting the highest-scoring match anywhere on screen.
  const templates = await getCachedTemplates();
  const verified = findCursorByTemplateSet(after, templates, {
    expectedNear: { x: targetX, y: targetY } as Point,
    expectedNearRadius: VERIFY_RADIUS_PX,
    requireWithinRadius: true,
    verbose: options.verbose,
  });

  let finalDetectedPosition: { x: number; y: number } | null = null;
  let finalResidualPx: number | null = null;
  let message: string;
  if (verified) {
    const residual = Math.hypot(verified.position.x - targetX, verified.position.y - targetY);
    finalDetectedPosition = { x: verified.position.x, y: verified.position.y };
    finalResidualPx = residual;
    message = `Absolute move to (${targetX}, ${targetY}) verified (residual ${residual.toFixed(1)}px, score ${verified.score.toFixed(3)})`;
  } else {
    message = `Absolute move to (${targetX}, ${targetY}) sent, but no cursor match found within ${VERIFY_RADIUS_PX}px of target — verification failed (possible dead/unattached gadget)`;
  }

  return {
    screenshot: after.buffer,
    screenshotWidth: after.width,
    screenshotHeight: after.height,
    target: { x: targetX, y: targetY },
    predicted: { x: targetX, y: targetY },
    // Not applicable — absolute positioning emits zero relative HID
    // reports by design; these are not measurements of anything. See
    // docs/move-to-pixel-absolute-mode-fix-design.md §2b-i (the Rust
    // design this TS fix mirrors).
    emittedMickeys: { x: 0, y: 0 },
    usedPxPerMickey: { x: 0, y: 0 },
    chunkCount: 0,
    strategy: 'absolute-move',
    // Not applicable — single-shot move-then-verify, not an iterative
    // correction loop.
    corrections: [],
    diagnostics: [],
    finalDetectedPosition,
    finalResidualPx,
    // Genuinely accurate for a single-shot path, not sentinels: there
    // is no "earlier pass" to have bailed to or be behind.
    passesSinceLastVerification: 0,
    bailedToBestPass: false,
    resolution,
    message,
    learnSample: null,
  };
}
