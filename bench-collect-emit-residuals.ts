/**
 * M1 data collection: for each (intended_emit, cursor_state),
 * record the actual cursor displacement.
 *
 * Per trial:
 *   1. wake cursor (small wiggle)
 *   2. capture frame A
 *   3. record cursor position estimate from ML detector
 *   4. emit (dx_mickeys, dy_mickeys) in a SINGLE call
 *   5. sleep settle_ms
 *   6. capture frame B
 *   7. record cursor position estimate from ML detector
 *   8. log everything; save both frames
 *
 * Displacement = (after - before) in pixels.
 *
 * Inputs vary across:
 *   - magnitude: 5, 15, 30, 60, 100, 150
 *   - direction: 8 cardinal/diagonal (0°, 45°, ..., 315°)
 *   - cursor starting region: 3 (top-row icons, middle widgets,
 *     bottom-row icons)
 *
 * 6 mag × 8 dir × 3 region × 3 reps = 432 trials.
 *
 * Output:
 *   data/emit-residuals/samples.jsonl — one line per trial
 *   data/emit-residuals/<trial>/{pre,post}.jpg — frame pairs
 *
 * Usage: PIKVM_ML_MODEL=ml/cursor-v3.onnx npx tsx bench-collect-emit-residuals.ts [reps=3]
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { findCursorByML } from './src/pikvm/cursor-ml-detect.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';
import { keepCursorAlive } from './src/pikvm/cursor-keepalive.js';

const REPS = process.argv[2] !== undefined ? Number(process.argv[2]) : 3;
const SEED = process.argv[3] !== undefined ? Number(process.argv[3]) : 42;
const ROOT = process.env.PIKVM_EMIT_DIR ?? './data/emit-residuals';
const LOG = path.join(ROOT, 'samples.jsonl');

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const MAGNITUDES = [5, 8, 12, 20, 30, 50, 80, 120, 180];
const DIRECTIONS_DEG = [0, 45, 90, 135, 180, 225, 270, 315];
const POSITIONS_PER_RUN = 8; // random starting positions sampled per outer loop

interface Region { name: string; x: number; y: number; }
function randomPosition(rng: () => number): Region {
  const x = Math.round(560 + rng() * 580); // iPad x-range ~560-1140
  const y = Math.round(150 + rng() * 700); // iPad y-range ~150-850
  return { name: `pos_${x}_${y}`, x, y };
}

const SETTLE_MS = 120;
const PRE_WAKE_WIGGLE = 5; // small wiggle to wake before frame A

await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

interface Sample {
  trial: number;
  region: string;
  start_hint: { x: number; y: number };
  magnitude: number;
  direction_deg: number;
  emit: { dx: number; dy: number };
  pre_pred: { x: number; y: number; confidence: number } | null;
  post_pred: { x: number; y: number; confidence: number } | null;
  observed_dx: number | null;
  observed_dy: number | null;
  observed_magnitude: number | null;
  pre_jpg: string;
  post_jpg: string;
}

async function detectAtHint(jpeg: Buffer, hint: { x: number; y: number }) {
  const r = await findCursorByML(jpeg, 1680, 1050, {
    hint, minConfidence: 0.0,
  });
  if (r === null) return null;
  return { x: r.x, y: r.y, confidence: r.confidence };
}

// Move cursor to roughly the region's target by emitting toward it from
// wherever it currently is. We don't need pixel precision here — just
// "start somewhere in this region of screen so we have varied
// starting points across the dataset."
async function approxMoveTo(region: Region, currentHint: { x: number; y: number }) {
  const dx_px = region.x - currentHint.x;
  const dy_px = region.y - currentHint.y;
  // Approximate iPad px/mickey ratio
  const RATIO = 1.3;
  const dxM = Math.round(dx_px / RATIO);
  const dyM = Math.round(dy_px / RATIO);
  await client.mouseMoveRelative(dxM, dyM);
  await new Promise((r) => setTimeout(r, 200));
}

await ipadGoHome(client);
await new Promise((r) => setTimeout(r, 900));
const totalTrials = POSITIONS_PER_RUN * MAGNITUDES.length * DIRECTIONS_DEG.length * REPS;
console.error(`Collecting ${totalTrials} samples across ${POSITIONS_PER_RUN} random positions...`);

let trialId = 0;
let currentHint = { x: 1100, y: 900 };

// Deterministic RNG for reproducibility (seed from argv)
let rngState = SEED;
const rng = () => {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
};

const positions: Region[] = [];
for (let i = 0; i < POSITIONS_PER_RUN; i++) positions.push(randomPosition(rng));

for (const region of positions) {
  console.error(`Position ${region.name} at (${region.x},${region.y})...`);
  await approxMoveTo(region, currentHint);
  currentHint = { x: region.x, y: region.y };

  for (let rep = 0; rep < REPS; rep++) {
    for (const magnitude of MAGNITUDES) {
      for (const dirDeg of DIRECTIONS_DEG) {
        trialId++;
        const rad = dirDeg * Math.PI / 180;
        const dx = Math.round(Math.cos(rad) * magnitude);
        const dy = Math.round(Math.sin(rad) * magnitude);

        // Wake cursor
        await client.mouseMoveRelative(PRE_WAKE_WIGGLE, 0);
        await client.mouseMoveRelative(-PRE_WAKE_WIGGLE, 0);
        await new Promise((r) => setTimeout(r, 50));

        // Frame A + detect
        const preShot = await client.screenshot();
        const prePred = await detectAtHint(preShot.buffer, currentHint);

        // Save pre frame
        const trialDir = path.join(ROOT, String(trialId).padStart(4, '0'));
        await fs.mkdir(trialDir, { recursive: true });
        const preJpg = path.join(trialDir, 'pre.jpg');
        await fs.writeFile(preJpg, preShot.buffer);

        // Emit the test motion
        await client.mouseMoveRelative(dx, dy);
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        // Frame B + detect
        await keepCursorAlive(client, { staleThresholdMs: 50 });
        const postShot = await client.screenshot();
        const postPred = await detectAtHint(
          postShot.buffer,
          prePred ? { x: prePred.x + dx, y: prePred.y + dy } : currentHint,
        );
        const postJpg = path.join(trialDir, 'post.jpg');
        await fs.writeFile(postJpg, postShot.buffer);

        let obsDx: number | null = null;
        let obsDy: number | null = null;
        let obsMag: number | null = null;
        if (prePred && postPred) {
          obsDx = postPred.x - prePred.x;
          obsDy = postPred.y - prePred.y;
          obsMag = Math.hypot(obsDx, obsDy);
        }

        const sample: Sample = {
          trial: trialId,
          region: region.name,
          start_hint: prePred ?? currentHint,
          magnitude,
          direction_deg: dirDeg,
          emit: { dx, dy },
          pre_pred: prePred,
          post_pred: postPred,
          observed_dx: obsDx,
          observed_dy: obsDy,
          observed_magnitude: obsMag,
          pre_jpg: preJpg,
          post_jpg: postJpg,
        };
        await fs.appendFile(LOG, JSON.stringify(sample) + '\n');

        if (postPred) {
          currentHint = { x: postPred.x, y: postPred.y };
        }

        // If cursor drifts off-screen, snap it back to region center
        if (
          currentHint.x < 550 || currentHint.x > 1150 ||
          currentHint.y < 50 || currentHint.y > 1010
        ) {
          await approxMoveTo(region, currentHint);
          currentHint = { x: region.x, y: region.y };
        }

        if (trialId % 20 === 0) {
          console.error(
            `  ${trialId}: ${region.name} mag=${magnitude} dir=${dirDeg}° ` +
            `emit=(${dx},${dy}) obs=` +
            (obsMag !== null ? `(${obsDx},${obsDy})` : 'NULL'),
          );
        }
      }
    }
  }
}

console.error(`\nDone. ${trialId} trials → ${LOG}`);
