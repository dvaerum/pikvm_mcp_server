/**
 * Phase 191 (v0.5.180) live A/B bench: inter-retry approach randomization.
 *
 * Imports the source tree directly (NOT via the deployed MCP server), so
 * this measures the LATEST code regardless of the deployed binary's age.
 *
 * Runs the same click target twice — once with jitter off, once with the
 * default rosette — and reports per-attempt + cumulative success rate
 * for direct comparison.
 *
 * Usage:
 *   npx tsx bench-jitter-ab.ts [x] [y] [trials_per_mode]
 *   npx tsx bench-jitter-ab.ts 905 800 5     # Settings icon, 5 trials each
 *   npx tsx bench-jitter-ab.ts                # defaults: 905, 800, 5
 *
 * Acceptance bar (per the Phase 191 plan):
 *   - cumulative success rate (jitter on) ≥ baseline + 5 percentage points
 *   - residual-skip rate not statistically higher
 *   - no slam fallback / hot-corner re-lock events
 */

import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const argv = process.argv.slice(2);
const TARGET = {
  x: argv[0] !== undefined ? Number(argv[0]) : 905,
  y: argv[1] !== undefined ? Number(argv[1]) : 800,
};
const TRIALS = argv[2] !== undefined ? Number(argv[2]) : 5;
const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false); // iPad → 3
console.error(`Target (${TARGET.x}, ${TARGET.y}) — ${TRIALS} trials per mode — maxRetries=${MAX_RETRIES}`);

interface Trial {
  success: boolean;
  attempts: number;
  attemptsToSuccess: number | null;     // 1-based attempt # that succeeded, null if all failed
  residual: number | null;
  cursorVerified: boolean;
}

async function unlockAndSettle(): Promise<void> {
  // Use the lock-screen unlock-style swipe to put the iPad on a known
  // home-screen state regardless of prior state. Sleep gives iPadOS time
  // to settle the home-screen animation before the next bench trial.
  // 800 px upward at startX/startY tuned for 1680×1050 iPad portrait.
  await client.mouseClick('left', { state: true });   // press at current pos
  await client.mouseMoveRelative(0, 0);
  await client.mouseClick('left', { state: false });  // release
  // Defer to the proper swipe via direct press/move/release pattern:
  // 27 chunks of 30 mickeys upward = ~800 px.
  // Move cursor to bottom-center first via absolute-ish slam? No — use
  // pikvm-mcp's built-in ipad-unlock helper directly.
  const { ipadGoHome } = await import('./src/pikvm/ipad-unlock.js');
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
}

async function runTrial(jitter: number): Promise<Trial> {
  await unlockAndSettle();

  const r = await clickAtWithRetry(client, TARGET, {
    maxRetries: MAX_RETRIES,
    interRetryJitterMickeys: jitter,
    moveToOptions: {
      profile: profile ?? undefined,
      forbidSlamFallback: true,        // iPad-safe — never slam the corner
      strategy: 'detect-then-move',
    },
    minBrightness: 0,                  // skip the dim-screen gate (synthetic-test edge case)
    requireVerifiedCursor: false,      // we want the click outcome, not the gate
  });

  // First attempt where screenChanged was true — null if all missed.
  const firstHit = r.attemptHistory.findIndex(a => a.screenChanged);
  const attemptsToSuccess = firstHit >= 0 ? firstHit + 1 : null;
  const cursor = r.finalMoveResult.finalDetectedPosition;
  const residual = cursor
    ? Math.sqrt((cursor.x - TARGET.x) ** 2 + (cursor.y - TARGET.y) ** 2)
    : null;

  return {
    success: r.success,
    attempts: r.attempts,
    attemptsToSuccess,
    residual,
    cursorVerified: cursor !== null,
  };
}

async function bench(label: string, jitter: number): Promise<Trial[]> {
  console.error(`\n=== ${label}: interRetryJitterMickeys=${jitter} ===`);
  const trials: Trial[] = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const t = await runTrial(jitter);
      trials.push(t);
      console.error(
        `  trial ${i + 1}: success=${t.success} attempts=${t.attempts} ` +
        `attemptsToSuccess=${t.attemptsToSuccess ?? 'N/A'} ` +
        `residual=${t.residual?.toFixed(1) ?? 'UNVERIFIED'}px`,
      );
    } catch (e) {
      console.error(`  trial ${i + 1}: ERROR ${(e as Error).message}`);
    }
  }
  return trials;
}

function summary(label: string, trials: Trial[]): void {
  const N = trials.length;
  const successCount = trials.filter(t => t.success).length;
  const cumulativeRate = N > 0 ? (successCount / N) * 100 : 0;

  // Per-attempt success: of the trials that succeeded ON attempt N, count.
  const perAttempt: Record<number, number> = {};
  for (let i = 1; i <= MAX_RETRIES + 1; i++) perAttempt[i] = 0;
  for (const t of trials) {
    if (t.attemptsToSuccess !== null) {
      perAttempt[t.attemptsToSuccess] = (perAttempt[t.attemptsToSuccess] ?? 0) + 1;
    }
  }
  const histogram = Object.entries(perAttempt)
    .map(([n, c]) => `attempt-${n}=${c}`)
    .join(', ');
  console.error(
    `  ${label}: cumulative ${successCount}/${N} (${cumulativeRate.toFixed(0)}%) — first-hit-on: ${histogram}`,
  );
}

const off = await bench('JITTER OFF (baseline)', 0);
const on  = await bench('JITTER ON (rosette)', 50);

console.error(`\n=== A/B SUMMARY (target ${TARGET.x},${TARGET.y}, ${TRIALS} trials/mode) ===`);
summary('JITTER OFF', off);
summary('JITTER ON ', on);

const offRate = off.filter(t => t.success).length / Math.max(1, off.length);
const onRate  = on.filter(t => t.success).length  / Math.max(1, on.length);
const liftPp = (onRate - offRate) * 100;
console.error(`\nLift: ${liftPp >= 0 ? '+' : ''}${liftPp.toFixed(0)} pp (jitter on vs off)`);
console.error(`Acceptance bar: ≥+5 pp. ${liftPp >= 5 ? '✓ PASS' : liftPp >= 0 ? '~ NEUTRAL' : '✗ FAIL'}`);

process.exit(0);
