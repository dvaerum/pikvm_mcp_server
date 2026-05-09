/**
 * Phase 191 (v0.5.180) extensive click-reliability bench.
 *
 * Imports `src/` directly via tsx — measures the LATEST code regardless
 * of the deployed MCP binary.
 *
 * Two-part run:
 *
 *  Part A — Focused A/B at one target (Settings 905, 800):
 *    15 trials × jitter off, 15 trials × jitter on. Verifies whether the
 *    Phase 191 rosette helps when retried-clicking a single target. Our
 *    earlier 5-trial bench was too noisy (baseline = 100%, no headroom).
 *
 *  Part B — Cross-target sweep at 4 small iPad icons (jitter ON only):
 *    10 trials per target. Maps reliability across the icon grid so we
 *    know whether a single 100% target is lucky or representative.
 *
 * Total: 70 trials × ~8 s ≈ 10 minutes.
 *
 * Reset between every trial: pikvm_ipad_home (Cmd+H — no slam, no
 * cursor disruption beyond closing whatever app we landed in).
 */

import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false); // iPad → 3

interface Trial {
  success: boolean;
  attempts: number;
  attemptsToSuccess: number | null;
  residual: number | null;
  cursorVerified: boolean;
  failureReason: string | null;
}

interface CellResult {
  label: string;
  trials: Trial[];
}

async function unlockAndSettle(): Promise<void> {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
}

async function runTrial(target: { x: number; y: number }, jitter: number): Promise<Trial> {
  await unlockAndSettle();

  const r = await clickAtWithRetry(client, target, {
    maxRetries: MAX_RETRIES,
    interRetryJitterMickeys: jitter,
    moveToOptions: {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    },
    minBrightness: 0,
    requireVerifiedCursor: false,
  });

  const firstHit = r.attemptHistory.findIndex(a => a.screenChanged);
  const attemptsToSuccess = firstHit >= 0 ? firstHit + 1 : null;
  const cursor = r.finalMoveResult.finalDetectedPosition;
  const residual = cursor
    ? Math.sqrt((cursor.x - target.x) ** 2 + (cursor.y - target.y) ** 2)
    : null;
  const failureReason = !r.success
    ? (r.failureSummary ?? r.finalVerification.message ?? 'unknown')
    : null;

  return {
    success: r.success,
    attempts: r.attempts,
    attemptsToSuccess,
    residual,
    cursorVerified: cursor !== null,
    failureReason,
  };
}

async function runCell(label: string, target: { x: number; y: number }, jitter: number, n: number): Promise<CellResult> {
  console.error(`\n=== ${label} — target=(${target.x},${target.y}) jitter=${jitter} ${n} trials ===`);
  const trials: Trial[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const t = await runTrial(target, jitter);
      trials.push(t);
      const resStr = t.residual?.toFixed(0) ?? 'unv';
      console.error(
        `  ${i + 1}/${n} success=${t.success ? 'Y' : 'N'} ` +
        `attempts=${t.attempts} hitOn=${t.attemptsToSuccess ?? '-'} residual=${resStr}px` +
        (t.failureReason ? ` reason="${t.failureReason.slice(0, 60)}…"` : ''),
      );
    } catch (e) {
      console.error(`  ${i + 1}/${n} ERROR: ${(e as Error).message}`);
      trials.push({
        success: false,
        attempts: 0,
        attemptsToSuccess: null,
        residual: null,
        cursorVerified: false,
        failureReason: `THROW: ${(e as Error).message}`,
      });
    }
  }
  return { label, trials };
}

function summarize(cell: CellResult): {
  successRate: number;
  perAttempt: Record<number, number>;
  meanResidual: number | null;
  medianResidual: number | null;
  cursorVerifyRate: number;
} {
  const N = cell.trials.length;
  const successCount = cell.trials.filter(t => t.success).length;
  const perAttempt: Record<number, number> = {};
  for (let i = 1; i <= MAX_RETRIES + 1; i++) perAttempt[i] = 0;
  for (const t of cell.trials) {
    if (t.attemptsToSuccess !== null) perAttempt[t.attemptsToSuccess]++;
  }
  const verifiedResiduals = cell.trials
    .filter(t => t.residual !== null)
    .map(t => t.residual!);
  const meanResidual = verifiedResiduals.length > 0
    ? verifiedResiduals.reduce((a, b) => a + b, 0) / verifiedResiduals.length
    : null;
  const medianResidual = verifiedResiduals.length > 0
    ? [...verifiedResiduals].sort((a, b) => a - b)[Math.floor(verifiedResiduals.length / 2)]
    : null;
  const cursorVerifyRate = cell.trials.filter(t => t.cursorVerified).length / Math.max(1, N);
  return {
    successRate: successCount / Math.max(1, N),
    perAttempt,
    meanResidual,
    medianResidual,
    cursorVerifyRate,
  };
}

console.error(`Bench start. maxRetries=${MAX_RETRIES} (iPad default).`);

// PART A: Focused A/B at Settings (single target × 2 modes × 15 trials).
const SETTINGS = { x: 905, y: 800 };
const A_off = await runCell('A: Settings jitter OFF', SETTINGS, 0, 15);
const A_on  = await runCell('A: Settings jitter ON',  SETTINGS, 50, 15);

// PART B: Cross-target sweep with jitter on (4 targets × 10 trials).
const TARGETS_B: Array<{ name: string; x: number; y: number }> = [
  { name: 'Settings (small icon, badge)',     x: 905, y: 800 },
  { name: 'App Store (small icon)',           x: 905, y: 680 },
  { name: 'Books (small icon, leftmost col)', x: 640, y: 800 },
  { name: 'Files (small icon, top-right)',    x: 1035, y: 420 },
];
const B_results: CellResult[] = [];
for (const t of TARGETS_B) {
  const cell = await runCell(`B: ${t.name}`, { x: t.x, y: t.y }, 50, 10);
  B_results.push(cell);
}

// === SUMMARY ===
console.error(`\n\n========== SUMMARY ==========`);

console.error(`\n--- PART A: A/B at Settings (905, 800) ---`);
const sA_off = summarize(A_off);
const sA_on  = summarize(A_on);
console.error(`jitter OFF: ${(sA_off.successRate * 100).toFixed(0)}% (${A_off.trials.filter(t => t.success).length}/${A_off.trials.length})  per-attempt-hit: ${JSON.stringify(sA_off.perAttempt)}  median-residual=${sA_off.medianResidual?.toFixed(0) ?? 'unv'}px`);
console.error(`jitter ON : ${(sA_on.successRate * 100).toFixed(0)}% (${A_on.trials.filter(t => t.success).length}/${A_on.trials.length})  per-attempt-hit: ${JSON.stringify(sA_on.perAttempt)}  median-residual=${sA_on.medianResidual?.toFixed(0) ?? 'unv'}px`);
const liftA = (sA_on.successRate - sA_off.successRate) * 100;
console.error(`Lift: ${liftA >= 0 ? '+' : ''}${liftA.toFixed(0)} pp (${liftA >= 5 ? '✓ PASS' : liftA >= 0 ? '~ NEUTRAL' : '✗ FAIL'} acceptance bar +5 pp)`);

console.error(`\n--- PART B: Cross-target sweep (jitter ON, 10 trials each) ---`);
console.error(`${'Target'.padEnd(40)} | success | hit-on-attempt | median residual | verify`);
console.error(`${'-'.repeat(40)}-+---------+----------------+-----------------+-------`);
for (const cell of B_results) {
  const s = summarize(cell);
  const hitOnStr = Object.entries(s.perAttempt).filter(([, c]) => c > 0).map(([n, c]) => `${n}:${c}`).join(' ');
  console.error(
    `${cell.label.replace('B: ', '').padEnd(40)} |   ${(s.successRate * 100).toFixed(0).padStart(3)}%  | ${hitOnStr.padEnd(14)} |       ${s.medianResidual?.toFixed(0).padStart(5) ?? '  unv'}px |  ${(s.cursorVerifyRate * 100).toFixed(0)}%`,
  );
}

const allB = B_results.flatMap(c => c.trials);
const overallB = allB.filter(t => t.success).length / Math.max(1, allB.length);
console.error(`\nOverall (Part B aggregate): ${(overallB * 100).toFixed(0)}% (${allB.filter(t => t.success).length}/${allB.length})`);

process.exit(0);
