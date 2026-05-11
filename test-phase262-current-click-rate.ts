/**
 * Phase 262: measure CURRENT production click rate at v0.5.220
 * after Phase 255 cleanup and Phase 257-261 shape-detector
 * exploration (not integrated).
 *
 * Phase 247 baseline N=20 was 25% within 35 px on this same
 * target. Cleanup phase removed only opt-in default-off options,
 * so the rate should be unchanged. This bench confirms no
 * regression.
 *
 * If rate is dramatically different (≥ 50% or ≤ 5%), something
 * unexpected changed. Investigate.
 *
 * Methodology:
 *   - Target: (905, 800) — Settings-icon vicinity, matching
 *     Phase 247 baseline
 *   - N=20 single-attempt trials (no retry, no skip-click gate)
 *   - For each: re-home, moveToPixel, record finalDetectedPosition
 *     residual
 *   - No clicks performed; we measure positional accuracy only,
 *     which is the per-attempt input to clickAtWithRetry's
 *     residual gate
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase262-click-rate';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 262 current click rate at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 905, y: 800 };
const N = 20;
const TOLERANCE_PX = 35;

interface Trial {
  index: number;
  detected: { x: number; y: number } | null;
  residual: number | null;
  withinTolerance: boolean;
}

const trials: Trial[] = [];

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);

  // Re-home before each trial for reproducible starting state
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  let detected: { x: number; y: number } | null = null;
  let residual: number | null = null;
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    if (r.finalDetectedPosition) {
      detected = { x: r.finalDetectedPosition.x, y: r.finalDetectedPosition.y };
      residual = Math.hypot(detected.x - TARGET.x, detected.y - TARGET.y);
    }
  } catch (e) {
    console.error(`  moveToPixel threw: ${(e as Error).message.slice(0, 100)}`);
  }

  const within = residual !== null && residual <= TOLERANCE_PX;
  trials.push({ index: i, detected, residual, withinTolerance: within });

  console.error(
    `  detected=${detected ? `(${detected.x},${detected.y})` : 'null'} ` +
    `residual=${residual !== null ? residual.toFixed(0).padStart(4) + ' px' : 'n/a'} ` +
    `${within ? '✓' : '✗'}`,
  );

  // Save post-move screenshot for inspection
  try {
    const shot = await client.screenshot();
    await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-post.jpg`, shot.buffer);
  } catch {/* ignore */}
}

const valid = trials.filter(t => t.residual !== null);
const nulls = trials.filter(t => t.residual === null);
const passed = trials.filter(t => t.withinTolerance).length;

console.error(`\n\n=== RESULT ===`);
console.error(`Version: ${VERSION}`);
console.error(`Target:  (${TARGET.x}, ${TARGET.y}) — Settings-icon vicinity`);
console.error(`Trials:  ${N} total, ${nulls.length} null, ${valid.length} valid`);
console.error(`Passed:  ${passed}/${N} (${((passed / N) * 100).toFixed(1)}%) within ${TOLERANCE_PX} px`);

if (valid.length > 0) {
  const residuals = valid.map(t => t.residual!);
  residuals.sort((a, b) => a - b);
  const median = residuals[Math.floor(residuals.length / 2)];
  const p95 = residuals[Math.floor(residuals.length * 0.95)];
  console.error(`Median residual: ${median.toFixed(0)} px`);
  console.error(`P95 residual:    ${p95.toFixed(0)} px`);
}

console.error(`\nResiduals across all trials:`);
for (const t of trials) {
  console.error(`  t${t.index.toString().padStart(2, '0')}: ${
    t.residual !== null ? t.residual.toFixed(0).padStart(4) + ' px' : 'null'
  } ${t.withinTolerance ? '✓' : '✗'}`);
}

console.error(`\n=== COMPARISON ===`);
console.error(`Phase 247 baseline (Phase 215 state memory): N=20 = 25% within 35 px`);
console.error(`Phase 262 current   (v${VERSION}, post-cleanup): N=${N} = ${((passed/N)*100).toFixed(0)}% within ${TOLERANCE_PX} px`);
console.error('');
if (Math.abs(passed / N - 0.25) < 0.1) {
  console.error('VERDICT: Unchanged baseline. Cleanup (Phase 255) did not regress production.');
} else if (passed / N > 0.35) {
  console.error('VERDICT: HIGHER than baseline. Something improved (or this run got lucky).');
} else if (passed / N < 0.15) {
  console.error('VERDICT: LOWER than baseline. Something may have regressed — investigate.');
} else {
  console.error('VERDICT: Within normal variance of baseline (Phase 237 lesson: N=20 swings 5-40%).');
}
process.exit(0);
