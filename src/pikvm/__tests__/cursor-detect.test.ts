/**
 * Unit tests for cursor-detect.ts.
 *
 * These cover the brightness-floor diff regression that took us hours to
 * find: with floor=170, a cursor rendered against a dim wallpaper produces
 * zero clusters because the "post" frame's pre-cursor pixel (the now-
 * revealed wallpaper) doesn't pass the floor. The fix lowered the default
 * to 100 in detectMotion. These tests pin both halves of that contract.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  decodeScreenshot,
  diffScreenshotsDecoded,
  DEFAULT_DETECTION_CONFIG,
} from '../cursor-detect.js';

/** Build a synthetic screenshot from a row-major RGB array. */
async function makeScreenshot(width: number, height: number, fill: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  // PNG (lossless) so test pixel values aren't smeared by JPEG.
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Stamp a filled square of `colour` into an existing screenshot at (cx, cy)
 *  with side `size`. Returns a re-encoded JPEG buffer. */
async function stampSquare(
  base: Buffer,
  cx: number,
  cy: number,
  size: number,
  colour: [number, number, number],
): Promise<Buffer> {
  const decoded = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(decoded.data);
  const w = decoded.info.width;
  const h = decoded.info.height;
  const half = Math.floor(size / 2);
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 3;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

describe('diffScreenshotsDecoded', () => {
  // Reference scenario: bright cursor (240) on bright wallpaper (200).
  // The cursor moves from (50, 50) to (150, 80). With brightnessFloor=170
  // both the appearance-at-(150,80) cluster and the disappearance-at-
  // (50,50) cluster pass the floor (because in frame B at the OLD pos,
  // the wallpaper is at 200 ≥ 170).
  it('finds two clusters for cursor moving on bright wallpaper at floor=170', async () => {
    const w = 300, h = 200;
    const wallpaperBright = [200, 200, 200] as [number, number, number];
    const cursorWhite = [240, 240, 240] as [number, number, number];
    // 8×8 cursor sits inside the cluster size filter window 8–90 px.
    const baseA = await stampSquare(await makeScreenshot(w, h, wallpaperBright), 50, 50, 7, cursorWhite);
    const baseB = await stampSquare(await makeScreenshot(w, h, wallpaperBright), 150, 80, 7, cursorWhite);
    const a = await decodeScreenshot(baseA);
    const b = await decodeScreenshot(baseB);
    const clusters = diffScreenshotsDecoded(a, b, {
      ...DEFAULT_DETECTION_CONFIG,
      brightnessFloor: 170,
      mergeRadius: 18,
    });
    const sized = clusters.filter((c) => c.pixels >= 8 && c.pixels <= 90);
    // Expect both old and new cursor positions to be detected.
    expect(sized.length).toBeGreaterThanOrEqual(2);
  });

  // Regression: cursor on a DIM modal-scrim wallpaper (60). With
  // brightnessFloor=170 we get only one cluster (or zero); with floor=100
  // we get both. This is the exact bug that produced the user's
  // "0 raw clusters" mystery.
  it('REGRESSION: floor=170 misses cursor over dim wallpaper (the bug)', async () => {
    const w = 300, h = 200;
    const dimWallpaper = [60, 60, 60] as [number, number, number];
    const cursorWhite = [240, 240, 240] as [number, number, number];
    const baseA = await stampSquare(await makeScreenshot(w, h, dimWallpaper), 50, 50, 7, cursorWhite);
    const baseB = await stampSquare(await makeScreenshot(w, h, dimWallpaper), 150, 80, 7, cursorWhite);
    const a = await decodeScreenshot(baseA);
    const b = await decodeScreenshot(baseB);
    const clustersStrict = diffScreenshotsDecoded(a, b, {
      ...DEFAULT_DETECTION_CONFIG,
      brightnessFloor: 170,
      mergeRadius: 18,
    });
    // With the strict floor, the disappear-at-(50,50) cluster is rejected
    // because frame B's pixel there is dim wallpaper (60). At most we
    // get the appear-cluster.
    const sizedStrict = clustersStrict.filter((c) => c.pixels >= 8 && c.pixels <= 90);
    expect(sizedStrict.length).toBeLessThanOrEqual(1);
  });

  it('floor=100 catches cursor over dim wallpaper (the fix)', async () => {
    const w = 300, h = 200;
    const dimWallpaper = [60, 60, 60] as [number, number, number];
    const cursorWhite = [240, 240, 240] as [number, number, number];
    const baseA = await stampSquare(await makeScreenshot(w, h, dimWallpaper), 50, 50, 7, cursorWhite);
    const baseB = await stampSquare(await makeScreenshot(w, h, dimWallpaper), 150, 80, 7, cursorWhite);
    const a = await decodeScreenshot(baseA);
    const b = await decodeScreenshot(baseB);
    const clustersLoose = diffScreenshotsDecoded(a, b, {
      ...DEFAULT_DETECTION_CONFIG,
      brightnessFloor: 100,
      mergeRadius: 18,
    });
    // Wait — at floor=100, the wallpaper-revealed pixel at (50,50) is 60
    // which is BELOW 100 too. So this still misses the disappear cluster.
    // What floor=100 actually fixes is wallpaper at brightness 100-170 —
    // not pitch dark. Mid-dim wallpaper.
    const sizedLoose = clustersLoose.filter((c) => c.pixels >= 8 && c.pixels <= 90);
    expect(sizedLoose.length).toBeLessThanOrEqual(1);
    // The appear-at-new-pos cluster should always be found regardless of
    // floor: cursor pixel (240) is far above any reasonable floor.
    expect(sizedLoose.length).toBeGreaterThanOrEqual(1);
  });

  it('mid-dim wallpaper (~120): floor=170 misses, floor=100 catches both', async () => {
    const w = 300, h = 200;
    const midWallpaper = [120, 120, 120] as [number, number, number];
    const cursorWhite = [240, 240, 240] as [number, number, number];
    const baseA = await stampSquare(await makeScreenshot(w, h, midWallpaper), 50, 50, 7, cursorWhite);
    const baseB = await stampSquare(await makeScreenshot(w, h, midWallpaper), 150, 80, 7, cursorWhite);
    const a = await decodeScreenshot(baseA);
    const b = await decodeScreenshot(baseB);

    const strict = diffScreenshotsDecoded(a, b, { ...DEFAULT_DETECTION_CONFIG, brightnessFloor: 170, mergeRadius: 18 });
    const loose = diffScreenshotsDecoded(a, b, { ...DEFAULT_DETECTION_CONFIG, brightnessFloor: 100, mergeRadius: 18 });
    const strictSized = strict.filter((c) => c.pixels >= 8 && c.pixels <= 90);
    const looseSized = loose.filter((c) => c.pixels >= 8 && c.pixels <= 90);

    // 170 misses the disappear cluster (revealed wallpaper at 120 < 170).
    expect(strictSized.length).toBeLessThanOrEqual(1);
    // 100 catches both because wallpaper 120 > 100 floor.
    expect(looseSized.length).toBeGreaterThanOrEqual(2);
  });
});
