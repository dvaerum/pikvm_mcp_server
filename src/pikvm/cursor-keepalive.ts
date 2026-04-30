/**
 * Phase 187 (v0.5.177): cursor-keepalive wiggle.
 *
 * iPadOS auto-hides the on-screen pointer after ~1 s of mouse
 * inactivity. Cursor-detection code (motion-diff in moveToPixel,
 * template-match in click-verify, pre-click verification) takes
 * screenshots throughout the click pipeline; if the pipeline ever
 * pauses long enough for the cursor to fade, the next detection
 * frame is cursor-less and detection fails.
 *
 * `wakeupCursor` (move-to.ts) wakes the cursor at origin discovery,
 * but later screenshots — post-moveToPixel pre-click verification,
 * micro-correction iterations after a long settle, the
 * `minPreClickTemplateScore` re-check — happen well after that wake
 * and risk landing in the fade window.
 *
 * This module provides:
 *   - `recordEmit()`: stamps the module-level "last emit" timestamp.
 *     Called from `client.mouseMoveRelative` so every mouse move counts
 *     as activity automatically.
 *   - `keepCursorAlive(client, options?)`: if the elapsed gap since
 *     the last recorded emit exceeds `staleThresholdMs`, emits a
 *     minimal +1/-1 round-trip wiggle (net-zero displacement) so the
 *     next screenshot has the pointer rendered. Cheap when called in
 *     tight loops — does nothing if a recent emit already woke the
 *     cursor.
 *   - `shouldWiggle(args)`: pure predicate exposed for unit tests
 *     and callers that want to gate on staleness without performing
 *     the wiggle.
 *
 * Design notes:
 *   - The +1/-1 magnitude is deliberately tiny. iPadOS pointer-
 *     effect snap ignores sub-pixel motion when the cursor is over
 *     interactive UI (Phase 125 preClickApproachMickeys is the right
 *     primitive for snap-on-click); +1 mickey reliably wakes the
 *     cursor without dragging it into a different snap zone. The
 *     wiggle stays inside one HDMI pixel after acceleration on
 *     normal iPad ratios (live measured ~0.85–3.0 px/mickey).
 *   - The implementation keeps `lastEmitMs` module-scoped (no class
 *     instance). The 30 ms inter-pause and configurable settle let
 *     the streamer + iPadOS render pipeline catch up before the
 *     caller reads the next frame; matches the latency timing in
 *     wakeupCursor (Phase 13) and confirmed by the same Phase 13
 *     latency-probe research (150–235 ms streamer + iPadOS render
 *     latency).
 *
 * The contract is pinned by `__tests__/cursor-keepalive.test.ts`.
 */

import type { PiKVMClient } from './client.js';
import { sleep } from './util.js';

/** Module-level last-emit timestamp (ms since epoch). null = no
 *  emit recorded since process start; first activity will set it. */
let lastEmitMs: number | null = null;

/** Stamp the last-emit clock. Call after every mouse emit so the
 *  keepalive guard knows when the cursor was last "active". */
export function recordEmit(): void {
  lastEmitMs = Date.now();
}

/** Reset the module state. ONLY for unit tests — production callers
 *  should never reset, because that would falsely report "no recent
 *  activity" and trigger an unwanted wiggle on the next call. */
export function resetKeepaliveForTest(): void {
  lastEmitMs = null;
}

export interface ShouldWiggleArgs {
  lastEmitMs: number | null;
  nowMs: number;
  staleThresholdMs: number;
}

/** Pure predicate. Returns true if `nowMs - lastEmitMs > threshold`,
 *  meaning the cursor has likely faded out of view on iPadOS and
 *  the next detection screenshot will see no cursor pixels.
 *
 *  Returns false when:
 *  - No emit has ever been recorded (lastEmitMs null) — the caller
 *    is on a fresh process and we don't know the cursor's state;
 *    don't wiggle speculatively.
 *  - elapsed ≤ threshold — cursor still visible.
 *
 *  Boundary is strictly greater-than, not ≥, so `staleThresholdMs`
 *  reads as "wait this long before treating it as stale". */
export function shouldWiggle(args: ShouldWiggleArgs): boolean {
  if (args.lastEmitMs === null) return false;
  return args.nowMs - args.lastEmitMs > args.staleThresholdMs;
}

export interface KeepCursorAliveOptions {
  /** Master switch. Default true. Set false to disable for tests
   *  or for desktop targets where the cursor doesn't auto-hide. */
  enabled?: boolean;
  /** Minimum elapsed time since the last recorded emit before the
   *  wiggle fires. Default 700 ms — well below iPadOS's ~1 s auto-
   *  hide threshold so we wake BEFORE the cursor fades. */
  staleThresholdMs?: number;
  /** Settle delay after the wiggle. Default 200 ms — enough for the
   *  PiKVM streamer + iPadOS render pipeline (150–235 ms measured
   *  Phase 13) to render the woken cursor in the next screenshot. */
  settleMs?: number;
  verbose?: boolean;
}

/** When the elapsed time since the last mouse emit exceeds the stale
 *  threshold, emit a minimal +1/-1 X-axis round-trip to keep the
 *  iPadOS pointer rendered. Net-zero displacement. No-op when recent
 *  activity makes the wiggle unnecessary or when `enabled: false`.
 *
 *  Production wiring: call before any screenshot used for cursor
 *  detection. The function is cheap (one `Date.now()` and a branch)
 *  on the no-wiggle path, so peppering the call sites is safe. */
export async function keepCursorAlive(
  client: PiKVMClient,
  options?: KeepCursorAliveOptions,
): Promise<void> {
  const enabled = options?.enabled ?? true;
  if (!enabled) return;
  const staleThresholdMs = options?.staleThresholdMs ?? 700;
  const settleMs = options?.settleMs ?? 200;

  if (!shouldWiggle({ lastEmitMs, nowMs: Date.now(), staleThresholdMs })) {
    return;
  }

  if (options?.verbose) {
    const elapsed = lastEmitMs === null ? 'null' : `${Date.now() - lastEmitMs}ms`;
    console.error(`[keepalive] wiggling (${elapsed} since last emit)`);
  }

  await client.mouseMoveRelative(1, 0);
  await sleep(30);
  await client.mouseMoveRelative(-1, 0);
  // Stamp the clock so a follow-up keepalive call within threshold
  // is a correct no-op (the wiggle is itself activity).
  recordEmit();
  if (settleMs > 0) await sleep(settleMs);
}
