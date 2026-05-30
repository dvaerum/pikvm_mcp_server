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
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  decodeScreenshot,
  diffScreenshotsDecoded,
  DEFAULT_DETECTION_CONFIG,
} from '../src/pikvm/cursor-detect.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

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

/** Phase 203b: locate the cursor in a SINGLE frame by diffing against
 *  a static reference (no-cursor frame). The reference is captured
 *  once at startup with the cursor allowed to fully fade. Each
 *  measurement frame is compared to the reference: only the cursor
 *  appears as motion-diff cluster. Picks the largest cursor-sized
 *  cluster's centroid. Returns null if no cluster found. */
function locateCursorInFrame(
  reference: any, frame: any,
): { x: number; y: number } | null {
  const clusters = diffScreenshotsDecoded(reference, frame, DEFAULT_DETECTION_CONFIG);
  if (clusters.length === 0) return null;
  // Largest cluster = cursor (assumes cursor is the only thing that
  // changed between reference and measurement).
  const biggest = clusters.reduce((a, b) => (a.size > b.size ? a : b));
  return { x: biggest.centroidX, y: biggest.centroidY };
}

/** Capture a reference frame with NO cursor visible. Goes home, waits
 *  for the cursor to fully fade (>1.5s of inactivity), then captures
 *  a plain screenshot (no wake-nudge). All subsequent measurement
 *  frames are diffed against this. */
async function captureReferenceFrame(): Promise<any> {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 1800));  // wait for cursor to fade
  const shot = await client.screenshot({ quality: 80 });
  await fs.writeFile(path.join(ROOT, 'reference-no-cursor.jpg'), shot.buffer);
  return decodeScreenshot(shot.buffer);
}

let reference: any = null;

async function setupCursorAtAnchor(): Promise<void> {
  // Move cursor to a known starting position. Slam-bottom-left is safe
  // (no hot-corner re-lock — see Phase 32). Then a small move so we
  // know it's somewhere reachable.
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 400));
  // Slam left+down to put cursor near bottom-left
  await client.mouseMoveRelative(-127, 0);
  await client.mouseMoveRelative(-127, 0);
  await client.mouseMoveRelative(-127, 0);
  await client.mouseMoveRelative(0, 127);
  await client.mouseMoveRelative(0, 127);
  await client.mouseMoveRelative(0, 127);
  await new Promise(r => setTimeout(r, 200));
  // Move back into the center area so the test moves stay on-screen
  await client.mouseMoveRelative(60, -60);
  await new Promise(r => setTimeout(r, 200));
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

  // Capture pre frame (cursor visible due to keepalive)
  const pre = await captureFrame();
  await fs.writeFile(path.join(trialDir, 'pre.jpg'), pre.buffer);
  const prePos = locateCursorInFrame(reference, pre.decoded);

  // Emit ONE single-call move with the specified pace
  const dx = axis === 'x' ? magnitude : 0;
  const dy = axis === 'y' ? magnitude : 0;
  await client.mouseMoveRelative(dx, dy);
  await new Promise(r => setTimeout(r, paceMs));

  // Capture post frame
  const post = await captureFrame();
  await fs.writeFile(path.join(trialDir, 'post.jpg'), post.buffer);
  const postPos = locateCursorInFrame(reference, post.decoded);

  let sample: Sample;
  if (!prePos || !postPos) {
    sample = {
      trial,
      axis,
      magnitude,
      pace_ms: paceMs,
      pre: prePos,
      post: postPos,
      dx_actual: null,
      dy_actual: null,
      px_per_mickey: null,
      notes: !prePos && !postPos ? 'cursor not found in either frame' : (!prePos ? 'cursor not found in pre' : 'cursor not found in post'),
    };
  } else {
    const dxActual = postPos.x - prePos.x;
    const dyActual = postPos.y - prePos.y;
    const pxAlongAxis = axis === 'x' ? dxActual : dyActual;
    sample = {
      trial,
      axis,
      magnitude,
      pace_ms: paceMs,
      pre: prePos,
      post: postPos,
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

  console.error('Capturing reference frame (no cursor)...');
  reference = await captureReferenceFrame();
  console.error(`Reference saved to ${ROOT}/reference-no-cursor.jpg`);

  for (const axis of AXES) {
    for (const magnitude of MAGNITUDES) {
      for (const paceMs of PACES_MS) {
        for (let rep = 0; rep < REPS; rep++) {
          await setupCursorAtAnchor();
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
