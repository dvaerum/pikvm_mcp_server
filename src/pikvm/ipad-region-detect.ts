/**
 * Auto-detect the iPad's region inside a PiKVM screenshot.
 *
 * PiKVM's HDMI capture is letterboxed: the iPad's display occupies a
 * centered sub-rectangle of the 1920×1080 (or whatever the capture
 * resolution is) frame, with black bars around it. This function
 * scans column / row luminance to find where the black bars end and
 * the iPad content begins.
 *
 * Ported from `tools/label-review/app.js` `detectIpadRegion()` — the
 * JS version runs in the browser via a `<canvas>` readback; this Node
 * port uses `sharp` to downscale to a 240-px-wide thumbnail and read
 * raw RGB.
 *
 * Used by `bench-collect-synthetic.ts` for calibration: combined with
 * the iPad app's reported logical screen size, this gives an affine
 * transform from iPad-logical coordinates to PiKVM-screenshot pixel
 * coordinates.
 */
import sharp from 'sharp';

export interface IpadRegion {
  /** Top-left x in screenshot pixels. */
  x: number;
  /** Top-left y in screenshot pixels. */
  y: number;
  /** Width of the iPad region in screenshot pixels. */
  w: number;
  /** Height of the iPad region in screenshot pixels. */
  h: number;
  /** Width of the source screenshot in pixels. */
  frameW: number;
  /** Height of the source screenshot in pixels. */
  frameH: number;
}

const SCAN_WIDTH = 240;
const BRIGHT_THRESHOLD = 40;  // mean RGB; below this is treated as black-bar.
// JPEG-compressed black letterbox columns decode at ~16 luminance; real
// iPad content is 100+. 40 leaves a comfortable gap between the two.
/** Bounds are inflated by this many native px on each side, mainly so a
 *  cursor right at the iPad edge isn't clipped when extracted as a
 *  template. Callers that need the *tight* content rect (e.g. building
 *  a logical→screenshot transform for label coordinates) should subtract
 *  this on each side. Exported so they can do that without duplicating
 *  the constant. */
export const NATIVE_MARGIN = 6;
const MIN_REGION_FRACTION = 0.3;  // if detected region < 30% of frame area, assume detection failed

export async function detectIpadRegion(screenshotJpeg: Buffer): Promise<IpadRegion> {
  const meta = await sharp(screenshotJpeg).metadata();
  const frameW = meta.width ?? 0;
  const frameH = meta.height ?? 0;
  if (!frameW || !frameH) {
    throw new Error('detectIpadRegion: screenshot has no dimensions');
  }

  // Downscale to a small RGB buffer for fast column/row scanning. The
  // tiny resolution is plenty to find dark/bright transitions and
  // keeps the inner loop cheap.
  const W = SCAN_WIDTH;
  const H = Math.round((W * frameH) / frameW);
  const { data } = await sharp(screenshotJpeg)
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Per-column and per-row average luminance.
  const colBright = new Float32Array(W);
  const rowBright = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      colBright[x] += lum;
      rowBright[y] += lum;
    }
  }
  for (let x = 0; x < W; x++) colBright[x] /= H;
  for (let y = 0; y < H; y++) rowBright[y] /= W;

  const firstBright = (arr: Float32Array): number => {
    for (let i = 0; i < arr.length; i++) if (arr[i] > BRIGHT_THRESHOLD) return i;
    return 0;
  };
  const lastBright = (arr: Float32Array): number => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > BRIGHT_THRESHOLD) return i;
    return arr.length - 1;
  };

  const x0 = firstBright(colBright);
  const x1 = lastBright(colBright);
  const y0 = firstBright(rowBright);
  const y1 = lastBright(rowBright);

  const sx = frameW / W;
  const sy = frameH / H;
  const region: IpadRegion = {
    x: Math.max(0, Math.round(x0 * sx) - NATIVE_MARGIN),
    y: Math.max(0, Math.round(y0 * sy) - NATIVE_MARGIN),
    w: Math.min(frameW, Math.round((x1 - x0 + 1) * sx) + 2 * NATIVE_MARGIN),
    h: Math.min(frameH, Math.round((y1 - y0 + 1) * sy) + 2 * NATIVE_MARGIN),
    frameW,
    frameH,
  };

  if (region.w * region.h < frameW * frameH * MIN_REGION_FRACTION) {
    // Almost-black frame or detection failed — fall back to full frame
    // so callers still get sensible coordinates.
    return { x: 0, y: 0, w: frameW, h: frameH, frameW, frameH };
  }
  return region;
}

/**
 * Affine transform from iPad-logical-points to PiKVM-screenshot pixels.
 * The iPad app reports cursor positions in its logical coordinate
 * space; the screenshot stores them centered inside the detected iPad
 * region.
 */
export interface LogicalToScreenshot {
  toScreenshotPx(logicalX: number, logicalY: number): { x: number; y: number };
  region: IpadRegion;
  logicalW: number;
  logicalH: number;
}

export function buildTransform(
  region: IpadRegion,
  logicalW: number,
  logicalH: number,
): LogicalToScreenshot {
  if (logicalW <= 0 || logicalH <= 0) {
    throw new Error(`buildTransform: invalid logical size ${logicalW}×${logicalH}`);
  }
  const scaleX = region.w / logicalW;
  const scaleY = region.h / logicalH;
  return {
    region,
    logicalW,
    logicalH,
    toScreenshotPx(logicalX: number, logicalY: number) {
      return {
        x: region.x + logicalX * scaleX,
        y: region.y + logicalY * scaleY,
      };
    },
  };
}
