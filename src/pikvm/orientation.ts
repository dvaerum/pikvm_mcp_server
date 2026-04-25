/**
 * Detect the iPad's content bounds and orientation within an HDMI screenshot.
 *
 * PiKVM captures the full HDMI frame (e.g. 1920×1080), but an iPad displayed
 * in portrait fills only a vertical strip in the middle, with black letterbox
 * bars on either side. In landscape, the iPad fills (or nearly fills) the
 * frame. The slam-target corner, unlock-swipe centre X, and home-indicator Y
 * all depend on knowing where the actual iPad content lives — without this,
 * unlock and move-to defaults are hardcoded to the reference iPad's portrait
 * letterbox at HDMI x=625.
 *
 * Detection: scan the screenshot for non-black pixels and take the bounding
 * box. iPad content has a deep-black wallpaper border? No — iPadOS lock
 * and home screens always have visible UI elements (status bar, dock,
 * widgets) that are clearly above the black-letterbox brightness floor.
 * A simple pixel sum threshold is sufficient.
 *
 * The detection is sampled (every 4th row/column) for speed, then refined
 * along each edge to pixel accuracy.
 */

import { PiKVMClient } from './client.js';
import { decodeToRgb } from './cursor-detect.js';

export type IpadOrientation = 'portrait' | 'landscape';

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
  /** Sampling step for the coarse pass. Default 4. Smaller = slower but
   *  more accurate before the refinement pass. */
  step?: number;
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

export async function detectIpadBounds(
  client: PiKVMClient,
  options: DetectOptions = {},
): Promise<IpadBounds> {
  const shot = await client.screenshot();
  return detectIpadBoundsFromBuffer(shot.buffer, options);
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
