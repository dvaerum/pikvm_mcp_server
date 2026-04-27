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
import { sleep } from './util.js';

export interface Point {
  x: number;
  y: number;
}

export interface Cluster {
  pixels: number;
  centroidX: number;
  centroidY: number;
  /** Mean R over the cluster's pixels in the source RGB frame. Populated
   *  only when `findClusters` is called with a `sourceRgb` argument.
   *  Used by detectMotion's optional achromatic filter to reject colored
   *  widget animations at the cluster level (where anti-aliased cursor
   *  edges aren't an issue, unlike pixel-level filtering). */
  meanR?: number;
  meanG?: number;
  meanB?: number;
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
  /** Maximum allowed channel imbalance for a pixel to count as cursor-
   *  colored. iPadOS cursor is achromatic (R≈G≈B); animated colored
   *  widgets (weather icons, clock-second hand) have much larger
   *  channel deltas and are rejected. Default 25 — tight enough to
   *  reject colored UI elements, loose enough to allow JPEG noise on
   *  the gray cursor. Set to 0 to disable. */
  maxChannelDelta: number;
}

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  diffThreshold: 30,
  minClusterSize: 4,
  maxClusterSize: 2500,
  mergeRadius: 30,
  brightnessFloor: 170,
  // Default 0 = no pixel-level saturation filter. Pixel-level filtering
  // kills anti-aliased cursor edges (where R/G/B differ due to alpha
  // blending against the wallpaper). The right place to filter colored-
  // widget noise is at the CLUSTER level — see filterAchromaticClusters
  // below — which inspects the cluster's centroid colour after the
  // cluster has formed from all (including blended) pixels.
  maxChannelDelta: 0,
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

/**
 * A screenshot together with its decoded RGB pixels. Pass this through the
 * detection pipeline to avoid paying the JPEG-decode cost more than once
 * per frame.
 */
export interface DecodedScreenshot {
  /** The raw JPEG buffer — kept around so callers can still hand it to
   *  sharp for re-encoding (e.g. saving a cursor template). */
  buffer: Buffer;
  /** Decoded RGB pixels, length = width × height × 3. */
  rgb: Buffer;
  width: number;
  height: number;
}

/** Decode a screenshot's JPEG buffer once and return both the buffer and
 *  the decoded RGB pixels in a single object. */
export async function decodeScreenshot(buffer: Buffer): Promise<DecodedScreenshot> {
  const decoded = await decodeToRgb(buffer);
  return {
    buffer,
    rgb: decoded.data,
    width: decoded.width,
    height: decoded.height,
  };
}

export function diffPixels(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  threshold: number,
  brightnessFloor = 0,
  /** Maximum allowed channel imbalance (max - min over R/G/B) for a
   *  pixel to count as cursor-colored. iPadOS cursor is achromatic
   *  (grayscale white-ish), so its R, G, B values are within ~20 of
   *  each other. Animated colored widgets (clock-second hand, weather
   *  icons) have larger imbalances and are rejected.
   *  Pass 0 (default) to disable saturation filtering — backward
   *  compatible with callers that don't care about colour. */
  maxChannelDelta = 0,
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
    const ar = a[offset];
    const ag = a[offset + 1];
    const ab = a[offset + 2];
    const br = b[offset];
    const bg = b[offset + 1];
    const bb = b[offset + 2];
    if (brightnessFloor > 0) {
      // Phase 8: pass a pixel if EITHER frame has bright RGB at this
      // location. The cursor is bright in whichever frame contains it;
      // the OTHER frame has the (often-dim) wallpaper revealed. Checking
      // only frame B's brightness (the previous behaviour) silently
      // culled the pre-cluster on dim wallpapers, which is why
      // locateCursor's "need ≥2 sized clusters" check kept failing on
      // the iPad home screen.
      const aBright = ar >= brightnessFloor && ag >= brightnessFloor && ab >= brightnessFloor;
      const bBright = br >= brightnessFloor && bg >= brightnessFloor && bb >= brightnessFloor;
      if (!aBright && !bBright) {
        mask[i] = false;
        continue;
      }
    }
    if (maxChannelDelta > 0) {
      const cMax = Math.max(br, bg, bb);
      const cMin = Math.min(br, bg, bb);
      if (cMax - cMin > maxChannelDelta) {
        mask[i] = false;
        continue;
      }
    }
    mask[i] = true;
  }
  return mask;
}

export function findClusters(
  mask: boolean[],
  width: number,
  height: number,
  minSize: number,
  maxSize: number,
  /** Optional source RGB buffer (3 bytes per pixel, row-major). When
   *  provided, each cluster gets `meanR`, `meanG`, `meanB` populated
   *  by averaging the source pixels covered by the cluster. */
  sourceRgb?: Buffer,
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
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      while (queue.length > 0) {
        const ci = queue.pop()!;
        const cx = ci % width;
        const cy = (ci - cx) / width;
        sumX += cx;
        sumY += cy;
        if (sourceRgb) {
          const off = ci * 3;
          sumR += sourceRgb[off];
          sumG += sourceRgb[off + 1];
          sumB += sourceRgb[off + 2];
        }
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
        const c: Cluster = {
          pixels: count,
          centroidX: Math.round(sumX / count),
          centroidY: Math.round(sumY / count),
        };
        if (sourceRgb) {
          c.meanR = sumR / count;
          c.meanG = sumG / count;
          c.meanB = sumB / count;
        }
        clusters.push(c);
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
    let weightedR = 0;
    let weightedG = 0;
    let weightedB = 0;
    let haveColor = true;
    for (const idx of members) {
      const c = clusters[idx];
      totalPixels += c.pixels;
      weightedX += c.centroidX * c.pixels;
      weightedY += c.centroidY * c.pixels;
      if (c.meanR !== undefined && c.meanG !== undefined && c.meanB !== undefined) {
        weightedR += c.meanR * c.pixels;
        weightedG += c.meanG * c.pixels;
        weightedB += c.meanB * c.pixels;
      } else {
        haveColor = false;
      }
    }
    const m: Cluster = {
      pixels: totalPixels,
      centroidX: Math.round(weightedX / totalPixels),
      centroidY: Math.round(weightedY / totalPixels),
    };
    if (haveColor) {
      m.meanR = weightedR / totalPixels;
      m.meanG = weightedG / totalPixels;
      m.meanB = weightedB / totalPixels;
    }
    merged.push(m);
  }

  return merged;
}

/** Diff two pre-decoded screenshots. Use this when you already have the
 *  decoded RGB on hand (e.g. inside `moveToPixel`'s open-loop loop) to
 *  avoid the redundant `sharp` decode that the buffer-taking variant does. */
export function diffScreenshotsDecoded(
  a: DecodedScreenshot,
  b: DecodedScreenshot,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
): Cluster[] {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('Screenshot dimensions changed between captures');
  }
  const mask = diffPixels(
    a.rgb, b.rgb, a.width, a.height,
    config.diffThreshold,
    config.brightnessFloor,
    config.maxChannelDelta,
  );
  const raw = findClusters(
    mask,
    a.width,
    a.height,
    config.minClusterSize,
    config.maxClusterSize,
    b.rgb,
  );
  return mergeClusters(raw, config.mergeRadius);
}

/** Convenience wrapper for callers that only have the JPEG buffers. */
export async function diffScreenshots(
  bufA: Buffer,
  bufB: Buffer,
  config: DetectionConfig = DEFAULT_DETECTION_CONFIG,
): Promise<Cluster[]> {
  const [a, b] = await Promise.all([decodeScreenshot(bufA), decodeScreenshot(bufB)]);
  return diffScreenshotsDecoded(a, b, config);
}

// ============================================================================
// Helpers for ballistics / move-to
// ============================================================================

async function takeRawScreenshot(client: PiKVMClient): Promise<Buffer> {
  const result = await client.screenshot();
  return result.buffer;
}

/**
 * Options for `locateCursor`.
 *
 * The probe is a small known mouse delta used to create two frames with the
 * cursor in different positions, so `diffScreenshots` can find it.
 *
 * **Caller contract:** after this function returns, the cursor is at
 * `result.position` (NOT at its original pre-probe position). The function
 * does NOT attempt to restore the cursor — iPadOS pointer acceleration is
 * asymmetric, so a compensating move can leave the cursor anywhere between
 * the pre and post positions, silently lying about its post-call state.
 * Callers that want the cursor restored should re-locate after their move.
 */
export interface LocateCursorOptions {
  probeDelta?: number;        // default 10 (mickeys, +x direction)
  settleMs?: number;          // default 300 (ms between move and screenshot — must exceed PiKVM streamer + iPadOS render latency, measured at 150-235 ms; see docs/troubleshooting/ipad-cursor-detection.md)
  detection?: Partial<DetectionConfig>;
  maxAttempts?: number;       // default 3, for transient diff failures
  /** Phase 27: spatial hint. When set, candidate cluster pairs are
   *  ranked by proximity of the post-cluster centroid to this hint.
   *  Pairs further than `expectedNearRadius` from the hint are
   *  REJECTED. This eliminates widget-animation false positives on
   *  iPad busy backdrops, where the algorithm already knows roughly
   *  where the cursor should be (e.g., from the previous iteration's
   *  probe in a closed-loop correction sequence). Without a hint
   *  (default), all cluster pairs are considered equally — the
   *  previous behavior. */
  expectedNear?: Point;
  /** Phase 27: max allowed distance (px) from post-cluster centroid
   *  to expectedNear. Default 200. Generous enough to cover one
   *  iteration's emit-step displacement plus iPadOS acceleration
   *  variance, tight enough to reject widget false positives that
   *  are typically 400+ px from the actual cursor on iPad home. */
  expectedNearRadius?: number;
  verbose?: boolean;
}

export interface LocateCursorResult {
  /** Cursor position AFTER the probe (i.e. where it is when this returns). */
  position: Point;
  /** Where the cursor was BEFORE the probe — informational. */
  prePosition: Point;
  probeOffsetPx: Point;       // observed displacement from the probe
  /** Signed mickey count emitted in the successful probe (the probe
   *  was X-axis only, so y is always 0). Lets the caller compute
   *  px/mickey ratio = |probeOffsetPx.x| / |probeMickeys.x| without
   *  having to run a separate calibration probe — `locateCursor`
   *  has already done the work. */
  probeMickeys: Point;
  clusterCount: number;       // for diagnostics
}

/**
 * Locate the current cursor position by probing — send a small known delta,
 * diff before/after screenshots, identify the cluster pair.
 *
 * Returns null if detection fails after retries (e.g. cursor hidden, screen
 * too noisy, cursor on a region that doesn't diff well).
 *
 * Default `detection.brightnessFloor` is 100 (lowered from the
 * DEFAULT_DETECTION_CONFIG of 170). The 170 default rejects cursor pixels
 * rendered over dimmed-modal scrims; 100 catches them. Callers can still
 * pass a higher floor via `detection.brightnessFloor` for very-bright
 * contexts where false positives are a concern.
 */
export async function locateCursor(
  client: PiKVMClient,
  options: LocateCursorOptions = {},
): Promise<LocateCursorResult | null> {
  // Phase 29 finding: probeDelta=10 was too small. iPadOS amplifies
  // small mickey commands by up to 20×, so a 10-mickey probe could
  // produce 200 px displacement — well outside the previous [3, 40]
  // px sanity window. Live: 6/6 probes returned null with the old
  // defaults. Larger probe (60 mickeys) gives the cursor pair a
  // displacement that dwarfs animation-noise inter-cluster distances
  // (typically <50 px), which is what makes pair selection work.
  const baseProbeDelta = options.probeDelta ?? 60;
  const settleMs = options.settleMs ?? 300;
  const maxAttempts = options.maxAttempts ?? 3;
  // Default brightness floor lowered from 170 to 100 — same fix as
  // detectMotion in move-to.ts. iPadOS dimmed-modal contexts render the
  // cursor with channel values 100-160; the 170 floor was rejecting them.
  const detection: DetectionConfig = {
    ...DEFAULT_DETECTION_CONFIG,
    brightnessFloor: 100,
    ...options.detection,
  };

  // Probe-size sweep. iPad UI contexts vary — small probe (10 mickeys)
  // is fast and works on quiet screens; larger probes (30, 60) produce
  // more diff signal on busy/animated screens at the cost of moving the
  // cursor more. Try increasing sizes per attempt so we don't fail on
  // busy screens just because the default 10-mickey probe was too small.
  const probeDeltas = [
    baseProbeDelta,
    Math.max(baseProbeDelta * 3, 30),
    Math.max(baseProbeDelta * 6, 60),
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probeDelta = probeDeltas[Math.min(attempt, probeDeltas.length - 1)];
    // Phase 29: widened sanity window to [probeDelta * 0.3, probeDelta * 25]
    // (was * 0.3 to * 4) to accommodate iPadOS pointer-acceleration
    // amplification of up to ~20× on small mickey emits. The wider
    // window admits more candidates, but the high lower bound (probeDelta
    // * 0.3) still rejects animation-noise pairs that are typically
    // separated by < 0.3 * probeDelta = 18 px (for probeDelta=60).
    const expDispMinLocal = probeDelta * 0.3;
    const expDispMaxLocal = probeDelta * 25;

    // Wake-up move: iPadOS fades cursor after ~1 s of inactivity. If the
    // BEFORE screenshot captures a faded cursor, the diff between BEFORE
    // (no visible cursor) and AFTER (cursor at post-probe position) only
    // produces ONE cluster — the appear-cluster — and pair selection fails.
    //
    // Phase 29 finding (2026-04-26): the previous +30/-30 round trip
    // (net 0 displacement) was insufficient — live: 6/6 locateCursor
    // calls returned null on the iPad home screen because the BEFORE
    // shot still had no rendered cursor. A larger one-shot motion (-120
    // mickeys + 500 ms settle) DOES make the cursor visible (verified
    // via cursor-visibility test-client mode). Switching wakeup to
    // larger one-shot single-direction motion lets iPadOS render the
    // cursor before BEFORE shot. The cursor's net position drifts by
    // wakeMagnitude * iPadOS-ratio, but we don't depend on a specific
    // pre-probe position — pre and post are both observed via diff.
    await client.mouseMoveRelative(-120, 0);
    await sleep(settleMs);

    const before = await takeRawScreenshot(client);
    await sleep(settleMs);

    await client.mouseMoveRelative(probeDelta, 0);
    await sleep(settleMs);
    const after = await takeRawScreenshot(client);

    // NB: no compensating move. iPadOS pointer-acceleration asymmetry
    // means a -probeDelta call doesn't undo a +probeDelta call. Returning
    // the cursor's actual current position (post-probe) is honest; faking
    // a restore that doesn't actually restore is what poisoned the
    // algorithm in earlier iterations.

    let clusters: Cluster[];
    try {
      clusters = await diffScreenshots(before, after, detection);
    } catch {
      if (options.verbose) console.error(`[locateCursor] attempt ${attempt + 1}: diff threw`);
      continue;
    }

    // Filter to cursor-sized clusters first — rejects animated widget
    // noise (clock seconds, weather, etc.) on busy screens that produce
    // many large clusters. Phase 14b: clusterMin lowered from 8 to 4 to
    // match moveToPixel — iPad cursor cluster is just 4-7 bright pixels
    // after the brightness floor culls anti-aliased edges. The 8-px floor
    // was rejecting the real cursor and admitting only widget noise.
    const sized = clusters.filter((c) => c.pixels >= 4 && c.pixels <= 90);

    if (sized.length < 2) {
      if (options.verbose) {
        console.error(
          `[locateCursor] attempt ${attempt + 1}: ${clusters.length} total, ${sized.length} cursor-sized [4-90px] (need ≥2)`,
        );
      }
      continue;
    }

    // The probe was +x by `probeDelta` mickeys. Pick the pair whose
    // displacement best matches: roughly +x direction, distance close to
    // probeDelta * (typical px/mickey ≈ 1.0). On a quiet screen this is
    // just `clusters.length === 2`; on busy screens we filter out
    // unrelated motion.
    let pre: Cluster | null = null;
    let post: Cluster | null = null;
    let bestScore = -Infinity;
    const expectedDispMin = expDispMinLocal;
    const expectedDispMax = expDispMaxLocal;
    const expectedNear = options.expectedNear;
    const expectedNearRadius = options.expectedNearRadius ?? 200;
    for (const aClu of sized) {
      for (const bClu of sized) {
        if (aClu === bClu) continue;
        const dx = bClu.centroidX - aClu.centroidX;
        const dy = bClu.centroidY - aClu.centroidY;
        // Probe is +x, so we want dx > 0 and |dy| small.
        if (dx <= 0) continue;
        const mag = Math.hypot(dx, dy);
        if (mag < expectedDispMin || mag > expectedDispMax) continue;
        // Direction within ~30° of +x.
        if (dx / mag < 0.85) continue;
        // Phase 27: locality filter. When the caller provides a hint
        // about where the cursor should be, hard-reject pairs whose
        // post-centroid is far from that hint. Eliminates widget
        // false positives on iPad busy backdrops.
        if (expectedNear) {
          const distToHint = Math.hypot(
            bClu.centroidX - expectedNear.x,
            bClu.centroidY - expectedNear.y,
          );
          if (distToHint > expectedNearRadius) continue;
        }
        // Score: closer to expected magnitude wins. Also prefer
        // similarly-sized clusters (same cursor at two positions).
        const sizeRatio =
          Math.max(aClu.pixels, bClu.pixels) /
          Math.max(1, Math.min(aClu.pixels, bClu.pixels));
        if (sizeRatio > 4) continue;
        // Phase 27: when expectedNear is provided, also prefer pairs
        // whose post-cluster is closer to the hint (tie-break in favor
        // of the more-plausible candidate when multiple pass the gate).
        let score = -Math.abs(mag - probeDelta) - 5 * Math.log2(sizeRatio);
        if (expectedNear) {
          const distToHint = Math.hypot(
            bClu.centroidX - expectedNear.x,
            bClu.centroidY - expectedNear.y,
          );
          score -= distToHint * 0.05;
        }
        if (score > bestScore) {
          bestScore = score;
          pre = aClu;
          post = bClu;
        }
      }
    }

    if (!pre || !post) {
      if (options.verbose) {
        console.error(
          `[locateCursor] attempt ${attempt + 1}: ${sized.length} cursor-sized clusters but no +x pair within ${expectedDispMin}-${expectedDispMax}px`,
        );
      }
      continue;
    }
    const probeOffsetPx: Point = {
      x: post.centroidX - pre.centroidX,
      y: post.centroidY - pre.centroidY,
    };

    if (options.verbose) {
      console.error(
        `[locateCursor] pre=(${pre.centroidX},${pre.centroidY}) post=(${post.centroidX},${post.centroidY}) offset=(${probeOffsetPx.x},${probeOffsetPx.y}) — cursor now at post`,
      );
    }

    return {
      probeMickeys: { x: probeDelta, y: 0 },
      // post = where the cursor IS after this function returns.
      position: { x: post.centroidX, y: post.centroidY },
      prePosition: { x: pre.centroidX, y: pre.centroidY },
      probeOffsetPx,
      clusterCount: clusters.length,
    };
  }

  return null;
}

// ============================================================================
// Template matching — fallback cursor detection that doesn't rely on motion.
// ============================================================================

/**
 * A cursor template captured from a screenshot at a known cursor position.
 * Stored as raw RGB pixels with explicit dimensions so we don't pay the
 * decode cost on every match.
 */
export interface CursorTemplate {
  /** Raw RGB pixel data, length = width × height × 3. */
  rgb: Buffer;
  width: number;
  height: number;
}

/**
 * Crop a square region from a pre-decoded screenshot centred on a known
 * cursor position and return it as a `CursorTemplate`. Used to build a
 * template after the first successful motion-based detection.
 */
export function extractCursorTemplateDecoded(
  screenshot: DecodedScreenshot,
  centre: Point,
  size = 24,
): CursorTemplate {
  const half = Math.floor(size / 2);
  const left = Math.max(0, Math.min(screenshot.width - size, centre.x - half));
  const top = Math.max(0, Math.min(screenshot.height - size, centre.y - half));

  const out = Buffer.allocUnsafe(size * size * 3);
  for (let y = 0; y < size; y++) {
    const srcOffset = ((top + y) * screenshot.width + left) * 3;
    screenshot.rgb.copy(out, y * size * 3, srcOffset, srcOffset + size * 3);
  }
  return { rgb: out, width: size, height: size };
}

/** Convenience wrapper for callers that only have the JPEG buffer. */
export async function extractCursorTemplate(
  screenshot: Buffer,
  centre: Point,
  size = 24,
): Promise<CursorTemplate> {
  const decoded = await decodeScreenshot(screenshot);
  return extractCursorTemplateDecoded(decoded, centre, size);
}

/**
 * Pre-computed sums used by normalised cross-correlation; computed once for
 * a template so repeated matching is fast.
 */
interface TemplateStats {
  template: CursorTemplate;
  mean: [number, number, number];
  /** sum of (px - mean)² across all template pixels and channels. */
  varianceSum: number;
}

function computeTemplateStats(t: CursorTemplate): TemplateStats {
  const n = t.width * t.height;
  let sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    sumR += t.rgb[o];
    sumG += t.rgb[o + 1];
    sumB += t.rgb[o + 2];
  }
  const mean: [number, number, number] = [sumR / n, sumG / n, sumB / n];
  let varianceSum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const dr = t.rgb[o] - mean[0];
    const dg = t.rgb[o + 1] - mean[1];
    const db = t.rgb[o + 2] - mean[2];
    varianceSum += dr * dr + dg * dg + db * db;
  }
  return { template: t, mean, varianceSum };
}

/**
 * Normalised cross-correlation between a template and a region of the
 * screenshot. Returns a value in [-1, 1]; 1 = identical, 0 = uncorrelated.
 *
 * Resilient to per-channel brightness offsets (e.g. cursor over a darker
 * vs lighter wallpaper area), because the mean of each region is
 * subtracted before correlation.
 */
function correlateAt(
  screen: Buffer,
  screenWidth: number,
  region: TemplateStats,
  topLeftX: number,
  topLeftY: number,
): number {
  const t = region.template;
  const n = t.width * t.height;
  // Compute region mean
  let sumR = 0, sumG = 0, sumB = 0;
  for (let y = 0; y < t.height; y++) {
    const screenRow = ((topLeftY + y) * screenWidth + topLeftX) * 3;
    for (let x = 0; x < t.width; x++) {
      const o = screenRow + x * 3;
      sumR += screen[o];
      sumG += screen[o + 1];
      sumB += screen[o + 2];
    }
  }
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;

  let dot = 0;
  let regionVariance = 0;
  for (let y = 0; y < t.height; y++) {
    const screenRow = ((topLeftY + y) * screenWidth + topLeftX) * 3;
    const tRow = y * t.width * 3;
    for (let x = 0; x < t.width; x++) {
      const so = screenRow + x * 3;
      const to = tRow + x * 3;
      const sr = screen[so] - meanR;
      const sg = screen[so + 1] - meanG;
      const sb = screen[so + 2] - meanB;
      const tr = t.rgb[to] - region.mean[0];
      const tg = t.rgb[to + 1] - region.mean[1];
      const tb = t.rgb[to + 2] - region.mean[2];
      dot += sr * tr + sg * tg + sb * tb;
      regionVariance += sr * sr + sg * sg + sb * sb;
    }
  }
  const denom = Math.sqrt(regionVariance * region.varianceSum);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface FindCursorOptions {
  /** Optional search window — only correlate within
   *  (centre.x ± window, centre.y ± window). Defaults to whole frame. */
  searchCentre?: Point;
  searchWindow?: number;
  /** Minimum correlation score to accept (0..1). Default 0.6. iPadOS
   *  cursor against varied wallpapers usually scores 0.7+. */
  minScore?: number;
  /** Step in pixels between correlation samples. 1 = exhaustive
   *  (slowest, pixel-perfect); higher values trade accuracy for speed.
   *  Default 4 — well within `moveToPixel`'s 30-px residual tolerance,
   *  ~16× faster than step=1 and ~4× faster than step=2. Drop to 1-2
   *  when sub-pixel cursor centring matters. */
  step?: number;
  /** Phase 11 (multi-template ranking only): when supplied, prefer
   *  per-template matches whose position is within `expectedNearRadius`
   *  of this hint over far high-scoring matches. Anchors selection to
   *  recently-confirmed cursor position so a stable false positive at
   *  a fixed iPad UI element doesn't beat the real cursor in a
   *  correction-pass fallback. Ignored by `findCursorByTemplateDecoded`
   *  (single-template). */
  expectedNear?: Point;
  expectedNearRadius?: number;
  verbose?: boolean;
}

export interface FindCursorResult {
  position: Point;
  score: number;
}

/**
 * Find the cursor in a pre-decoded screenshot by template matching.
 * Returns the best match position and its correlation score, or null if
 * the score fell below `minScore`.
 *
 * Use this as a fallback when motion-as-probe diff fails to find a cursor
 * pair (e.g. the user passed `correct: false` and no movement happened
 * between captures, or the screen is too noisy for diffing).
 */
export function findCursorByTemplateDecoded(
  screenshot: DecodedScreenshot,
  template: CursorTemplate,
  options: FindCursorOptions = {},
): FindCursorResult | null {
  const stats = computeTemplateStats(template);
  const step = options.step ?? 4;
  // Live data on the iPad: real cursor matches score 0.85-0.97; stable
  // false positives over a dimmed modal scrim score 0.74-0.82. 0.83
  // separates them cleanly. Callers wanting looser matching can pass
  // a smaller value via FindCursorOptions.minScore.
  const minScore = options.minScore ?? 0.83;

  let xMin = 0, xMax = screenshot.width - template.width;
  let yMin = 0, yMax = screenshot.height - template.height;
  if (options.searchCentre && options.searchWindow !== undefined) {
    const w = options.searchWindow;
    xMin = Math.max(0, Math.floor(options.searchCentre.x - w - template.width / 2));
    xMax = Math.min(screenshot.width - template.width, Math.ceil(options.searchCentre.x + w - template.width / 2));
    yMin = Math.max(0, Math.floor(options.searchCentre.y - w - template.height / 2));
    yMax = Math.min(screenshot.height - template.height, Math.ceil(options.searchCentre.y + w - template.height / 2));
  }

  let bestScore = -Infinity;
  let bestX = 0;
  let bestY = 0;
  for (let y = yMin; y <= yMax; y += step) {
    for (let x = xMin; x <= xMax; x += step) {
      const score = correlateAt(screenshot.rgb, screenshot.width, stats, x, y);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (options.verbose) {
    console.error(
      `[template-match] best score=${bestScore.toFixed(3)} at (${bestX + Math.floor(template.width / 2)}, ` +
        `${bestY + Math.floor(template.height / 2)}) (window=${xMin}-${xMax}×${yMin}-${yMax}, step=${step})`,
    );
  }

  if (bestScore < minScore) return null;
  return {
    position: {
      x: bestX + Math.floor(template.width / 2),
      y: bestY + Math.floor(template.height / 2),
    },
    score: bestScore,
  };
}

/** Convenience wrapper for callers that only have the JPEG buffer. */
export async function findCursorByTemplate(
  screenshot: Buffer,
  template: CursorTemplate,
  options: FindCursorOptions = {},
): Promise<FindCursorResult | null> {
  const decoded = await decodeScreenshot(screenshot);
  return findCursorByTemplateDecoded(decoded, template, options);
}

export interface FindCursorSetResult extends FindCursorResult {
  /** Index in the input templates[] of the template that won. Lets the
   *  caller tell which captured backdrop best matched the current frame
   *  (e.g. for diagnostic logging). */
  templateIndex: number;
}

/**
 * Multi-template variant of findCursorByTemplateDecoded. Iterates the
 * supplied template set, runs each one's NCC search, and returns the
 * highest-scoring match across all templates.
 *
 * Used to recover detection across the different backdrops the cursor
 * encounters during a session — a single cached template captured against
 * one wallpaper context tends to dip below threshold once the cursor
 * moves over a different context.
 *
 * Returns null when the set is empty or no template's best score reaches
 * `options.minScore`.
 */
export function findCursorByTemplateSet(
  screenshot: DecodedScreenshot,
  templates: CursorTemplate[],
  options: FindCursorOptions = {},
): FindCursorSetResult | null {
  if (templates.length === 0) return null;
  // Pass minScore=0 to each individual call so we always get the best-
  // available score back; we apply the minScore threshold once at the
  // outer level after picking the winner.
  const innerOpts: FindCursorOptions = { ...options, minScore: 0 };
  const allMatches: FindCursorSetResult[] = [];
  for (let i = 0; i < templates.length; i++) {
    const r = findCursorByTemplateDecoded(screenshot, templates[i], innerOpts);
    if (r) allMatches.push({ ...r, templateIndex: i });
  }
  if (allMatches.length === 0) return null;

  // Phase 11: locality-aware ranking. When a hint is provided, prefer
  // matches within the hint radius over far high-scoring matches. The
  // iPad UI has fixed elements that score 0.85-0.95 against varied
  // templates; without the hint, those FPs win over the real cursor
  // sitting near the previous confirmed position.
  let best: FindCursorSetResult | null = null;
  if (options.expectedNear) {
    const hint = options.expectedNear;
    const radius = options.expectedNearRadius ?? 100;
    const within = allMatches.filter((m) =>
      Math.hypot(m.position.x - hint.x, m.position.y - hint.y) <= radius,
    );
    if (within.length > 0) {
      best = within.reduce((a, b) => (a.score >= b.score ? a : b));
    }
  }
  if (!best) {
    best = allMatches.reduce((a, b) => (a.score >= b.score ? a : b));
  }

  const minScore = options.minScore ?? 0.83;
  if (best.score < minScore) return null;
  return best;
}

/**
 * Phase 120 — pure helper: given a candidate cursor position from one
 * frame and a re-found candidate position from a second frame after a
 * known emit, decide whether the candidate is the real cursor (it
 * moved as expected) or a static wallpaper false-positive (it didn't
 * move).
 *
 * Returns true iff the candidate moved by approximately `expectedDx`
 * pixels in the X axis and `expectedDy` in the Y axis, within a
 * tolerance of `toleranceFraction` of the expected magnitude (default
 * 50% — iPad acceleration variance + JPEG re-quantisation easily
 * shifts the matched position by 50% of a small emit).
 *
 * The "approximately" matters: iPad pointer acceleration applied to a
 * 10-mickey emit may produce 5-30 px of movement depending on
 * recent-velocity context. Asking for "did the cursor move at all in
 * roughly the right direction" catches false positives while still
 * accepting real cursors with variance.
 *
 * Live-discovered failure mode (Phase 119): with this gate absent,
 * `findCursorByTemplateSet` returned position (952, 916) at score
 * 0.71 against an EMPTY iPad wallpaper region for 30 consecutive
 * iterations of a visual-servo loop. The "cursor" never moved
 * because it wasn't a cursor — it was a wallpaper gradient feature
 * that happened to NCC-correlate with the cursor template.
 *
 * Pure: no I/O, deterministic.
 */
export function cursorMovedAsExpected(
  before: Point,
  after: Point,
  expectedDx: number,
  expectedDy: number,
  toleranceFraction = 0.5,
): boolean {
  const actualDx = after.x - before.x;
  const actualDy = after.y - before.y;
  // Define expected magnitude. If both axes are zero, the test is
  // ill-defined — return true (no expected motion to verify).
  const expectedMagnitude = Math.hypot(expectedDx, expectedDy);
  if (expectedMagnitude < 1) return true;
  // Per-axis tolerance: at least 3 px (handle JPEG / detection
  // quantisation noise even for very small emits) and at most
  // toleranceFraction × |expected|.
  const tolX = Math.max(3, Math.abs(expectedDx) * toleranceFraction);
  const tolY = Math.max(3, Math.abs(expectedDy) * toleranceFraction);
  // The cursor must move in the right DIRECTION on each non-zero axis
  // (sign matches) AND the magnitude must be within tolerance of the
  // expected magnitude (between expected/2 and expected*2 ish, but
  // clamped per axis above).
  if (Math.abs(expectedDx) >= 1) {
    if (Math.sign(actualDx) !== Math.sign(expectedDx)) return false;
    if (Math.abs(actualDx - expectedDx) > tolX && Math.abs(actualDx) < Math.abs(expectedDx) - tolX) return false;
  }
  if (Math.abs(expectedDy) >= 1) {
    if (Math.sign(actualDy) !== Math.sign(expectedDy)) return false;
    if (Math.abs(actualDy - expectedDy) > tolY && Math.abs(actualDy) < Math.abs(expectedDy) - tolY) return false;
  }
  return true;
}

/**
 * Persist a cursor template to disk for reuse across invocations.
 */
export async function saveCursorTemplate(
  template: CursorTemplate,
  filePath: string,
): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Write as a JPEG so we can inspect it as an image; encode raw RGB via sharp.
  const jpeg = await sharp(template.rgb, {
    raw: { width: template.width, height: template.height, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  await fs.writeFile(filePath, jpeg);
}

/**
 * Load a cursor template previously written by `saveCursorTemplate`.
 * Returns null if the file is missing.
 */
export async function loadCursorTemplate(
  filePath: string,
): Promise<CursorTemplate | null> {
  const { promises: fs } = await import('fs');
  try {
    const buf = await fs.readFile(filePath);
    const decoded = await decodeToRgb(buf);
    return { rgb: decoded.data, width: decoded.width, height: decoded.height };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}
