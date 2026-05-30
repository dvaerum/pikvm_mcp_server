/**
 * Phase 305 (v0.5.232) live bench — slam-unstick recovery +
 * null-detection training capture.
 *
 * User asked:
 *   "Implement slam-unstick recovery ... when null is return we should
 *   take a screenshot and use it for later analytic to verify where the
 *   cursor is because that is each cases which are good for testing and
 *   training of the mouse pointer llm we are talking about training."
 *
 * Hypothesis: when moveToPixel returns null finalDetectedPosition the
 * cursor is often pinned in a snap-zone we cannot escape via small
 * correction emits. Slamming to top-left + resetting belief gives the
 * next retry attempt a clean origin.
 *
 * Bench: N=20 click attempts at Books (642, 810), then N=20 at
 * TV (773, 810). Repeated twice per Phase 237 variance rule.
 *
 * For each call:
 *   - captureNullDetectionFrames: true (saves screenshots + sidecar
 *     for every null-detection skip — training data for future ML)
 *   - enableSlamUnstickOnNull: true (recovery primitive under test)
 *   - requireVerifiedCursor: true
 *   - maxRetries: 3
 *
 * Results: print per-trial success/skip/retry counts and aggregate
 * click rate. Compare against Phase 278 baseline (50% Settings,
 * 0-15% TV/Books).
 */
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { clickAtWithRetry } from '../src/pikvm/click-verify.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TARGETS = [
  { name: 'Books', x: 642, y: 810 },
  { name: 'TV', x: 773, y: 810 },
];
const N_PER_TARGET = 10;
const N_REPETITIONS = 2;

interface Trial {
  target: string;
  attempt: number;
  rep: number;
  success: boolean;
  screenChanged: boolean;
  attempts: number;
  slamFires: number;
  nullSkips: number;
  finalMessage: string;
  durationMs: number;
}

async function runTrial(target: { name: string; x: number; y: number }, rep: number, idx: number): Promise<Trial> {
  // Reset to home before each trial.
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1500);

  const start = Date.now();
  let nullSkips = 0;
  let slamFires = 0;

  try {
    const result = await clickAtWithRetry(
      client,
      { x: target.x, y: target.y },
      {
        maxRetries: 3,
        requireVerifiedCursor: true,
        captureNullDetectionFrames: true,
        enableSlamUnstickOnNull: true,
      },
    );

    for (const a of result.attemptHistory ?? []) {
      if (a.skippedClickReason === 'cursor not verified') {
        nullSkips++;
        slamFires++;
      }
    }

    return {
      target: target.name,
      attempt: idx,
      rep,
      success: result.success,
      screenChanged: result.finalVerification?.screenChanged ?? false,
      attempts: result.attempts,
      slamFires,
      nullSkips,
      finalMessage: result.finalVerification?.message ?? '',
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      target: target.name,
      attempt: idx,
      rep,
      success: false,
      screenChanged: false,
      attempts: 0,
      slamFires,
      nullSkips,
      finalMessage: `THREW: ${(e as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

async function main() {
  console.error(`=== Phase 305 slam-unstick bench at v${VERSION} ===`);
  console.error(`Targets: ${TARGETS.map(t => t.name).join(', ')}`);
  console.error(`N per target per rep: ${N_PER_TARGET}, repetitions: ${N_REPETITIONS}\n`);

  await unlockIpad(client, { dragPx: 1500 });
  await sleep(800);

  const trials: Trial[] = [];

  for (let rep = 1; rep <= N_REPETITIONS; rep++) {
    for (const target of TARGETS) {
      console.error(`\n--- Rep ${rep}, target ${target.name} (${target.x}, ${target.y}) ---`);
      for (let i = 1; i <= N_PER_TARGET; i++) {
        const t = await runTrial(target, rep, i);
        trials.push(t);
        console.error(
          `  [${rep}.${target.name}.${i}] success=${t.success} ` +
          `screenChanged=${t.screenChanged} attempts=${t.attempts} ` +
          `nullSkips=${t.nullSkips} slamFires=${t.slamFires} ` +
          `${t.durationMs}ms`,
        );
      }
    }
  }

  // Aggregate.
  console.error(`\n=== Aggregate at v${VERSION} ===`);
  for (const target of TARGETS) {
    for (let rep = 1; rep <= N_REPETITIONS; rep++) {
      const subset = trials.filter(t => t.target === target.name && t.rep === rep);
      const successCount = subset.filter(t => t.success).length;
      const avgAttempts = subset.reduce((s, t) => s + t.attempts, 0) / subset.length;
      const totalSlam = subset.reduce((s, t) => s + t.slamFires, 0);
      console.error(
        `  ${target.name} rep${rep}: ${successCount}/${subset.length} (${Math.round((successCount / subset.length) * 100)}%) ` +
        `avgAttempts=${avgAttempts.toFixed(2)} totalSlamFires=${totalSlam}`,
      );
    }
    const overall = trials.filter(t => t.target === target.name);
    const overallSuccess = overall.filter(t => t.success).length;
    console.error(
      `  ${target.name} OVERALL: ${overallSuccess}/${overall.length} (${Math.round((overallSuccess / overall.length) * 100)}%)`,
    );
  }

  // Dump JSON for later analysis.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const out = `./data/phase305-bench/${ts}.json`;
  const { promises: fs } = await import('fs');
  await fs.mkdir('./data/phase305-bench', { recursive: true });
  await fs.writeFile(out, JSON.stringify({ version: VERSION, timestamp: ts, trials }, null, 2));
  console.error(`\nWrote ${out}`);
  console.error(`Inspect data/null-detection-snapshots/ for captured training frames.`);
  process.exit(0);
}

main().catch(e => {
  console.error(`bench failed: ${(e as Error).message}`);
  process.exit(1);
});
