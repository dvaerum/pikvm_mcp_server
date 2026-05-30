/**
 * Collect cursor-visible frames for v3 training data.
 *
 * Moves the cursor across many positions, captures a screenshot
 * + ML prediction at each, saves to PIKVM_ML_CAPTURE_DIR. After
 * each emit the cursor is freshly drawn (iPadOS doesn't fade
 * mid-motion), so most captures should have a visible cursor.
 *
 * Usage:
 *   PIKVM_ML_CAPTURE_DIR=./data/ml-positives-collect \
 *     PIKVM_ML_MODEL=ml/cursor-v1.onnx \
 *     npx tsx bench-collect-positives.ts [N=80]
 *
 * Output: N frame+sidecar pairs. Visually classify them later
 * via the agent workflow and append to verified.jsonl for v3.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { findCursorByML } from '../src/pikvm/cursor-ml-detect.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { keepCursorAlive } from '../src/pikvm/cursor-keepalive.js';

const N = process.argv[2] !== undefined ? Number(process.argv[2]) : 80;
if (!process.env.PIKVM_ML_CAPTURE_DIR) {
  console.error('error: PIKVM_ML_CAPTURE_DIR must be set');
  process.exit(1);
}

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

// Approximate iPad screen bounds inside the 1680×1050 framebuffer
// (letterbox borders are black ~510-1170, ~50-1010).
const X_MIN = 600;
const X_MAX = 1100;
const Y_MIN = 200;
const Y_MAX = 900;

const RATIO = 1.3; // approximate px-per-mickey on iPad
const STEP_PX = 80; // each emit moves cursor ~80 px so it's
                    // freshly rendered (not faded)

function rnd(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

async function main() {
  await ipadGoHome(client);
  await new Promise((r) => setTimeout(r, 900));

  // Wake cursor with a small wiggle.
  await client.mouseMoveRelative(20, 0);
  await client.mouseMoveRelative(-20, 0);
  await new Promise((r) => setTimeout(r, 300));

  console.error(`Collecting ${N} positive frames...`);
  let captured = 0;
  for (let i = 0; i < N; i++) {
    // Emit a step in a random direction.
    const angle = Math.random() * 2 * Math.PI;
    const dx = Math.round(Math.cos(angle) * STEP_PX / RATIO);
    const dy = Math.round(Math.sin(angle) * STEP_PX / RATIO);
    await client.mouseMoveRelative(dx, dy);
    // Refresh cursor right before screenshot so it's bright.
    await keepCursorAlive(client, { staleThresholdMs: 100 });
    await new Promise((r) => setTimeout(r, 80));

    // Take a screenshot and run inference at a random hint inside
    // the iPad area. The hint guides the crop; the ML capture
    // env-var saves frame + sidecar automatically.
    const shot = await client.screenshot();
    const hintX = rnd(X_MIN + 128, X_MAX - 128);
    const hintY = rnd(Y_MIN + 128, Y_MAX - 128);
    const result = await findCursorByML(shot.buffer, 1680, 1050, {
      hint: { x: hintX, y: hintY },
      minConfidence: 0.0, // never null — we want the prediction
                          // even when low confidence, for labeling
    });
    captured++;
    if ((i + 1) % 10 === 0) {
      console.error(
        `  ${i + 1}/${N}: hint=(${hintX},${hintY}) ` +
        `pred=${result ? `(${result.x},${result.y}) conf=${result.confidence.toFixed(2)}` : 'null'}`,
      );
    }
  }
  console.error(`\nDone. ${captured} captures to ${process.env.PIKVM_ML_CAPTURE_DIR}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
