/**
 * ML cursor detector — self-supervised data collection harness.
 *
 * Generates (frame, cursor_xy) training pairs by exploiting the
 * fact that we control the cursor. We emit a small displacement
 * and diff before/after frames — the cursor is the only thing
 * that moved (modulo iPad rendering jitter).
 *
 * Protocol per sample pair:
 *   1. Take frame A
 *   2. Emit displacement Δ = (+20, +20) chunked (small step, low
 *      risk of triggering gestures)
 *   3. Sleep settle
 *   4. Take frame B
 *   5. Compute diff = |A - B|, threshold dark pixels
 *   6. Find the largest cluster in diff — that's the cursor's
 *      OR position (in frame A) AND THEN position (in frame B)
 *      — they should be 2 separate clusters if Δ moved cursor
 *      enough
 *   7. If diff produces exactly 2 clusters of similar size, label
 *      frame A's cursor as cluster centroid 1, frame B's cursor
 *      as cluster centroid 2. Δ direction tells us which is which.
 *   8. Save both (frame, cursor_xy, source='wiggle-diff') pairs
 *      to data/cursor-training-v0/
 *
 * Output JSON sidecar per frame:
 *   {
 *     frame_path: 'data/cursor-training-v0/{ts}_{idx}.jpg',
 *     cursor: { x, y } | null,
 *     confidence: 'high' | 'medium' | 'low',
 *     source: 'wiggle-diff' | 'cursor-shape-detect' | 'manual',
 *     timestamp: ISO,
 *     ipad_state: 'home' | 'lock' | 'app',
 *     wallpaper_hash: hex (to track wallpaper variants)
 *   }
 *
 * Usage:
 *   npx tsx bench-collect-cursor-data.ts [N=200]
 *
 * Loops N times. Diverse cursor positions by walking around home
 * screen via small emits.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { unlockIpad, ipadGoHome } from './src/pikvm/ipad-unlock.js';
import { findClusters, mergeClusters, decodeScreenshot } from './src/pikvm/cursor-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const N = parseInt(process.argv[2] ?? '200', 10);
const OUT = `./data/cursor-training-v0`;
await fs.mkdir(OUT, { recursive: true });

console.error(`=== ML cursor data collection at v${VERSION} ===`);
console.error(`Target: ${N} sample pairs (= 2 × N labeled frames)`);
console.error(`Output: ${OUT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

interface Label {
  frame_path: string;
  cursor: { x: number; y: number } | null;
  confidence: 'high' | 'medium' | 'low';
  source: 'wiggle-diff' | 'wiggle-diff-fallback';
  timestamp: string;
  diffStats: {
    cluster1?: { x: number; y: number; pixels: number };
    cluster2?: { x: number; y: number; pixels: number };
    raw_cluster_count: number;
  };
  emit: { dx: number; dy: number };
  ipad_state: 'home' | 'lock' | 'app' | 'unknown';
}

async function chunkEmit(dx: number, dy: number) {
  let remX = Math.abs(dx);
  let remY = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(15, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(15, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    await sleep(30);
  }
}

const labels: Label[] = [];
let savedFrames = 0;
let highConfidencePairs = 0;
let lowConfidenceRejects = 0;

for (let i = 0; i < N; i++) {
  // Wander cursor by random small displacement to diversify positions
  if (i > 0) {
    const wanderDx = (Math.random() - 0.5) * 60;
    const wanderDy = (Math.random() - 0.5) * 60;
    await chunkEmit(Math.round(wanderDx), Math.round(wanderDy));
    await sleep(150);
  }

  // Re-unlock + re-home periodically to keep iPad responsive
  if (i > 0 && i % 25 === 0) {
    try {
      await ipadGoHome(client, { forceHomeViaSwipe: true });
    } catch {
      await unlockIpad(client, { dragPx: 1500 });
      await sleep(800);
      await ipadGoHome(client, { forceHomeViaSwipe: true });
    }
    await sleep(1500);
  }

  // 1. Take frame A
  const shotA = await client.screenshot();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const tagA = `${ts}_${i.toString().padStart(4, '0')}_A`;
  const pathA = path.join(OUT, `${tagA}.jpg`);

  // 2. Emit Δ = +20, +20
  const emit = { dx: 20, dy: 20 };
  await client.mouseMoveRelative(emit.dx, emit.dy);
  await sleep(120); // settle for cursor render

  // 4. Take frame B
  const shotB = await client.screenshot();
  const tagB = `${ts}_${i.toString().padStart(4, '0')}_B`;
  const pathB = path.join(OUT, `${tagB}.jpg`);

  // 5-6. Compute diff and find clusters
  const decA = await decodeScreenshot(shotA.buffer);
  const decB = await decodeScreenshot(shotB.buffer);
  const w = decA.width;
  const h = decA.height;
  if (decB.width !== w || decB.height !== h) {
    console.error(`  ${i}: size mismatch, skip`);
    continue;
  }
  const diffMask: boolean[] = new Array(w * h);
  for (let j = 0; j < w * h; j++) {
    const o = j * 3;
    const dr = Math.abs(decA.rgb[o] - decB.rgb[o]);
    const dg = Math.abs(decA.rgb[o + 1] - decB.rgb[o + 1]);
    const db = Math.abs(decA.rgb[o + 2] - decB.rgb[o + 2]);
    diffMask[j] = dr + dg + db > 60;
  }
  const diffClusters = findClusters(diffMask, w, h, 8, 300, decA.rgb);
  const diffMerged = mergeClusters(diffClusters, 8);

  // Look for 2 clusters with similar size (the cursor before + after).
  // They should be ~separated by emit displacement (Δ scaled by ratio).
  diffMerged.sort((a, b) => b.pixels - a.pixels);
  const top2 = diffMerged.slice(0, 2);

  let labelA: Label | null = null;
  let labelB: Label | null = null;
  let confidence: 'high' | 'medium' | 'low' = 'low';

  if (top2.length === 2 && top2[0].pixels >= 10 && top2[1].pixels >= 10) {
    // Two similar clusters — likely cursor's old + new positions.
    // The one with more advanced position in direction of emit is
    // post-emit. emit.dx > 0 means cursor moved right.
    const c1 = top2[0];
    const c2 = top2[1];
    const sizeRatio = c1.pixels / Math.max(1, c2.pixels);

    // Determine which is "before" and which is "after" by emit direction.
    // emit.dx = +20 → cursor moved right → post-emit has larger X.
    const before = c1.centroidX < c2.centroidX ? c1 : c2;
    const after = c1.centroidX < c2.centroidX ? c2 : c1;
    const sep = Math.hypot(after.centroidX - before.centroidX, after.centroidY - before.centroidY);

    if (sizeRatio < 2.5 && sep > 5 && sep < 100) {
      // Good signal: two similar-sized clusters in expected direction
      confidence = sizeRatio < 1.5 && sep > 10 ? 'high' : 'medium';
      labelA = {
        frame_path: pathA,
        cursor: { x: Math.round(before.centroidX), y: Math.round(before.centroidY) },
        confidence,
        source: 'wiggle-diff',
        timestamp: ts,
        diffStats: {
          cluster1: { x: Math.round(before.centroidX), y: Math.round(before.centroidY), pixels: before.pixels },
          cluster2: { x: Math.round(after.centroidX), y: Math.round(after.centroidY), pixels: after.pixels },
          raw_cluster_count: diffMerged.length,
        },
        emit,
        ipad_state: 'home',
      };
      labelB = {
        ...labelA,
        frame_path: pathB,
        cursor: { x: Math.round(after.centroidX), y: Math.round(after.centroidY) },
      };
    } else {
      confidence = 'low';
    }
  }

  if (labelA && labelB && confidence !== 'low') {
    await fs.writeFile(pathA, shotA.buffer);
    await fs.writeFile(pathB, shotB.buffer);
    await fs.writeFile(pathA.replace(/\.jpg$/, '.json'), JSON.stringify(labelA, null, 2));
    await fs.writeFile(pathB.replace(/\.jpg$/, '.json'), JSON.stringify(labelB, null, 2));
    labels.push(labelA, labelB);
    savedFrames += 2;
    if (confidence === 'high') highConfidencePairs++;
    if (i % 10 === 0 || i === N - 1) {
      console.error(
        `  [${i + 1}/${N}] saved frame pair: A=(${labelA.cursor!.x},${labelA.cursor!.y}) B=(${labelB.cursor!.x},${labelB.cursor!.y}) conf=${confidence}`,
      );
    }
  } else {
    lowConfidenceRejects++;
    if (i % 10 === 0) {
      console.error(
        `  [${i + 1}/${N}] REJECT — top2=${top2.length} clusters=${diffMerged.length}`,
      );
    }
  }
}

console.error(`\n=== Collection summary ===`);
console.error(`Total iterations: ${N}`);
console.error(`Frames saved: ${savedFrames}`);
console.error(`High-confidence pairs: ${highConfidencePairs}`);
console.error(`Low-confidence rejects: ${lowConfidenceRejects}`);
console.error(`Acceptance rate: ${Math.round((savedFrames / 2 / N) * 100)}%`);

// Write index
await fs.writeFile(
  path.join(OUT, 'index.json'),
  JSON.stringify({ version: VERSION, total: labels.length, labels }, null, 2),
);
console.error(`\nIndex written to ${OUT}/index.json`);
console.error(`NEXT: visually inspect a few frames + JSONs to verify label quality.`);
process.exit(0);
