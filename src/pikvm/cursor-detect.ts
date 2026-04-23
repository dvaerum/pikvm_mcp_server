/**
 * Cursor detection via screenshot diffing.
 *
 * Decodes two JPEG frames to raw RGB, diffs them, and returns connected-
 * component clusters of changed pixels. Nearby clusters (e.g. cursor body
 * and its drop shadow) are merged into one.
 *
 * Lifted from auto-calibrate.ts so both the calibration algorithm and the
 * ballistics/move-to modules can share one cursor-locator implementation.
 */

import sharp from 'sharp';
import type { PiKVMClient } from './client.js';

export interface Point {
  x: number;
  y: number;
}

export interface Cluster {
  pixels: number;
  centroidX: number;
  centroidY: number;
}

export interface DetectionConfig {
  diffThreshold: number;
  minClusterSize: number;
  maxClusterSize: number;
  mergeRadius: number;
  /** Per-channel brightness floor for a pixel to count as "cursor-bright".
   *  iPadOS's mouse cursor is white/gray (~200-240 per channel). Most
   *  widget-animation diffs change darker pixels (weather icons, clock
   *  hands). Requiring the after-pixel to be bright filters those out.
   *  Set to 0 to disable brightness filtering. */
  brightnessFloor: number;
}

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  diffThreshold: 30,
  minClusterSize: 4,
  maxClusterSize: 2500,
  mergeRadius: 30,
  brightnessFloor: 170,
};

// ============================================================================
// Low-level pixel operations
// ============================================================================

export async function decodeToRgb(
  buffer: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  const image = sharp(buffer).removeAlpha().raw();
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function diffPixels(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  threshold: number,
  brightnessFloor = 0,
): boolean[] {
  const total = width * height;
  const mask = new Array<boolean>(total);
  for (let i = 0; i < total; i++) {
    const offset = i * 3;
    const dr = Math.abs(a[offset] - b[offset]);
    const dg = Math.abs(a[offset + 1] - b[offset + 1]);
    const db = Math.abs(a[offset + 2] - b[offset + 2]);
    if ((dr + dg + db) < threshold) {
      mask[i] = false;
      continue;
    }
    if (brightnessFloor > 0) {
      // Pixel must have become bright in B (cursor-colored: roughly equal
      // R/G/B and above brightnessFloor).
      const br = b[offset];
      const bg = b[offset + 1];
      const bb = b[offset + 2];
      mask[i] = br >= brightnessFloor && bg >= brightnessFloor && bb >= brightnessFloor;
    } else {
      mask[i] = true;
    }
  }
  return mask;
}

export function findClusters(
  mask: boolean[],
  width: number,
  height: number,
  minSize: number,
  maxSize: number,
): Cluster[] {
  const visited = new Uint8Array(width * height);
  const clusters: Cluster[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) continue;

      const queue: number[] = [idx];
      visited[idx] = 1;
      let sumX = 0;
      let sumY = 0;
      let count = 0;

      while (queue.length > 0) {
        const ci = queue.pop()!;
        const cx = ci % width;
        const cy = (ci - cx) / width;
        sumX += cx;
        sumY += cy;
        count++;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const ni = ny * width + nx;
            if (!mask[ni] || visited[ni]) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }

      if (count >= minSize && count <= maxSize) {
        clusters.push({
          pixels: count,
          centroidX: Math.round(sumX / count),
          centroidY: Math.round(sumY / count),
        });
      }
    }
  }

  return clusters;
}

export function mergeClusters(clusters: Cluster[], mergeRadius: number): Cluster[] {
  if (clusters.length <= 1) return clusters;

  const parent = clusters.map((_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const dx = clusters[i].centroidX - clusters[j].centroidX;
      const dy = clusters[i].centroidY - clusters[j].centroidY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= mergeRadius) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < clusters.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const merged: Cluster[] = [];
  for (const members of groups.values()) {
    let totalPixels = 0;
    let weightedX = 0;
    let weightedY = 0;
    for (const idx of members) {
      const c = clusters[idx];
      totalPixels += c.pixels;
      weightedX += c.centroidX * c.pixels;
      weightedY += c.centroidY * c.pixels;
    }
    merged.push({
      pixels: totalPixels,
      centroidX: Math.round(weightedX / totalPixels),
      centroidY: Math.round(weightedY / totalPixels),
    });
  }

  return merged;
}

export async function diffScreenshots(
  bufA: Buffer,
  bufB: Buffer,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
): Promise<Cluster[]> {
  const imgA = await decodeToRgb(bufA);
  const imgB = await decodeToRgb(bufB);

  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error('Screenshot dimensions changed between captures');
  }

  const mask = diffPixels(
    imgA.data,
    imgB.data,
    imgA.width,
    imgA.height,
    config.diffThreshold,
    config.brightnessFloor,
  );
  const raw = findClusters(mask, imgA.width, imgA.height, config.minClusterSize, config.maxClusterSize);
  return mergeClusters(raw, config.mergeRadius);
}

// ============================================================================
// Helpers for ballistics / move-to
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeRawScreenshot(client: PiKVMClient): Promise<Buffer> {
  const result = await client.screenshot();
  return result.buffer;
}

/**
 * Options for `locateCursor`.
 *
 * The probe is a small known mouse delta used to create two frames with the
 * cursor in different positions, so `diffScreenshots` can find it. After the
 * probe, a compensating move returns the pointer close to where it started.
 */
export interface LocateCursorOptions {
  probeDelta?: number;        // default 10 (mickeys, +x direction)
  settleMs?: number;          // default 150 (ms between move and screenshot)
  detection?: Partial<DetectionConfig>;
  maxAttempts?: number;       // default 3, for transient diff failures
  verbose?: boolean;
}

export interface LocateCursorResult {
  position: Point;            // cursor position in screenshot-pixel space
  probeOffsetPx: Point;       // observed displacement from the probe
  clusterCount: number;       // for diagnostics
}

/**
 * Locate the current cursor position by probing — send a small known delta,
 * diff before/after screenshots, pick the cluster that corresponds to the
 * pre-probe position. Restores the cursor with a compensating delta.
 *
 * Returns null if detection fails after retries (e.g. cursor hidden, screen
 * too noisy, cursor on a region that doesn't diff well).
 */
export async function locateCursor(
  client: PiKVMClient,
  options: LocateCursorOptions = {},
): Promise<LocateCursorResult | null> {
  const probeDelta = options.probeDelta ?? 10;
  const settleMs = options.settleMs ?? 150;
  const maxAttempts = options.maxAttempts ?? 3;
  const detection: DetectionConfig = { ...DEFAULT_DETECTION_CONFIG, ...options.detection };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before = await takeRawScreenshot(client);
    await sleep(settleMs);

    await client.mouseMoveRelative(probeDelta, 0);
    await sleep(settleMs);
    const after = await takeRawScreenshot(client);

    // Compensate (best-effort — iPadOS acceleration makes this approximate).
    await client.mouseMoveRelative(-probeDelta, 0);
    await sleep(settleMs);

    let clusters: Cluster[];
    try {
      clusters = await diffScreenshots(before, after, detection);
    } catch {
      if (options.verbose) console.error(`[locateCursor] attempt ${attempt + 1}: diff threw`);
      continue;
    }

    if (clusters.length !== 2) {
      if (options.verbose) {
        console.error(`[locateCursor] attempt ${attempt + 1}: ${clusters.length} clusters (expected 2)`);
      }
      continue;
    }

    // The probe was in +x direction, so the cluster with smaller x is the
    // pre-probe position (what we want).
    const [a, b] = clusters;
    const pre = a.centroidX <= b.centroidX ? a : b;
    const post = pre === a ? b : a;
    const probeOffsetPx: Point = {
      x: post.centroidX - pre.centroidX,
      y: post.centroidY - pre.centroidY,
    };

    if (options.verbose) {
      console.error(
        `[locateCursor] pre=(${pre.centroidX},${pre.centroidY}) post=(${post.centroidX},${post.centroidY}) offset=(${probeOffsetPx.x},${probeOffsetPx.y})`,
      );
    }

    return {
      position: { x: pre.centroidX, y: pre.centroidY },
      probeOffsetPx,
      clusterCount: clusters.length,
    };
  }

  return null;
}
