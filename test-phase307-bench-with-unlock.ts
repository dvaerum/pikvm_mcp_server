/**
 * Phase 307 live click-rate bench at v0.5.233.
 *
 * Differences from bench-click-extensive.ts:
 *   - Calls unlockIpad() at start AND between trials whenever the
 *     iPad re-locked (detected by ipadGoHome failing or by
 *     screen-brightness check)
 *   - N=10 per target × 4 targets × 2 reps = 80 trials total
 *   - Phase 237 variance rule: repeat block measurements
 *
 * Measures whether Phase 307's co-linearity penalty improves
 * production click rate vs the documented v0.5.232 baseline
 * (Settings 30-50%, Books/TV 0-15%).
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

const ROOT = `./data/phase307-bench/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 307 click-rate bench at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

interface Target {
  name: string;
  x: number;
  y: number;
}

const TARGETS: Target[] = [
  { name: 'Settings', x: 905, y: 800 },
  { name: 'Books',    x: 640, y: 800 },
  { name: 'TV',       x: 773, y: 800 },
  { name: 'AppStore', x: 905, y: 680 },
];

const N_PER_TARGET = 5;
const N_REPS = 2;

interface Trial {
  rep: number;
  target: string;
  trial: number;
  success: boolean;
  attempts: number;
  finalResidualPx: number | null;
  message: string;
  durationMs: number;
}

const trials: Trial[] = [];

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

for (let rep = 1; rep <= N_REPS; rep++) {
  for (const target of TARGETS) {
    console.error(`\n--- Rep ${rep}, ${target.name} (${target.x},${target.y}) ---`);
    for (let i = 1; i <= N_PER_TARGET; i++) {
      // Try go-home; if it fails (iPad locked), re-unlock.
      try {
        await ipadGoHome(client, { forceHomeViaSwipe: true });
      } catch {
        console.error('  ipadGoHome failed → re-unlocking');
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
          { x: target.x, y: target.y },
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
        console.error(`  [r${rep}.${target.name}.${i}] THREW: ${(e as Error).message.slice(0, 100)}`);
        trials.push({
          rep, target: target.name, trial: i,
          success: false, attempts: 0, finalResidualPx: null,
          message: `THREW: ${(e as Error).message.slice(0, 100)}`,
          durationMs: Date.now() - start,
        });
        // Try unlock again before next trial
        await unlockIpad(client, { dragPx: 1500 }).catch(() => undefined);
        await sleep(800);
        continue;
      }
      const dur = Date.now() - start;
      const success = result.success && (result.finalVerification?.screenChanged ?? false);
      trials.push({
        rep, target: target.name, trial: i,
        success,
        attempts: result.attempts,
        finalResidualPx: result.finalMoveResult.finalResidualPx,
        message: (result.finalVerification?.message ?? '').slice(0, 100),
        durationMs: dur,
      });
      console.error(
        `  [r${rep}.${target.name}.${i}] ${success ? '✓' : '✗'} attempts=${result.attempts} ` +
        `residual=${result.finalMoveResult.finalResidualPx !== null ? result.finalMoveResult.finalResidualPx.toFixed(0) + 'px' : 'n/a'} ${dur}ms`,
      );
    }
  }
}

console.error('\n=== Aggregate ===');
for (const target of TARGETS) {
  for (let rep = 1; rep <= N_REPS; rep++) {
    const subset = trials.filter(t => t.target === target.name && t.rep === rep);
    const successes = subset.filter(t => t.success).length;
    console.error(`  ${target.name} rep${rep}: ${successes}/${subset.length} (${Math.round(successes/subset.length*100)}%)`);
  }
  const all = trials.filter(t => t.target === target.name);
  const successes = all.filter(t => t.success).length;
  console.error(`  ${target.name} OVERALL: ${successes}/${all.length} (${Math.round(successes/all.length*100)}%)`);
}

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, trials }, null, 2));
console.error(`\nResults written to ${ROOT}/results.json`);
process.exit(0);
