/**
 * Phase 203 — px/mickey data-collection bench.
 *
 * For each (axis, magnitude, pace) combination, emit a single
 * chunked move and measure the actual cursor displacement via
 * motion-diff between pre- and post-emit screenshots. With Phase 202
 * cursor-keepalive screenshots, we now get reliable detection on
 * both frames.
 *
 * Output:
 *   - JSONL at ./data/pxmickey-samples/samples.jsonl
 *   - Per-trial frame pairs at ./data/pxmickey-samples/<trial>/{pre,post}.jpg
 *
 * One row per trial:
 *   {
 *     trial, axis, magnitude, pace_ms, prev_velocity,
 *     pre_position: {x, y}, post_position: {x, y},
 *     dx_emitted_mickeys, dy_emitted_mickeys,
 *     dx_actual_pixels, dy_actual_pixels,
 *     px_per_mickey_x, px_per_mickey_y, screen_region
 *   }
 *
 * Usage: npx tsx bench-pxmickey-data.ts [reps_per_cell=3]
 *
 * Designed to feed offline curve-fitting (the user's plan: build
 * a math model of iPadOS acceleration so move-to can predict
 * actual displacement instead of guessing from the lookup table).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import {
  decodeScreenshot,
  diffScreenshotsDecoded,
  DEFAULT_DETECTION_CONFIG,
} from './src/pikvm/cursor-detect.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const REPS = Number(process.argv[2] ?? 3);
const ROOT = './data/pxmickey-samples';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'samples.jsonl');

// Sample the parameter space. iPad ballistics typically vary by:
// - Magnitude (small chunks behave linearly; large ones hit acceleration)
// - Pace (fast back-to-back triggers different acceleration than slow)
const MAGNITUDES = [3, 5, 8, 10, 15, 20, 30, 50, 80];
const PACES_MS = [10, 30, 60];
const AXES: Array<'x' | 'y'> = ['x', 'y'];

interface Sample {
  trial: number;
  axis: 'x' | 'y';
  magnitude: number;
  pace_ms: number;
  pre: { x: number; y: number } | null;
  post: { x: number; y: number } | null;
  dx_actual: number | null;
  dy_actual: number | null;
  px_per_mickey: number | null;
  notes: string;
}

let trialCount = 0;
async function appendSample(s: Sample): Promise<void> {
  await fs.appendFile(LOG, JSON.stringify(s) + '\n');
}

async function captureFrame(): Promise<{ buffer: Buffer; decoded: any }> {
  const shot = await client.screenshotKeepingCursorAlive({ quality: 80 });
  return { buffer: shot.buffer, decoded: await decodeScreenshot(shot.buffer) };
}

/** Find the cursor in a frame pair via motion-diff. Returns the
 *  centroid of the largest cluster in the cursor-size band. */
function locateCursorByDiff(
  pre: any, post: any,
): { pre: { x: number; y: number }; post: { x: number; y: number } } | null {
  const clusters = diffScreenshotsDecoded(pre, post, DEFAULT_DETECTION_CONFIG);
  if (clusters.length < 2) return null;

  // Take the two largest clusters — assume they are the cursor pre and post.
  // The one closer to the center of the frame is "post" (cursor moved
  // toward target). Without prior knowledge, pick the smaller-Y one as pre.
  const sorted = [...clusters].sort((a, b) => b.size - a.size).slice(0, 2);
  const [a, b] = sorted;
  // Heuristic: pre is the one with smaller area or earlier in scan order.
  // For axis=x emit, post.x > pre.x; for axis=y, post.y > pre.y.
  // We don't know axis here, so just return both as an unordered pair.
  return {
    pre: { x: a.centroidX, y: a.centroidY },
    post: { x: b.centroidX, y: b.centroidY },
  };
}

async function setupCursorAtCenter(): Promise<void> {
  // Move cursor to a known starting position. Use Cmd+H to go home,
  // then a small move to wake the cursor.
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 600));
  await client.mouseMoveRelative(1, 0);
  await client.mouseMoveRelative(-1, 0);
  await new Promise(r => setTimeout(r, 100));
}

async function runOneSample(
  axis: 'x' | 'y',
  magnitude: number,
  paceMs: number,
  rep: number,
): Promise<void> {
  trialCount++;
  const trial = trialCount;
  const slug = `t${trial.toString().padStart(4, '0')}-${axis}-m${magnitude}-p${paceMs}`;
  const trialDir = path.join(ROOT, slug);
  await fs.mkdir(trialDir, { recursive: true });

  // Capture pre frame
  const pre = await captureFrame();
  await fs.writeFile(path.join(trialDir, 'pre.jpg'), pre.buffer);

  // Emit ONE single-chunk move with the specified pace (no chunking,
  // single mouseMoveRelative call so we measure the raw response).
  const dx = axis === 'x' ? magnitude : 0;
  const dy = axis === 'y' ? magnitude : 0;
  await client.mouseMoveRelative(dx, dy);

  // Settle long enough to ensure motion is registered, but immediately
  // followed by the keepalive screenshot's wake nudge to keep cursor
  // visible.
  await new Promise(r => setTimeout(r, paceMs));

  // Capture post frame
  const post = await captureFrame();
  await fs.writeFile(path.join(trialDir, 'post.jpg'), post.buffer);

  // Detect cursor positions via motion-diff
  const detected = locateCursorByDiff(pre.decoded, post.decoded);

  let sample: Sample;
  if (!detected) {
    sample = {
      trial,
      axis,
      magnitude,
      pace_ms: paceMs,
      pre: null,
      post: null,
      dx_actual: null,
      dy_actual: null,
      px_per_mickey: null,
      notes: 'motion-diff failed to find a 2-cluster pair',
    };
  } else {
    // Order pre/post: if axis=x, post should have larger x
    // if axis=y, post should have larger y
    let preP = detected.pre;
    let postP = detected.post;
    if (axis === 'x' && preP.x > postP.x) [preP, postP] = [postP, preP];
    if (axis === 'y' && preP.y > postP.y) [preP, postP] = [postP, preP];
    const dxActual = postP.x - preP.x;
    const dyActual = postP.y - preP.y;
    const pxAlongAxis = axis === 'x' ? dxActual : dyActual;
    sample = {
      trial,
      axis,
      magnitude,
      pace_ms: paceMs,
      pre: preP,
      post: postP,
      dx_actual: dxActual,
      dy_actual: dyActual,
      px_per_mickey: magnitude > 0 ? pxAlongAxis / magnitude : null,
      notes: rep === 0 ? 'first-rep' : `rep-${rep}`,
    };
  }

  await appendSample(sample);
  console.error(
    `t${trial} ${axis}:m=${magnitude} p=${paceMs} rep=${rep} → ` +
    (sample.px_per_mickey !== null
      ? `px/mickey=${sample.px_per_mickey.toFixed(2)} (Δ=${(axis === 'x' ? sample.dx_actual : sample.dy_actual)?.toFixed(0)})`
      : sample.notes),
  );
}

async function main(): Promise<void> {
  console.error(`Phase 203 px/mickey data collection: ${MAGNITUDES.length} magnitudes × ${PACES_MS.length} paces × ${AXES.length} axes × ${REPS} reps = ${MAGNITUDES.length * PACES_MS.length * AXES.length * REPS} samples`);

  for (const axis of AXES) {
    for (const magnitude of MAGNITUDES) {
      for (const paceMs of PACES_MS) {
        for (let rep = 0; rep < REPS; rep++) {
          await setupCursorAtCenter();
          await runOneSample(axis, magnitude, paceMs, rep);
        }
      }
    }
  }

  console.error(`\nDone. ${trialCount} samples written to ${LOG}`);
  console.error(`Frames at ${ROOT}/<trial-slug>/{pre,post}.jpg`);
}

await main();
process.exit(0);
