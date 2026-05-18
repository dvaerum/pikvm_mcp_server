/**
 * Fix candidate (a): open-loop dead-reckon click for Books target.
 *
 * Skips the whole detection loop. After `ipadGoHome`, ASSUMES the
 * cursor is at the observed post-Cmd+H landing position (~510, 970)
 * and emits (target - that) × ratio in a small chunked sequence, then
 * clicks. No detector in the loop, no closed-loop convergence, no
 * retries based on detection feedback.
 *
 * Compare to v1 baseline (which emitted ~700-1000 mickeys LEFT and
 * ~500-1000 mickeys DOWN per trial trying to reach Books — exactly
 * the wrong direction, driven by detector tautology).
 *
 *   PIKVM_ML_MODEL=ml/cursor-v1.onnx npx tsx bench-openloop-books.ts 10
 *
 * Output:
 *   data/openloop-books/trial-N/00-after-home.jpg
 *   data/openloop-books/trial-N/01-after-emits.jpg
 *   data/openloop-books/trial-N/02-after-click.jpg
 *   data/openloop-books/trial-N/result.json
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';
import { verifyClickByDiff } from './src/pikvm/click-verify.js';
import { slamToCorner } from './src/pikvm/ballistics.js';

const TRIALS = process.argv[2] ? Number(process.argv[2]) : 10;

const TARGET = { x: 642, y: 808 };          // Books icon
// 2026-05-17: open-loop v1 ASSUMED cursor starts at (510, 970) after
// Cmd+H. Wrong — after-home frames show it lands at varied positions
// (e.g. trial 5 cursor was near (920, 510)). Fixed by slamming to
// top-left corner first. After slam, cursor is at iPad's
// top-left visible-area bound, which (per detectIpadBounds Phase 215)
// is approximately (510, 50).
const ASSUMED_START = { x: 510, y: 50 };    // post-slam top-left corner
const PX_PER_MICKEY = 1.3;                   // verified emit ratio (Phase 3 pilot)
const CHUNK_COUNT = 10;                      // smaller chunks: with slam-to-corner the total Y emit is ~583 mickeys
const CHUNK_PACE_MS = 100;                   // gap between chunks
const STRICT_MIN_CHANGED_FRACTION = 0.10;    // 10% pixel change = real app open

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/openloop-books';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'results.jsonl');

// Compute total emit (in mickeys), once.
const dxPx = TARGET.x - ASSUMED_START.x;     // +132
const dyPx = TARGET.y - ASSUMED_START.y;     // -162
const dxMickeys = Math.round(dxPx / PX_PER_MICKEY);  // +102
const dyMickeys = Math.round(dyPx / PX_PER_MICKEY);  // -125

// Per-chunk emit.
const chunkDx = Math.round(dxMickeys / CHUNK_COUNT);  // +20
const chunkDy = Math.round(dyMickeys / CHUNK_COUNT);  // -25

console.error(
  `target=${JSON.stringify(TARGET)} ` +
  `assumed_start=${JSON.stringify(ASSUMED_START)} ` +
  `total_emit=(${dxMickeys}, ${dyMickeys}) mickeys ` +
  `chunks=${CHUNK_COUNT} × (${chunkDx}, ${chunkDy}) @ ${CHUNK_PACE_MS}ms`,
);
console.error(`trials=${TRIALS}, strict threshold=${STRICT_MIN_CHANGED_FRACTION * 100}%`);

let strictHits = 0;
for (let t = 1; t <= TRIALS; t++) {
  const dir = path.join(ROOT, `trial-${t}`);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== Trial ${t}/${TRIALS} ===`);

  // 1. Home + slam-to-corner + settle.
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 900));
  // Slam puts cursor at deterministic top-left corner regardless of
  // wherever ipadGoHome left it (varies in practice).
  await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
  await new Promise(r => setTimeout(r, 400));
  const afterHomeShot = await client.screenshot();
  await fs.writeFile(path.join(dir, '00-after-home.jpg'), afterHomeShot.buffer);

  // 2. Open-loop emit chunks. No screenshots between, no detection.
  const tEmitStart = Date.now();
  for (let i = 0; i < CHUNK_COUNT; i++) {
    await client.mouseMoveRelative(chunkDx, chunkDy);
    if (i < CHUNK_COUNT - 1) {
      await new Promise(r => setTimeout(r, CHUNK_PACE_MS));
    }
  }
  // Account for rounding leftover in the final chunk.
  const sentDx = chunkDx * CHUNK_COUNT;
  const sentDy = chunkDy * CHUNK_COUNT;
  const leftoverDx = dxMickeys - sentDx;
  const leftoverDy = dyMickeys - sentDy;
  if (leftoverDx !== 0 || leftoverDy !== 0) {
    await new Promise(r => setTimeout(r, CHUNK_PACE_MS));
    await client.mouseMoveRelative(leftoverDx, leftoverDy);
  }
  const tEmitEnd = Date.now();

  // Settle so cursor renders before screenshot.
  await new Promise(r => setTimeout(r, 200));
  const afterEmitsShot = await client.screenshot();
  await fs.writeFile(path.join(dir, '01-after-emits.jpg'), afterEmitsShot.buffer);

  // 3. Click (no retry, no verify).
  const tClickStart = Date.now();
  await client.mouseClick('left');
  await new Promise(r => setTimeout(r, 400));
  const afterClickShot = await client.screenshot();
  await fs.writeFile(path.join(dir, '02-after-click.jpg'), afterClickShot.buffer);
  const tClickEnd = Date.now();

  // 4. Strict-success check.
  const v = await verifyClickByDiff(afterHomeShot.buffer, afterClickShot.buffer, {
    minChangedFraction: STRICT_MIN_CHANGED_FRACTION,
  });
  const strictSuccess = v.screenChanged;
  if (strictSuccess) strictHits++;

  const result = {
    trial: t,
    target: TARGET,
    assumed_start: ASSUMED_START,
    emitted: { dx: dxMickeys, dy: dyMickeys },
    chunks: { count: CHUNK_COUNT, dx: chunkDx, dy: chunkDy, paceMs: CHUNK_PACE_MS },
    strictSuccess,
    strictChangedFraction: v.changedFraction,
    emitMs: tEmitEnd - tEmitStart,
    clickMs: tClickEnd - tClickStart,
  };
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  await fs.appendFile(LOG, JSON.stringify(result) + '\n');

  console.error(
    `  ${strictSuccess ? 'HIT' : 'MISS'} (strict Δ=${(v.changedFraction * 100).toFixed(1)}%) ` +
    `emit=${tEmitEnd - tEmitStart}ms click+settle=${tClickEnd - tClickStart}ms`,
  );
}

console.error(
  `\n=== Books open-loop: ${strictHits}/${TRIALS} (${(100 * strictHits / TRIALS).toFixed(0)}%) ===`,
);
console.error(`logs: ${LOG}`);
