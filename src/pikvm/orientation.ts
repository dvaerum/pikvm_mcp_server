/**
 * Detect the iPad's content bounds and orientation within an HDMI screenshot.
 *
 * PiKVM captures the full HDMI frame (e.g. 1920×1080), but an iPad displayed
 * in portrait fills only a vertical strip in the middle, with black letterbox
 * bars on either side. In landscape, the iPad fills (or nearly fills) the
 * frame. The slam-target corner, unlock-swipe centre X, and home-indicator Y
 * all depend on knowing where the actual iPad content lives — without this,
 * the unlock and move-to defaults have to be hardcoded to one specific iPad's
 * portrait letterbox.
 *
 * Detection: walk inward from each HDMI edge looking for the first
 * column/row that contains any pixel above a brightness threshold. iPadOS
 * lock and home screens always have visible UI (status bar, home indicator,
 * widgets) brighter than the letterbox bars, so the first non-uniform
 * column/row marks the iPad edge.
 *
 * Dark-mode foreground apps with mostly black canvas can swallow one or
 * more edges, producing an aspect ratio that doesn't match an iPad. We
 * sanity-check the result and fall back to the most recent good detection
 * (cached in module state) when the current frame doesn't yield reliable
 * bounds.
 */

import { PiKVMClient } from './client.js';
import { decodeToRgb } from './cursor-detect.js';

export type IpadOrientation = 'portrait' | 'landscape';

/** Hardcoded fallback for the post-slam top-left origin when bounds
 *  detection fails. Calibrated against the reference iPad's portrait
 *  letterbox in a 1920×1080 HDMI frame. */
export const LEGACY_PORTRAIT_SLAM_ORIGIN = { x: 625, y: 65 } as const;

/** Hardcoded fallback for the unlock-swipe start point when bounds
 *  detection fails. Same reference iPad as above. */
export const LEGACY_PORTRAIT_UNLOCK_START = { x: 955, y: 1035 } as const;

// Cache the most recent sane detection. Detection from a dark-content app
// (e.g. Files in dark mode with all-black canvas) can falsely shrink the
// vertical bounds because the iPad's solid-black render is indistinguishable
// from HDMI letterbox black. Reusing a previously-good detection is the
// simplest robust fallback.
let lastGoodBounds: IpadBounds | null = null;

/** Aspect-ratio sanity check. iPad displays are 4:3 or 3:2 — short/long
 *  side ratio between ~0.62 and ~0.75. A detection well outside that
 *  range probably missed a black edge. */
function aspectLooksSane(w: number, h: number): boolean {
  const r = Math.min(w, h) / Math.max(w, h);
  return r >= 0.55 && r <= 0.85;
}

export interface IpadBounds {
  /** Left edge of iPad content within the HDMI frame. */
  x: number;
  /** Top edge. */
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  orientation: IpadOrientation;
  /** Full HDMI screenshot resolution. */
  resolution: { width: number; height: number };
}

export interface DetectOptions {
  /** Per-channel sum (R+G+B) above which a pixel counts as iPad content
   *  rather than letterbox black. Default 60 — well above JPEG noise on
   *  near-black bars (~5–15) and below the dimmest visible UI elements. */
  brightnessSum?: number;
  verbose?: boolean;
}

export async function detectIpadBoundsFromBuffer(
  buffer: Buffer,
  options: DetectOptions = {},
): Promise<IpadBounds> {
  const { data, width, height } = await decodeToRgb(buffer);
  const threshold = options.brightnessSum ?? 60;

  // Strategy: find letterbox (entirely-uniform-black) columns/rows on each
  // side. Letterbox bars are pure HDMI black with zero pixel variance; iPad
  // content has at least some non-black pixel somewhere (status bar, home
  // indicator, app chrome — even in dark-mode apps). This is more robust
  // than a pure brightness-bounding-box because dark-themed apps with mostly
  // black canvas still get correctly bounded by the iPad's edge UI.
  const isContentColumn = (x: number): boolean => {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 3;
      if (data[i] + data[i + 1] + data[i + 2] > threshold) return true;
    }
    return false;
  };
  const isContentRow = (y: number): boolean => {
    const rowOff = y * width * 3;
    for (let x = 0; x < width; x++) {
      const i = rowOff + x * 3;
      if (data[i] + data[i + 1] + data[i + 2] > threshold) return true;
    }
    return false;
  };

  let minX = -1;
  for (let x = 0; x < width; x++) {
    if (isContentColumn(x)) { minX = x; break; }
  }
  if (minX < 0) {
    throw new Error(
      'Could not detect iPad content bounds — entire screenshot is black/below threshold. ' +
        'The HDMI input may be disconnected or the iPad may be off.',
    );
  }
  let maxX = minX;
  for (let x = width - 1; x > minX; x--) {
    if (isContentColumn(x)) { maxX = x; break; }
  }
  let minY = 0;
  for (let y = 0; y < height; y++) {
    if (isContentRow(y)) { minY = y; break; }
  }
  let maxY = minY;
  for (let y = height - 1; y > minY; y--) {
    if (isContentRow(y)) { maxY = y; break; }
  }

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const orientation: IpadOrientation = w > h ? 'landscape' : 'portrait';

  const detected: IpadBounds = {
    x: minX,
    y: minY,
    width: w,
    height: h,
    centerX: minX + Math.floor(w / 2),
    centerY: minY + Math.floor(h / 2),
    orientation,
    resolution: { width, height },
  };

  // If the aspect ratio looks like an iPad (4:3 or 3:2), trust the
  // detection and update the cache. Otherwise prefer the last good
  // detection (likely from a brighter context like the lock or home
  // screen) — the current screen probably has solid-black content
  // that's eating one or more edges.
  if (aspectLooksSane(w, h)) {
    if (options.verbose) {
      console.error(
        `[orientation] bounds=(${minX},${minY})→(${maxX},${maxY}) ${w}×${h} ${orientation}`,
      );
    }
    lastGoodBounds = detected;
    return detected;
  }

  if (options.verbose) {
    console.error(
      `[orientation] suspect bounds ${w}×${h} (aspect off); ` +
        (lastGoodBounds ? `using cached ${lastGoodBounds.width}×${lastGoodBounds.height}` : 'no cache, returning anyway'),
    );
  }
  return lastGoodBounds ?? detected;
}

/** For tests / fresh-process scenarios. Drops the cached bounds so the next
 *  detection is always recomputed from the current screenshot. */
export function clearOrientationCache(): void {
  lastGoodBounds = null;
}

/** Read the most recent successful detection without triggering a new one.
 *  Returns null if no detection has succeeded yet in this process. */
export function getLastGoodBounds(): IpadBounds | null {
  return lastGoodBounds;
}

export async function detectIpadBounds(
  client: PiKVMClient,
  options: DetectOptions = {},
): Promise<IpadBounds> {
  const shot = await client.screenshot();
  return detectIpadBoundsFromBuffer(shot.buffer, options);
}

/**
 * Best-effort wrapper around `detectIpadBounds`. Returns null on failure
 * (e.g. all-black HDMI capture) instead of throwing, optionally logging
 * the failure with a caller-supplied prefix when verbose. Encapsulates
 * the try/catch pattern that both `unlockIpad` and `moveToPixel`'s
 * origin discovery use.
 */
export async function detectBoundsOrNull(
  client: PiKVMClient,
  options: DetectOptions & { logPrefix?: string } = {},
): Promise<IpadBounds | null> {
  try {
    return await detectIpadBounds(client, options);
  } catch (e) {
    if (options.verbose) {
      const prefix = options.logPrefix ?? 'orientation';
      console.error(`[${prefix}] bounds detection failed: ${(e as Error).message}`);
    }
    return null;
  }
}

/**
 * Compute the slam-anchor origin in HDMI coordinates. After slamToCorner
 * with the 'top-left' corner, the cursor lands inside the iPad content
 * just past the dead-zone, near (bounds.x + dz, bounds.y + dz) where dz is
 * the iPadOS edge dead zone (~5–10 px). Use a small inset so move-to
 * starts from a known interior point regardless of orientation/letterbox.
 */
export function slamOriginFromBounds(bounds: IpadBounds): { x: number; y: number } {
  const inset = 8;
  return { x: bounds.x + inset, y: bounds.y + inset };
}

/**
 * Compute the unlock-swipe start point. iPadOS unlocks via a bottom-up
 * swipe starting near the home indicator bar (which sits at the bottom
 * centre of the iPad's display, both portrait and landscape).
 */
export function unlockStartFromBounds(bounds: IpadBounds): { x: number; y: number } {
  // Home indicator sits ~45 px above the bottom edge.
  const aboveIndicator = 45;
  return {
    x: bounds.centerX,
    y: Math.max(bounds.y, bounds.y + bounds.height - aboveIndicator),
  };
}
