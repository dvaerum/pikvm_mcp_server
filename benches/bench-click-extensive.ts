/**
 * Phase 192-eval (v0.5.185) — extensive click-reliability bench
 * with post-click screenshot capture.
 *
 * Imports `src/` directly via tsx — measures the LATEST code regardless
 * of the deployed MCP binary's age.
 *
 * For each trial:
 *   - reset to home via Cmd+H
 *   - run clickAtWithRetry against the target (default jitter off, all
 *     Phase 192 belief work active)
 *   - save the post-click screenshot AND the algorithm-reported
 *     verification state
 *   - aggregate per-target outcomes
 *
 * Outputs:
 *   - per-trial JSONL: ./data/click-bench/results.jsonl
 *   - per-trial PNGs:  ./data/click-bench/<target>/NN-{hit|miss}.jpg
 *   - per-target summary table on stderr
 *
 * Usage:
 *   npx tsx bench-click-extensive.ts                      # 10 trials per target
 *   npx tsx bench-click-extensive.ts 12                    # 12 trials per target
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from '../src/pikvm/click-verify.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false); // iPad → 3

const argv = process.argv.slice(2);
const TRIALS = argv[0] !== undefined ? Number(argv[0]) : 10;

const ROOT = './data/click-bench';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'results.jsonl');

// Phase 196b: do NOT auto-wipe data/cursor-templates here. Live test on
// 2026-05-10 showed wiping made things WORSE (overall 58% → 25%) because
// trial 1 of the first target then runs with NO templates, falling back
// to motion-diff which has higher variance. The 6h TTL in loadTemplateSet
// handles cross-session contamination automatically; for fair
// before/after benches in a single session, manually wipe between runs.

interface Target {
  name: string;
  slug: string;          // filesystem-safe
  x: number;
  y: number;
  expectedScreen: string; // human-readable description of what should appear post-click
}

// Targets across the iPad home screen at 1680×1050. Sampled to cover
// different positions: corner-ish, mid-row, dock, large vs small.
const TARGETS: Target[] = [
  { name: 'Settings (small icon, badge)',     slug: 'settings',     x: 905,  y: 800, expectedScreen: 'Settings sidebar (Apple Account / General / Wi-Fi list)' },
  { name: 'Books (small icon)',                slug: 'books',        x: 640,  y: 800, expectedScreen: 'Books library / Reading Now' },
  { name: 'App Store (small icon)',            slug: 'appstore',     x: 905,  y: 680, expectedScreen: 'App Store Today / Games / Apps tabs' },
  { name: 'Files (small icon, top-right)',    slug: 'files',        x: 1035, y: 420, expectedScreen: 'Files Recents / Browse view' },
];

async function snap(filepath: string): Promise<void> {
  await new Promise(r => setTimeout(r, 200));
  const shot = await client.screenshot({ quality: 75 });
  await fs.writeFile(filepath, shot.buffer);
}

interface Trial {
  trial: number;
  success: boolean;
  attempts: number;
  attemptsToSuccess: number | null;
  residual: number | null;
  cursorVerified: boolean;
  failureReason: string | null;
  postClickPath: string;
}

async function unlockAndSettle(): Promise<void> {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
}

async function runTrial(t: Target, n: number, dir: string): Promise<Trial> {
  await unlockAndSettle();
  const r = await clickAtWithRetry(client, { x: t.x, y: t.y }, {
    maxRetries: MAX_RETRIES,
    moveToOptions: {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    },
    minBrightness: 0,
    requireVerifiedCursor: false,
    // Phase 192-eval: tighten verify so screenChanged is meaningful.
    // Without this, full-frame diff trips on the wallpaper animation,
    // clock advance, and widget ticks — false-positive "hits" on
    // 6 of 7 sampled frames in the prior bench.
    //
    // 50 px half-width = 100×100 px window centred on the target.
    // iPad icons are ~70 px wide; this window covers the icon and
    // a small margin without leaking into adjacent icons.
    //
    // 0.05 = at least 5% of the windowed pixels must change. A
    // genuine icon tap → app launch produces near-100% change in
    // the window (entire app appears). A clock tick produces ~0%
    // in this small region.
    verifyOptions: {
      region: { x: t.x, y: t.y, halfWidth: 50, halfHeight: 50 },
      minChangedFraction: 0.05,
    },
  });

  const firstHit = r.attemptHistory.findIndex(a => a.screenChanged);
  const attemptsToSuccess = firstHit >= 0 ? firstHit + 1 : null;
  const cursor = r.finalMoveResult.finalDetectedPosition;
  const residual = cursor
    ? Math.sqrt((cursor.x - t.x) ** 2 + (cursor.y - t.y) ** 2)
    : null;
  const failureReason = !r.success
    ? (r.failureSummary ?? r.finalVerification.message ?? 'unknown')
    : null;

  // Capture the algorithm's post-click screenshot (already in result)
  // — but ALSO take a fresh screenshot 600 ms later so we see what's
  // actually on screen after iPadOS finishes any animation.
  await new Promise(r => setTimeout(r, 600));
  const verdict = r.success ? 'hit' : 'miss';
  const file = path.join(dir, `${n.toString().padStart(2, '0')}-${verdict}.jpg`);
  await snap(file);

  return {
    trial: n,
    success: r.success,
    attempts: r.attempts,
    attemptsToSuccess,
    residual,
    cursorVerified: cursor !== null,
    failureReason,
    postClickPath: file,
  };
}

async function benchTarget(t: Target): Promise<Trial[]> {
  const dir = path.join(ROOT, t.slug);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== ${t.name} (${t.x},${t.y}) — ${TRIALS} trials ===`);
  console.error(`    Expected post-click screen: ${t.expectedScreen}`);
  const trials: Trial[] = [];
  for (let n = 1; n <= TRIALS; n++) {
    try {
      const trial = await runTrial(t, n, dir);
      trials.push(trial);
      const resStr = trial.residual?.toFixed(0) ?? 'unv';
      const status = trial.success ? '✓ HIT' : '✗ MISS';
      console.error(
        `  ${n}/${TRIALS} ${status} attempts=${trial.attempts} hitOn=${trial.attemptsToSuccess ?? '-'} ` +
        `residual=${resStr}px → ${trial.postClickPath}`,
      );
      await fs.appendFile(LOG, JSON.stringify({ target: t.slug, ...trial }) + '\n');
    } catch (e) {
      const errMsg = (e as Error).message;
      console.error(`  ${n}/${TRIALS} ✗ ERROR: ${errMsg}`);
      trials.push({
        trial: n,
        success: false,
        attempts: 0,
        attemptsToSuccess: null,
        residual: null,
        cursorVerified: false,
        failureReason: `THROW: ${errMsg}`,
        postClickPath: '',
      });
    }
  }
  return trials;
}

console.error(`Bench start. maxRetries=${MAX_RETRIES} (iPad default). ${TRIALS} trials × ${TARGETS.length} targets = ${TRIALS * TARGETS.length} clicks.`);
console.error(`Frames + JSONL → ${ROOT}`);

const allResults: Record<string, Trial[]> = {};
for (const t of TARGETS) {
  allResults[t.slug] = await benchTarget(t);
}

console.error(`\n\n========== SUMMARY ==========\n`);
console.error(`${'Target'.padEnd(36)} | hit rate | first-hit attempts | median residual`);
console.error(`${'-'.repeat(36)}-+----------+--------------------+------------------`);
let totalSuccess = 0;
let totalTrials = 0;
for (const t of TARGETS) {
  const trials = allResults[t.slug];
  const hits = trials.filter(x => x.success).length;
  const N = trials.length;
  const histogram: Record<number, number> = {};
  for (let i = 1; i <= MAX_RETRIES + 1; i++) histogram[i] = 0;
  for (const x of trials) {
    if (x.attemptsToSuccess !== null) histogram[x.attemptsToSuccess]++;
  }
  const hitOnStr = Object.entries(histogram).filter(([, c]) => c > 0).map(([n, c]) => `${n}:${c}`).join(' ') || '-';
  const residuals = trials.filter(x => x.residual !== null).map(x => x.residual!);
  const median = residuals.length > 0
    ? [...residuals].sort((a, b) => a - b)[Math.floor(residuals.length / 2)].toFixed(0)
    : 'n/a';
  console.error(
    `${t.name.padEnd(36)} |   ${(hits / N * 100).toFixed(0).padStart(3)}%  | ${hitOnStr.padEnd(18)} |       ${median.padStart(5)}px`,
  );
  totalSuccess += hits;
  totalTrials += N;
}
console.error(`\nOverall: ${totalSuccess}/${totalTrials} (${(totalSuccess / totalTrials * 100).toFixed(0)}%)`);
console.error(`\nNext: visually inspect a sample of post-click screenshots to verify "success" means correct-element-hit.`);
console.error(`  Hits: ls ${ROOT}/<target>/*-hit.jpg`);
console.error(`  Misses: ls ${ROOT}/<target>/*-miss.jpg`);
process.exit(0);
