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

import { PiKVMClient, ScreenResolution } from './client.js';
import { slamToCorner } from './ballistics.js';
import {
  detectBoundsOrNull,
  slamOriginFromBounds,
  unlockStartFromBounds,
  IpadBounds,
  LEGACY_PORTRAIT_SLAM_ORIGIN,
  LEGACY_PORTRAIT_UNLOCK_START,
} from './orientation.js';
import { sleep } from './util.js';

export interface IpadUnlockOptions {
  /** Whether to slam to top-left first to establish a known cursor position
   *  before positioning at the unlock start. Useful when the cursor state is
   *  unknown. Default true. */
  slamFirst?: boolean;
  /** HDMI X of the unlock-swipe start. Default: auto-detected from the
   *  iPad's letterbox bounds (centre X). Override only if detection fails
   *  or you need a non-centre swipe origin. */
  startX?: number;
  /** HDMI Y of the unlock-swipe start. Default: auto-detected from the
   *  iPad's letterbox bounds (~45 px above the bottom edge, where the home
   *  indicator lives). */
  startY?: number;
  /** Total pixel distance to drag upward. Default 1500 (Phase 209,
   *  v0.5.198). Earlier default was 800 — found insufficient on
   *  some iPads where even 1200 didn't clear the unlock threshold. */
  dragPx?: number;
  /** Try Esc + Enter + Space before the swipe. Default true.
   *  Enter is the actual unlock key on iPadOS 26 lock screens; Space
   *  was the working key on older iPadOS revisions and is kept as a
   *  fallback. Set false to skip and go straight to swipe. */
  tryKeyPressFirst?: boolean;
  /** When true (default), the swipe is SKIPPED if the key press ran
   *  successfully. Reason: a swipe-up from the bottom-center on an
   *  already-unlocked home screen is interpreted by iPadOS as a
   *  system gesture that LOCKS the iPad — verified live 2026-05-10.
   *  Set false to force the legacy keys-then-swipe sequence for
   *  back-compat or when keys alone don't unlock. */
  swipeOnKeyPressFailure?: boolean;
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
  /** iPad bounds used for swipe positioning. Null if startX/startY were
   *  both passed explicitly (no detection performed). */
  bounds: IpadBounds | null;
  message: string;
}

export async function unlockIpad(
  client: PiKVMClient,
  options: IpadUnlockOptions = {},
): Promise<IpadUnlockResult> {
  // Esc → Enter → Space: Enter unlocks iPadOS 26; Space is the
  // working key on older revisions; Esc closes any Control/Notification
  // overlay a prior failed gesture may have opened.
  let keyPressAttempted = false;
  if (options.tryKeyPressFirst !== false) {
    try {
      await client.sendKey('Escape');
      await sleep(200);
      await client.sendKey('Enter');
      await sleep(600);
      await client.sendKey('Space');
      await sleep(400);
      keyPressAttempted = true;
    } catch {
      // If sendKey fails, fall through to swipe-based unlock
    }
  }

  // Skip the swipe when keys ran: a swipe-from-bottom on an already-
  // unlocked home screen is interpreted by iPadOS as a system gesture
  // that LOCKS the iPad. swipeOnKeyPressFailure=false forces the
  // legacy always-swipe path for callers that need it.
  const swipeOnKeyPressFailure = options.swipeOnKeyPressFailure ?? true;
  if (keyPressAttempted && swipeOnKeyPressFailure) {
    // Skip the swipe — assume the keys did the work. Caller can
    // inspect the returned screenshot to confirm and call again
    // with `tryKeyPressFirst: false` if the iPad is still locked.
    const shot = await client.screenshot();
    return {
      screenshot: shot.buffer,
      screenshotWidth: shot.screenshotWidth,
      screenshotHeight: shot.screenshotHeight,
      dragPx: 0,
      chunkCount: 0,
      swipeDurationMs: 0,
      bounds: null,
      message:
        'Sent Escape + Enter + Space (Phase 217). Swipe SKIPPED to avoid ' +
        'the home-screen-to-lock-screen gesture artifact (Phase 219). ' +
        'Inspect the screenshot to confirm the iPad is on the home screen ' +
        '(if still on the lock screen, call again with ' +
        'tryKeyPressFirst: false to force the swipe-based unlock).',
    };
  }
  const slamFirst = options.slamFirst ?? true;
  // Phase 209 (v0.5.198): default bumped 800 → 1500. Live test
  // 2026-05-10 found dragPx=800 insufficient on this iPad — even
  // 1200 didn't clear the unlock threshold. iPadOS unlock thresholds
  // vary across devices and iPadOS versions; a generous default is
  // safer than under-shooting. The cost of a too-large swipe is
  // negligible (extra ~400ms HID emission); under-shooting wastes a
  // full unlock attempt and confuses callers.
  const dragPx = options.dragPx ?? 1500;
  const chunkMickeys = options.chunkMickeys ?? 30;
  const slamPaceMs = options.slamPaceMs ?? 60;
  const ppm = options.positionPxPerMickey ?? 1.0;
  const postSettleMs = options.postSettleMs ?? 1000;

  // Auto-detect iPad bounds unless caller has fully overridden positioning.
  let bounds: IpadBounds | null = null;
  if (options.startX === undefined || options.startY === undefined) {
    bounds = await detectBoundsOrNull(client, {
      verbose: options.verbose,
      logPrefix: 'ipad-unlock',
    });
    if (options.verbose && bounds) {
      console.error(
        `[ipad-unlock] detected ${bounds.orientation} bounds ` +
          `(${bounds.x},${bounds.y}) ${bounds.width}×${bounds.height}`,
      );
    }
  }

  const detectedSwipeStart = bounds ? unlockStartFromBounds(bounds) : LEGACY_PORTRAIT_UNLOCK_START;
  const startX = options.startX ?? detectedSwipeStart.x;
  const startY = options.startY ?? detectedSwipeStart.y;

  // 1. Optionally slam so we know the starting position (top-left of iPad content).
  if (slamFirst) {
    await slamToCorner(client, { corner: 'top-left', paceMs: slamPaceMs });
  }

  // 2. Position the cursor at (startX, startY). Post-slam origin is the
  // top-left of the iPad content within the HDMI letterbox.
  const slamOrigin = bounds ? slamOriginFromBounds(bounds) : LEGACY_PORTRAIT_SLAM_ORIGIN;
  const originX = slamOrigin.x;
  const originY = slamOrigin.y;
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
    bounds,
    message,
  };
}

// ============================================================================
// Composed iPad keyboard helpers — bundle the verified keyboard-first patterns
// into single-call tools so agents don't have to chain primitives.
// ============================================================================

export interface IpadLaunchAppOptions {
  /** Whether to attempt unlock first if the screen state is unknown.
   *  Default true. Setting this to false skips the swipe (cheaper if
   *  the caller knows the iPad is already unlocked). */
  unlockFirst?: boolean;
  /** Settle delay between Spotlight open and typing (ms). Default 700. */
  spotlightSettleMs?: number;
  /** Settle delay after typing the app name, before Enter (ms). Default 600. */
  postTypeSettleMs?: number;
  /** Settle delay after Enter, before returning the screenshot (ms).
   *  Default 1500 — apps usually launch within 1 s, this gives a margin. */
  launchSettleMs?: number;
  verbose?: boolean;
}

export interface IpadLaunchAppResult {
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  appName: string;
  unlocked: boolean;
  resolution: ScreenResolution;
  message: string;
}

/**
 * Launch an iPad app via the verified keyboard pipeline:
 * unlock → Cmd+Space (Spotlight) → type app name → Enter → settle → screenshot.
 *
 * This is far more reliable than `pikvm_mouse_click_at` on an icon because
 * it bypasses cursor positioning entirely. Verified live for Files,
 * Settings, App Store on iPadOS 26.1.
 */
export async function launchIpadApp(
  client: PiKVMClient,
  appName: string,
  options: IpadLaunchAppOptions = {},
): Promise<IpadLaunchAppResult> {
  if (!appName || appName.trim().length === 0) {
    throw new Error('appName is required');
  }
  const unlockFirst = options.unlockFirst ?? true;
  const spotlightSettleMs = options.spotlightSettleMs ?? 700;
  const postTypeSettleMs = options.postTypeSettleMs ?? 600;
  const launchSettleMs = options.launchSettleMs ?? 1500;

  let unlocked = false;
  if (unlockFirst) {
    if (options.verbose) console.error(`[launch-app] unlocking iPad`);
    await unlockIpad(client, { verbose: options.verbose });
    unlocked = true;
  }

  if (options.verbose) console.error('[launch-app] Cmd+Space');
  await client.sendShortcut(['MetaLeft', 'Space']);
  await sleep(spotlightSettleMs);

  if (options.verbose) console.error(`[launch-app] type "${appName}"`);
  await client.type(appName);
  await sleep(postTypeSettleMs);

  if (options.verbose) console.error('[launch-app] Enter');
  await client.sendKey('Enter');
  await sleep(launchSettleMs);

  const shot = await client.screenshot();
  const resolution = await client.getResolution();

  return {
    screenshot: shot.buffer,
    screenshotWidth: shot.screenshotWidth,
    screenshotHeight: shot.screenshotHeight,
    appName,
    unlocked,
    resolution,
    message:
      `Launched '${appName}' via Spotlight (unlocked=${unlocked}). ` +
      `Inspect the returned screenshot to confirm the app opened. ` +
      `If Spotlight returned to home screen instead, the app name didn't match — try a partial name or check spelling.`,
  };
}

export interface IpadHomeOptions {
  /** Settle delay after the gesture before screenshotting. Default 800 ms. */
  settleMs?: number;
  /** Phase 214 (v0.5.202): also do a slam-to-corner + swipe-up
   *  after Cmd+H. Cmd+H alone DOES NOT dismiss the App Switcher
   *  (only foreground apps); the swipe-up gesture does both.
   *  Default false to preserve backward compatibility. Bench
   *  scripts and any caller that needs a guaranteed home-screen
   *  state should pass `true`. */
  forceHomeViaSwipe?: boolean;
  /** Pixels to drag upward on the swipe path. Default 1500 (matches
   *  unlockIpad's tested-good value). Only used when
   *  `forceHomeViaSwipe` is true. */
  swipeDragPx?: number;
  verbose?: boolean;
}

export interface IpadHomeResult {
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  message: string;
}

/**
 * Return to the iPad home screen from any foreground app via Cmd+H.
 *
 * Background: mouse swipe-up gestures from the bottom edge consistently
 * open the App Switcher on iPadOS (regardless of distance or speed),
 * not the home screen. Apple seems to reserve the true "go home"
 * gesture for finger touch. The keyboard shortcut Cmd+H ("Hide app")
 * works reliably from any foreground app and is what we use here.
 *
 * Idempotent on the home screen. Does NOT unlock from the lock screen —
 * use `unlockIpad` for that.
 */
export async function ipadGoHome(
  client: PiKVMClient,
  options: IpadHomeOptions = {},
): Promise<IpadHomeResult> {
  const settleMs = options.settleMs ?? 800;

  if (options.verbose) console.error('[ipad-home] Cmd+H');
  await client.sendShortcut(['MetaLeft', 'KeyH']);
  await sleep(settleMs);

  // Phase 214 (v0.5.202): Cmd+H dismisses foreground apps but NOT
  // the App Switcher. A slam-to-corner + upward swipe does both
  // (and is also safe on lock screen / home screen — idempotent).
  // Live finding 2026-05-10: bench had been measuring against the
  // App Switcher view for hours because Cmd+H couldn't exit it.
  let messagePart = 'Sent Cmd+H to dismiss the foreground app.';
  if (options.forceHomeViaSwipe) {
    if (options.verbose) console.error('[ipad-home] swipe-up to force dismiss App Switcher');
    const dragPx = options.swipeDragPx ?? 1500;
    await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
    // Move down to the bottom-centre area so the swipe starts from
    // a region where iPadOS expects the home gesture.
    const bounds = await detectBoundsOrNull(client, {
      verbose: options.verbose,
      logPrefix: 'ipad-home',
    });
    const start = bounds ? unlockStartFromBounds(bounds) : LEGACY_PORTRAIT_UNLOCK_START;
    const slamOrigin = bounds ? slamOriginFromBounds(bounds) : LEGACY_PORTRAIT_SLAM_ORIGIN;
    let remX = Math.round(start.x - slamOrigin.x);
    let remY = Math.round(start.y - slamOrigin.y);
    while (remX > 0 || remY > 0) {
      const stepX = remX > 0 ? Math.min(127, remX) : 0;
      const stepY = remY > 0 ? Math.min(127, remY) : 0;
      await client.mouseMoveRelative(stepX, stepY);
      remX -= stepX;
      remY -= stepY;
      await sleep(20);
    }
    await sleep(200);
    await client.mouseClick('left', { state: true });
    let remDrag = dragPx;
    while (remDrag > 0) {
      const step = Math.min(30, remDrag);
      await client.mouseMoveRelative(0, -step);
      remDrag -= step;
    }
    await client.mouseClick('left', { state: false });
    await sleep(1000);
    messagePart += ' Followed by slam-corner + swipe-up to also dismiss App Switcher.';
  }

  const shot = await client.screenshot();
  return {
    screenshot: shot.buffer,
    screenshotWidth: shot.screenshotWidth,
    screenshotHeight: shot.screenshotHeight,
    message:
      messagePart +
      ' Inspect the screenshot to confirm the iPad is on the home screen.' +
      ' (Cmd+H does not unlock the iPad — call pikvm_ipad_unlock from the lock screen instead.)',
  };
}

export interface IpadAppSwitcherOptions {
  /** How long to hold the modifier (Cmd) so the App Switcher stays visible.
   *  Default 800 ms. The caller can use the returned screenshot to identify
   *  apps and follow up with arrow keys + Enter to switch, or
   *  pikvm_ipad_home to dismiss. */
  holdMs?: number;
  verbose?: boolean;
}

export interface IpadAppSwitcherResult {
  screenshot: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  message: string;
}

/**
 * Open the iPad App Switcher (Cmd+Tab) and capture a screenshot showing the
 * available apps, while keeping Cmd held briefly so the switcher stays
 * open long enough to capture. Then releases Cmd, which dismisses the
 * switcher (or selects the focused app, depending on iPadOS behaviour).
 *
 * For programmatic switching: call this to see what's available, then chain
 * `pikvm_shortcut(["MetaLeft","Tab"])` repeatedly to focus the desired app
 * and finally release Cmd via a manual `pikvm_key('MetaLeft', state:false)`.
 */
export async function ipadOpenAppSwitcher(
  client: PiKVMClient,
  options: IpadAppSwitcherOptions = {},
): Promise<IpadAppSwitcherResult> {
  const holdMs = options.holdMs ?? 800;
  if (options.verbose) console.error(`[app-switcher] Cmd+Tab, hold ${holdMs}ms`);

  // Press Cmd, tap Tab, hold, screenshot, then release Cmd.
  await client.sendKey('MetaLeft', { state: true });
  await sleep(40);
  await client.sendKey('Tab');
  await sleep(holdMs);
  const shot = await client.screenshot();
  await client.sendKey('MetaLeft', { state: false });

  return {
    screenshot: shot.buffer,
    screenshotWidth: shot.screenshotWidth,
    screenshotHeight: shot.screenshotHeight,
    message:
      'Opened App Switcher with Cmd+Tab. The screenshot was captured while Cmd ' +
      'was held; Cmd has now been released which selects the highlighted app. ' +
      'For multi-step switching, use pikvm_key with state=true/false manually.',
  };
}
