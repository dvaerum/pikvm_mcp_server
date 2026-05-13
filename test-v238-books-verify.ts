/**
 * v0.5.238 multi-hint verification — Books target only.
 *
 * Hypothesis: at v0.5.237 the Books target produced 10/10 NULL
 * detections because the cursor stayed near home (1060, 778) after
 * an iPad-rate-limited emit, and the ML 256×256 crop centered on
 * predicted (640, 800) had x-range [512, 768] which excluded the
 * cursor at x≈1060.
 *
 * v0.5.238 adds belief.position as a second hint when it differs
 * from predicted by > 200 px. With multi-hint, ML should detect
 * the cursor wherever it is (at predicted or at belief), so the
 * NULL rate should drop dramatically.
 *
 * Click-success rate is expected to stay 0/10 for Books — iPad
 * rate-limit prevents cursor reaching target — but the detector
 * should report cursor position correctly with a large residual.
 *
 * N = 10 trials, ~5-7 min runtime.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/v238-books-verify/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== v0.5.238 Books multi-hint verification at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

const TARGET = { name: 'Books', x: 640, y: 800 };
const N = 10;

interface Trial {
  trial: number;
  detected: boolean;
  detectedPos: { x: number; y: number } | null;
  residualPx: number | null;
  attempts: number;
  success: boolean;
  message: string;
  durationMs: number;
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
      trial: i, detected: false, detectedPos: null, residualPx: null,
      attempts: 0, success: false,
      message: `THREW: ${(e as Error).message.slice(0, 100)}`,
      durationMs: Date.now() - start,
    });
    await unlockIpad(client, { dragPx: 1500 }).catch(() => undefined);
    await sleep(800);
    continue;
  }

  const dur = Date.now() - start;
  const detectedPos = result.finalMoveResult.finalDetectedPosition ?? null;
  const detected = detectedPos !== null;
  const success = result.success && (result.finalVerification?.screenChanged ?? false);

  trials.push({
    trial: i,
    detected,
    detectedPos,
    residualPx: result.finalMoveResult.finalResidualPx,
    attempts: result.attempts,
    success,
    message: (result.finalVerification?.message ?? '').slice(0, 100),
    durationMs: dur,
  });

  console.error(
    `  detected=${detected ? `(${detectedPos!.x},${detectedPos!.y})` : 'NULL'} ` +
    `residual=${result.finalMoveResult.finalResidualPx !== null ? result.finalMoveResult.finalResidualPx.toFixed(0) + 'px' : 'n/a'} ` +
    `attempts=${result.attempts} click=${success ? '✓' : '✗'} ${dur}ms`,
  );
}

const detectedCount = trials.filter(t => t.detected).length;
const successCount = trials.filter(t => t.success).length;

console.error('\n=== Aggregate ===');
console.error(`Detected: ${detectedCount}/${N} (${Math.round(detectedCount/N*100)}%)`);
console.error(`Click success: ${successCount}/${N} (${Math.round(successCount/N*100)}%)`);

console.error('\nHypothesis check:');
console.error(`  v0.5.237 baseline: 0/10 detected (Books 10/10 NULL)`);
console.error(`  v0.5.238 measured: ${detectedCount}/${N} detected`);
if (detectedCount >= 7) {
  console.error(`  → multi-hint WORKS: detector now finds cursor regardless of rate-limit`);
} else if (detectedCount >= 3) {
  console.error(`  → multi-hint PARTIAL: some lift, needs investigation`);
} else {
  console.error(`  → multi-hint INEFFECTIVE: detection still failing — root cause elsewhere`);
}

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, trials, detectedCount, successCount }, null, 2));
console.error(`\nResults: ${ROOT}/results.json`);
process.exit(0);
