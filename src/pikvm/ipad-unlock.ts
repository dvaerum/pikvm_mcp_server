/**
 * iPad lock-screen unlock gesture for PiKVM targets in relative mouse mode.
 *
 * iPadOS unlocks from the lock screen via a bottom-to-top swipe originating
 * near the home indicator bar. With a USB HID mouse (which is what PiKVM
 * provides when `mouse.absolute=false`), this translates to:
 *
 *   1. Position the cursor near the home indicator (bottom center).
 *   2. Press the left mouse button.
 *   3. Rapid-fire relative-Y deltas upward (negative dy) covering enough
 *      distance to clear iPadOS's unlock threshold.
 *   4. Release the button.
 *
 * Empirically verified on the reference iPad (1920x1080 HDMI frame,
 * portrait content letterbox):
 *
 *   - Start at HDMI (955, 1035)
 *   - 800 px total drag distance
 *   - Chunked into 30-mickey calls (≈27 calls) emitted back-to-back
 *   - No pacing sleeps between calls
 *
 * A 400 px drag did NOT unlock; 800 px did. Speed mattered less than total
 * distance. The drag takes ~400 ms end-to-end including HTTP latency.
 */

import { PiKVMClient } from './client.js';
import { slamToCorner } from './ballistics.js';

export interface IpadUnlockOptions {
  /** Whether to slam to top-left first to establish a known cursor position
   *  before positioning at the unlock start. Useful when the cursor state is
   *  unknown. Default true. */
  slamFirst?: boolean;
  /** HDMI X of the unlock-swipe start. Default 955 (iPad portrait center). */
  startX?: number;
  /** HDMI Y of the unlock-swipe start. Default 1035 (just above the home
   *  indicator bar on the observed iPad). */
  startY?: number;
  /** Total pixel distance to drag upward. Default 800. */
  dragPx?: number;
  /** Per-call mickey size for the drag. Smaller = higher call rate = faster
   *  apparent motion. Default 30. */
  chunkMickeys?: number;
  /** Slam-to-corner pace when slamFirst is true (ms between calls). */
  slamPaceMs?: number;
  /** px/mickey estimate used to position the cursor at (startX, startY)
   *  before the swipe. Default 1.0 (the iPad's approximate ratio at
   *  mag=127, pace=20 ms). */
  positionPxPerMickey?: number;
  /** Settle after swipe before returning, so iPadOS has time to process the
   *  gesture and the home screen renders. Default 1000 ms. */
  postSettleMs?: number;
  verbose?: boolean;
}

export interface IpadUnlockResult {
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  dragPx: number;
  chunkCount: number;
  swipeDurationMs: number;
  message: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function unlockIpad(
  client: PiKVMClient,
  options: IpadUnlockOptions = {},
): Promise<IpadUnlockResult> {
  const slamFirst = options.slamFirst ?? true;
  const startX = options.startX ?? 955;
  const startY = options.startY ?? 1035;
  const dragPx = options.dragPx ?? 800;
  const chunkMickeys = options.chunkMickeys ?? 30;
  const slamPaceMs = options.slamPaceMs ?? 60;
  const ppm = options.positionPxPerMickey ?? 1.0;
  const postSettleMs = options.postSettleMs ?? 1000;

  // 1. Optionally slam so we know the starting position (top-left, near (625, 65)).
  if (slamFirst) {
    await slamToCorner(client, { corner: 'top-left', paceMs: slamPaceMs });
  }

  // 2. Position the cursor at (startX, startY). Assume post-slam origin is
  // (625, 65) in HDMI space (standard iPad portrait letterbox). If the user
  // passed different startX/startY, compute deltas.
  const originX = 625;
  const originY = 65;
  const dx = Math.round((startX - originX) / ppm);
  const dy = Math.round((startY - originY) / ppm);

  // Emit chunked deltas to reach start position. Use mag=127 chunks.
  let remX = dx;
  let remY = dy;
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(127, remX) : 0;
    const stepY = remY > 0 ? Math.min(127, remY) : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX -= stepX;
    remY -= stepY;
    await sleep(20);
  }
  await sleep(200);

  // 3. Press button.
  await client.mouseClick('left', { state: true });

  // 4. Rapid-fire upward drag.
  const swipeStart = Date.now();
  let remDrag = dragPx;
  let chunkCount = 0;
  while (remDrag > 0) {
    const step = Math.min(chunkMickeys, remDrag);
    await client.mouseMoveRelative(0, -step);
    remDrag -= step;
    chunkCount++;
  }
  const swipeDurationMs = Date.now() - swipeStart;

  // 5. Release.
  await client.mouseClick('left', { state: false });

  if (options.verbose) {
    console.error(
      `[ipad-unlock] dragPx=${dragPx} chunks=${chunkCount} durationMs=${swipeDurationMs} (~${Math.round(dragPx / swipeDurationMs * 1000)} px/s)`,
    );
  }

  // 6. Let iPadOS render the home screen.
  await sleep(postSettleMs);

  const shot = await client.screenshot();

  const message =
    `Unlock swipe: ${dragPx} px upward in ${chunkCount} chunks over ${swipeDurationMs} ms. ` +
    `Inspect the returned screenshot to confirm the iPad is now on the home screen ` +
    `(if still lock screen, the swipe did not clear iPadOS's unlock threshold — retry with larger dragPx).`;

  return {
    screenshot: shot.buffer,
    screenshotWidth: shot.screenshotWidth,
    screenshotHeight: shot.screenshotHeight,
    dragPx,
    chunkCount,
    swipeDurationMs,
    message,
  };
}
