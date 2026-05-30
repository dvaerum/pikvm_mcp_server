/**
 * v0.5.241 Settings bench with visual ground truth.
 *
 * Phase 317 added ML wiggle-verify gated on proximity ≤ 30 px.
 * Hypothesis: Phase 310 tautologies (residual=19 px on Settings)
 * that v0.5.240 reported as detection successes will be REJECTED
 * by wiggle-verify, surfacing as either:
 *  - Lower confidence ML alternates
 *  - Fall-through to shape-detect (then null)
 *  - NULL detection (honest)
 *
 * N=10 trials. Save pre-click frame for every trial so visual GT
 * can confirm the residual story.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { clickAtWithRetry } from '../src/pikvm/click-verify.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/v241-settings/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== v0.5.241 Settings verify at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

const TARGET = { name: 'Settings', x: 905, y: 800 };
const N = 10;

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

  // Pre-click screenshot for visual GT
  const pre = await client.screenshot();
  await fs.writeFile(path.join(ROOT, `t${i}-pre.jpg`), pre.buffer);

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
    await unlockIpad(client, { dragPx: 1500 }).catch(() => undefined);
    await sleep(800);
    continue;
  }

  const dur = Date.now() - start;
  const success = result.success && (result.finalVerification?.screenChanged ?? false);
  const detectedPos = result.finalMoveResult.finalDetectedPosition ?? null;

  // Post-click screenshot
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
}

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, trials }, null, 2));

console.error('\n=== Aggregate ===');
const detected = trials.filter(t => t.detectedPos !== null).length;
const tautologySuspects = trials.filter(t => t.residualPx !== null && t.residualPx <= 30).length;
const successes = trials.filter(t => t.success).length;
console.error(`Detected:        ${detected}/${N}`);
console.error(`Residual ≤ 30px: ${tautologySuspects}/${N}  (tautology suspects)`);
console.error(`Click success:   ${successes}/${N}`);
console.error(`\nResults: ${ROOT}/results.json`);
console.error(`Visual GT: inspect t*-pre.jpg to verify cursor location.`);
process.exit(0);
