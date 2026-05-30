/**
 * A/B bench: clickAtWithRetry with PIKVM_V8_CALIBRATE=on vs off.
 *
 * For each (target, arm, trial), runs clickAtWithRetry and records:
 *   - pre-click screenshot
 *   - post-click screenshot
 *   - residual + cursorVerified from finalMoveResult
 *   - which calibration arm was active
 *
 * Arms are interleaved (A, B, A, B, ...) so iPad state drift across the
 * wallclock affects both arms equally. After the run, post-click frames
 * are saved for human-eye classification — per memory: residual is not
 * ground truth, only post-click visual inspection is.
 *
 * Output dir: data/v8-calibrate-ab-<timestamp>/
 *   manifest.json      — per-trial structured results
 *   trials/T-NNN-pre.jpg
 *   trials/T-NNN-post.jpg
 *
 * The default click action navigates to an app, so each trial uses
 * `cmd+h` to return to home before the next. Tests on home-screen
 * icon targets (Settings, Books, Files, Maps, Calendar, FaceTime).
 *
 * Usage:
 *   npx tsx bench-v8-calibrate-ab.ts [trials_per_target]
 *
 * Defaults: 5 trials per target × 6 targets × 2 arms = 60 trials.
 * Wallclock: ~25-40 min on this iPad.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from '../src/pikvm/click-verify.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { unlockIpad, ipadGoHome } from '../src/pikvm/ipad-unlock.js';

// Home-screen icon targets on this iPad's home page layout.
// Coordinates approximate; clickAtWithRetry will home in via residual.
// If any of these don't match the current layout, the post-click frame
// will show "wrong app launched" which we'll catch via visual inspection.
const TARGETS = [
  { name: 'Settings', x: 1027, y: 825 },
  { name: 'Books',    x: 757,  y: 832 },
  { name: 'Files',    x: 1056, y: 480 },
  { name: 'Maps',     x: 1056, y: 605 },
  { name: 'Calendar', x: 793,  y: 280 },
  { name: 'FaceTime', x: 921,  y: 480 },
];

const ARMS = ['off', 'on'] as const;
type Arm = (typeof ARMS)[number];

interface TrialResult {
  trial_idx: number;
  target_name: string;
  target: { x: number; y: number };
  arm: Arm;
  attempts: number;
  cursorVerified: boolean;
  residual_px: number | null;
  withinIcon: boolean;
  screenChanged: boolean;
  changed_fraction?: number | null;
  pre_frame: string;
  post_frame: string;
  error?: string;
  elapsed_ms: number;
}

const TRIALS_PER_TARGET = process.argv[2] ? Number(process.argv[2]) : 5;
if (!Number.isInteger(TRIALS_PER_TARGET) || TRIALS_PER_TARGET < 1) {
  console.error(`usage: npx tsx bench-v8-calibrate-ab.ts [trials_per_target] (default 5)`);
  process.exit(2);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/v8-calibrate-ab-${ts}`);
const TRIALS_DIR = path.join(OUT, 'trials');

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');

function setArm(arm: Arm): void {
  if (arm === 'on') process.env.PIKVM_V8_CALIBRATE = '1';
  else delete process.env.PIKVM_V8_CALIBRATE;
}

async function runTrial(idx: number, target: typeof TARGETS[number], arm: Arm): Promise<TrialResult> {
  setArm(arm);
  const preFile = `T-${String(idx).padStart(3, '0')}-pre.jpg`;
  const postFile = `T-${String(idx).padStart(3, '0')}-post.jpg`;

  // Idempotent unlock per trial. Previous bench had ~half of the trials
  // confounded by mid-bench auto-lock (frames showed iPad sleeping). Phase
  // 219 made `unlockIpad` safe to call repeatedly from home — costs ~1s
  // when already unlocked, prevents the lock-screen confound entirely.
  try {
    await unlockIpad(client, {});
  } catch (e) {
    // Tolerate unlock failure — the click attempt below will surface it.
  }

  // Capture pre-click frame.
  const preBuf = await takeRawScreenshot(client);
  await fs.writeFile(path.join(TRIALS_DIR, preFile), preBuf);

  const t0 = Date.now();
  let result: TrialResult = {
    trial_idx: idx,
    target_name: target.name,
    target: { x: target.x, y: target.y },
    arm,
    attempts: 0,
    cursorVerified: false,
    residual_px: null,
    withinIcon: false,
    screenChanged: false,
    pre_frame: preFile,
    post_frame: postFile,
    elapsed_ms: 0,
  };

  try {
    const r = await clickAtWithRetry(client, { x: target.x, y: target.y }, {
      maxRetries: defaultMaxRetriesFor(/*absolute=*/ false),
      moveToOptions: { profile, forbidSlamFallback: true },
    });
    const cursor = r.finalMoveResult.finalDetectedPosition;
    const cursorVerified = cursor !== null;
    const residual = cursorVerified
      ? Math.hypot(cursor!.x - target.x, cursor!.y - target.y)
      : null;
    result = {
      ...result,
      attempts: r.attempts,
      cursorVerified,
      residual_px: residual,
      withinIcon: cursorVerified && residual! <= 25,
      // Fix from prior bench: clickAtWithRetry returns `success` (any-attempt
      // OR of screenChanged) and `finalVerification.screenChanged` (final
      // attempt only). Earlier code read `r.screenChanged` which didn't
      // exist → undefined → counted as 0/30 false in summary.
      screenChanged: r.success,
      changed_fraction: r.finalVerification?.changedFraction ?? null,
    };
  } catch (e) {
    result.error = `${e}`;
  }
  result.elapsed_ms = Date.now() - t0;

  // Capture post-click frame BEFORE going home so we see what actually
  // happened (the icon's launched app, or unchanged home if click missed).
  await new Promise((r) => setTimeout(r, 400)); // let any animation settle
  const postBuf = await takeRawScreenshot(client);
  await fs.writeFile(path.join(TRIALS_DIR, postFile), postBuf);

  // Return to home for the next trial.
  await ipadGoHome(client, { settleMs: 600 });
  await new Promise((r) => setTimeout(r, 400));
  return result;
}

async function main() {
  await fs.mkdir(TRIALS_DIR, { recursive: true });
  console.log(`Output: ${OUT}`);
  console.log(`Targets: ${TARGETS.map((t) => t.name).join(', ')}`);
  console.log(`Trials per target per arm: ${TRIALS_PER_TARGET}`);
  console.log(`Total trials: ${TARGETS.length * 2 * TRIALS_PER_TARGET}\n`);

  // Setup: unlock + go home so we start from a known state.
  console.log('Setup: unlock + home...');
  await unlockIpad(client, {});
  await ipadGoHome(client, { settleMs: 800 });
  await new Promise((r) => setTimeout(r, 400));

  // Build interleaved trial sequence. For each (target, trial_in_target):
  // run arm A then arm B, so time-of-day drift hits both arms equally on
  // the same target.
  const sequence: Array<{ target: typeof TARGETS[number]; arm: Arm }> = [];
  for (let t = 0; t < TRIALS_PER_TARGET; t++) {
    for (const target of TARGETS) {
      for (const arm of ARMS) {
        sequence.push({ target, arm });
      }
    }
  }

  const results: TrialResult[] = [];
  for (let i = 0; i < sequence.length; i++) {
    const { target, arm } = sequence[i];
    console.log(`[${i + 1}/${sequence.length}] target=${target.name} arm=${arm}...`);
    try {
      const r = await runTrial(i, target, arm);
      results.push(r);
      const resStr = r.residual_px != null ? `residual=${r.residual_px.toFixed(0)}px` : 'cursor-unverified';
      console.log(`  → attempts=${r.attempts} ${resStr} withinIcon=${r.withinIcon} screenChanged=${r.screenChanged} (${r.elapsed_ms}ms)`);
    } catch (e) {
      console.error(`  → trial ${i} FAILED: ${e}`);
      results.push({
        trial_idx: i,
        target_name: target.name,
        target: { x: target.x, y: target.y },
        arm,
        attempts: 0,
        cursorVerified: false,
        residual_px: null,
        withinIcon: false,
        screenChanged: false,
        pre_frame: `T-${String(i).padStart(3, '0')}-pre.jpg`,
        post_frame: `T-${String(i).padStart(3, '0')}-post.jpg`,
        error: `${e}`,
        elapsed_ms: 0,
      });
      // Try to recover for next trial.
      try {
        await ipadGoHome(client, { settleMs: 600 });
      } catch { /* ignore */ }
    }

    // Persist after every trial so a crash doesn't lose progress.
    await fs.writeFile(
      path.join(OUT, 'manifest.json'),
      JSON.stringify({
        created_at: ts,
        targets: TARGETS,
        trials_per_target_per_arm: TRIALS_PER_TARGET,
        results,
      }, null, 2),
    );
  }

  // Summary (residual-based — NOT ground truth; only screenshots are).
  console.log('\n=== Summary (residual-based; not ground truth) ===');
  for (const arm of ARMS) {
    const armRes = results.filter((r) => r.arm === arm && !r.error);
    const n = armRes.length;
    const verified = armRes.filter((r) => r.cursorVerified).length;
    const withinIcon = armRes.filter((r) => r.withinIcon).length;
    const screenChanged = armRes.filter((r) => r.screenChanged).length;
    console.log(
      `arm=${arm}: n=${n}, cursor-verified=${verified}/${n} (${(100 * verified / n).toFixed(0)}%), ` +
      `within-25px=${withinIcon}/${n} (${(100 * withinIcon / n).toFixed(0)}%), ` +
      `screen-changed=${screenChanged}/${n} (${(100 * screenChanged / n).toFixed(0)}%)`,
    );
  }
  console.log(`\nManifest: ${OUT}/manifest.json`);
  console.log(`Per-trial pre/post frames in ${TRIALS_DIR}`);
  console.log('NEXT: visually inspect post-click frames — did the RIGHT app launch?');
  console.log('  A trial that says "withinIcon=true" but lands on the wrong icon is still a miss.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
