/**
 * Click-timing bench: hold the cursor position constant, vary only
 * `clickDurationMs` (button-down hold duration). Same target (Settings),
 * same v8-calibrate=on, same retries.
 *
 * Premise from earlier analysis: v8 gets the cursor reliably onto the
 * Settings icon (within 6-18 px in arm-on Settings trials 1/13/37), but
 * the default 150 ms click never produced a screen change. If extending
 * (or shortening) the button-down window makes iPadOS register the tap,
 * we found a real lever. If no duration produces hits, the issue is
 * downstream of timing.
 *
 * Output: data/click-timing-<timestamp>/
 *   manifest.json
 *   trials/T-NNN-pre.jpg / T-NNN-post.jpg
 *
 * Usage:
 *   npx tsx bench-click-timing.ts [trials_per_duration]
 *
 * Defaults: 5 trials × 6 durations = 30 total (~15-20 min).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from '../src/pikvm/click-verify.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { unlockIpad, ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const TARGET = { name: 'Settings', x: 1027, y: 825 };
const DURATIONS_MS = [30, 80, 150, 300, 600, 1000];

interface TrialResult {
  trial_idx: number;
  click_duration_ms: number;
  attempts: number;
  cursorVerified: boolean;
  residual_px: number | null;
  withinIcon: boolean;
  screenChanged: boolean;
  changed_fraction: number | null;
  pre_frame: string;
  post_frame: string;
  error?: string;
  elapsed_ms: number;
}

const TRIALS_PER_DURATION = process.argv[2] ? Number(process.argv[2]) : 5;
if (!Number.isInteger(TRIALS_PER_DURATION) || TRIALS_PER_DURATION < 1) {
  console.error('usage: npx tsx bench-click-timing.ts [trials_per_duration] (default 5)');
  process.exit(2);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/click-timing-${ts}`);
const TRIALS_DIR = path.join(OUT, 'trials');

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json');
process.env.PIKVM_V8_CALIBRATE = '1';  // v8 reliably puts cursor on Settings; keep that constant.

async function runTrial(idx: number, durationMs: number): Promise<TrialResult> {
  const preFile = `T-${String(idx).padStart(3, '0')}-pre.jpg`;
  const postFile = `T-${String(idx).padStart(3, '0')}-post.jpg`;

  try { await unlockIpad(client, {}); } catch { /* tolerated */ }

  const preBuf = await takeRawScreenshot(client);
  await fs.writeFile(path.join(TRIALS_DIR, preFile), preBuf);

  const t0 = Date.now();
  let result: TrialResult = {
    trial_idx: idx,
    click_duration_ms: durationMs,
    attempts: 0,
    cursorVerified: false,
    residual_px: null,
    withinIcon: false,
    screenChanged: false,
    changed_fraction: null,
    pre_frame: preFile,
    post_frame: postFile,
    elapsed_ms: 0,
  };

  try {
    const r = await clickAtWithRetry(client, { x: TARGET.x, y: TARGET.y }, {
      maxRetries: defaultMaxRetriesFor(/*absolute=*/ false),
      clickDurationMs: durationMs,
      moveToOptions: { profile, forbidSlamFallback: true },
    });
    const cursor = r.finalMoveResult.finalDetectedPosition;
    const cursorVerified = cursor !== null;
    const residual = cursorVerified
      ? Math.hypot(cursor!.x - TARGET.x, cursor!.y - TARGET.y)
      : null;
    result = {
      ...result,
      attempts: r.attempts,
      cursorVerified,
      residual_px: residual,
      withinIcon: cursorVerified && residual! <= 25,
      screenChanged: r.success,
      changed_fraction: r.finalVerification?.changedFraction ?? null,
    };
  } catch (e) {
    result.error = `${e}`;
  }
  result.elapsed_ms = Date.now() - t0;

  await new Promise((r) => setTimeout(r, 400));
  const postBuf = await takeRawScreenshot(client);
  await fs.writeFile(path.join(TRIALS_DIR, postFile), postBuf);

  await ipadGoHome(client, { settleMs: 600 });
  await new Promise((r) => setTimeout(r, 400));
  return result;
}

async function main() {
  await fs.mkdir(TRIALS_DIR, { recursive: true });
  console.log(`Output: ${OUT}`);
  console.log(`Target: ${TARGET.name} @ (${TARGET.x}, ${TARGET.y})`);
  console.log(`Durations: ${DURATIONS_MS.join(', ')} ms`);
  console.log(`Trials per duration: ${TRIALS_PER_DURATION}`);
  console.log(`Total trials: ${DURATIONS_MS.length * TRIALS_PER_DURATION}\n`);

  console.log('Setup: unlock + home...');
  await unlockIpad(client, {});
  await ipadGoHome(client, { settleMs: 800 });
  await new Promise((r) => setTimeout(r, 400));

  // Interleave by trial-within-duration so time drift hits all durations equally.
  const sequence: Array<{ duration: number }> = [];
  for (let t = 0; t < TRIALS_PER_DURATION; t++) {
    for (const duration of DURATIONS_MS) {
      sequence.push({ duration });
    }
  }

  const results: TrialResult[] = [];
  for (let i = 0; i < sequence.length; i++) {
    const { duration } = sequence[i];
    console.log(`[${i + 1}/${sequence.length}] duration=${duration}ms...`);
    try {
      const r = await runTrial(i, duration);
      results.push(r);
      const resStr = r.residual_px != null ? `residual=${r.residual_px.toFixed(0)}px` : 'cursor-unverified';
      console.log(`  → ${resStr} withinIcon=${r.withinIcon} screenChanged=${r.screenChanged} (${r.elapsed_ms}ms)`);
    } catch (e) {
      console.error(`  → trial ${i} FAILED: ${e}`);
    }

    await fs.writeFile(
      path.join(OUT, 'manifest.json'),
      JSON.stringify({
        created_at: ts,
        target: TARGET,
        durations_ms: DURATIONS_MS,
        trials_per_duration: TRIALS_PER_DURATION,
        results,
      }, null, 2),
    );
  }

  console.log('\n=== Summary (per click duration) ===');
  for (const d of DURATIONS_MS) {
    const rs = results.filter((r) => r.click_duration_ms === d && !r.error);
    const n = rs.length;
    if (n === 0) continue;
    const verified = rs.filter((r) => r.cursorVerified).length;
    const within = rs.filter((r) => r.withinIcon).length;
    const changed = rs.filter((r) => r.screenChanged).length;
    console.log(
      `  ${d}ms: n=${n}  cursor-verified=${verified}/${n}  within-25px=${within}/${n}  screen-changed=${changed}/${n} (${(100 * changed / n).toFixed(0)}%)`,
    );
  }
  console.log(`\nManifest: ${OUT}/manifest.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
