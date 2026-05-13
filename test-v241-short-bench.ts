/**
 * v0.5.241 short bench with lock-contamination guards.
 *
 * Phase 318 fix for Phase 317 verification: keep bench short enough
 * to finish before iPad re-locks (~5 min idle window). 3 trials × 60s
 * = ~3 min. Also detect "stuck detection" pattern: if 2 consecutive
 * trials report identical detected position (within 5 px), abort —
 * that's the lock-screen tautology pattern from the v0.5.241
 * 10-trial bench.
 *
 * If detection is real, residuals/positions will vary across trials.
 * If detection is tautology, positions will be identical.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad, isLikelyLockScreen } from './src/pikvm/ipad-unlock.js';
import { clickAtWithRetry } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/v241-short/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== v0.5.241 short bench at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

// Allow target override via CLI arg: `tsx test-v241-short-bench.ts books`
const TARGETS_BY_NAME = {
  settings: { name: 'Settings', x: 905, y: 800 },
  books:    { name: 'Books',    x: 640, y: 800 },
  tv:       { name: 'TV',       x: 773, y: 800 },
  appstore: { name: 'AppStore', x: 905, y: 680 },
};
const targetKey = (process.argv[2] ?? 'settings').toLowerCase() as keyof typeof TARGETS_BY_NAME;
const TARGET = TARGETS_BY_NAME[targetKey] ?? TARGETS_BY_NAME.settings;
const N = 3;

interface Trial {
  trial: number;
  residualPx: number | null;
  detectedPos: { x: number; y: number } | null;
  attempts: number;
  success: boolean;
  duration: number;
}
const trials: Trial[] = [];

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

for (let i = 1; i <= N; i++) {
  console.error(`--- Trial ${i} ---`);
  try {
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  } catch {
    await unlockIpad(client, { dragPx: 1500 });
    await sleep(800);
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  }
  await sleep(1500);

  const pre = await client.screenshot();
  await fs.writeFile(path.join(ROOT, `t${i}-pre.jpg`), pre.buffer);

  // Phase 318: check if iPad re-locked between trials. If so, attempt
  // recovery; abort the trial if still locked.
  if (await isLikelyLockScreen(pre.buffer)) {
    console.error(`  ⚠ iPad re-locked — attempting recovery`);
    await unlockIpad(client, { dragPx: 1500 });
    await sleep(1000);
    const post = await client.screenshot();
    if (await isLikelyLockScreen(post.buffer)) {
      console.error(`  ⚠ Re-unlock failed — aborting bench`);
      trials.push({
        trial: i, residualPx: null, detectedPos: null, attempts: 0, success: false,
        duration: 0,
      });
      break;
    }
    console.error(`  ✓ Recovered from lock screen`);
  }

  const start = Date.now();
  let result;
  try {
    result = await clickAtWithRetry(
      client,
      { x: TARGET.x, y: TARGET.y },
      {
        maxRetries: 3,
        requireVerifiedCursor: true,
        moveToOptions: {
          strategy: 'detect-then-move',
          forbidSlamFallback: true,
          profile: profile ?? undefined,
        },
      },
    );
  } catch (e) {
    console.error(`  THREW: ${(e as Error).message.slice(0, 100)}`);
    trials.push({
      trial: i, residualPx: null, detectedPos: null, attempts: 0, success: false,
      duration: Date.now() - start,
    });
    break;
  }

  const dur = Date.now() - start;
  const success = result.success && (result.finalVerification?.screenChanged ?? false);
  const detectedPos = result.finalMoveResult.finalDetectedPosition ?? null;

  const post = await client.screenshot();
  await fs.writeFile(path.join(ROOT, `t${i}-post.jpg`), post.buffer);

  trials.push({
    trial: i,
    residualPx: result.finalMoveResult.finalResidualPx,
    detectedPos,
    attempts: result.attempts,
    success,
    duration: dur,
  });
  console.error(
    `  residual=${result.finalMoveResult.finalResidualPx?.toFixed(0) ?? 'n/a'}px ` +
    `detected=${detectedPos ? `(${detectedPos.x},${detectedPos.y})` : 'NULL'} ` +
    `attempts=${result.attempts} click=${success ? '✓' : '✗'} ${dur}ms`,
  );

  // Phase 318 stuck-detection guard: if 2 consecutive trials report
  // identical detected position (within 5 px), abort — the iPad is
  // likely locked or stuck in a state where detection is tautological.
  if (i >= 2) {
    const prev = trials[trials.length - 2];
    if (prev.detectedPos && detectedPos) {
      const motionBetweenTrials = Math.hypot(
        prev.detectedPos.x - detectedPos.x,
        prev.detectedPos.y - detectedPos.y,
      );
      if (motionBetweenTrials < 5) {
        console.error(`  ⚠ Detected position identical to previous trial (Δ=${motionBetweenTrials.toFixed(1)}px). Likely lock-screen contamination — aborting.`);
        break;
      }
    }
  }
}

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, trials }, null, 2));

const successes = trials.filter(t => t.success).length;
const detected = trials.filter(t => t.detectedPos !== null).length;
console.error(`\n=== Aggregate ===`);
console.error(`Trials run:   ${trials.length}/${N}`);
console.error(`Detected:     ${detected}/${trials.length}`);
console.error(`Click hits:   ${successes}/${trials.length}`);
console.error(`Results: ${ROOT}/results.json`);
process.exit(0);
