/**
 * Phase 194-C — A/B test for preClickApproachMickeys.
 *
 * Phase 143 reasoning: iPadOS pointer-effect snap zone needs the
 * cursor moving INTO the icon at button-down time. 10 mickeys
 * (≈13 px at ratio 1.3) was the Phase 143 default. Phase 194-B
 * bench data shows even at residual 23-27 px the click still
 * misses, suggesting 10 mickeys' velocity may still be below the
 * iPadOS snap-engagement threshold.
 *
 * This bench runs 5 trials per (target, approachMickeys) cell,
 * with two values: 10 (baseline) and 20 (larger velocity). If
 * approach=20 shows ≥ 5 pp lift on cumulative success, it's worth
 * shipping as the new default. If no lift or worse, revert.
 *
 * Usage: npx tsx bench-approach-ab.ts
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

const ROOT = './data/approach-ab';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

interface Target { name: string; slug: string; x: number; y: number; }
const TARGETS: Target[] = [
  { name: 'Settings', slug: 'settings', x: 905, y: 800 },
  { name: 'Books',    slug: 'books',    x: 640, y: 800 },
];
const VARIANTS = [10, 20] as const;
const TRIALS = 5;

interface Trial {
  target: string;
  variant: number;
  trial: number;
  success: boolean;
  attempts: number;
  residual: number | null;
}

const log: Trial[] = [];

async function runTrial(t: Target, approach: number, n: number): Promise<Trial> {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
  const r = await clickAtWithRetry(client, { x: t.x, y: t.y }, {
    maxRetries: defaultMaxRetriesFor(false),
    moveToOptions: {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    },
    minBrightness: 0,
    requireVerifiedCursor: false,
    preClickApproachMickeys: approach,
    verifyOptions: {
      region: { x: t.x, y: t.y, halfWidth: 50, halfHeight: 50 },
      minChangedFraction: 0.05,
    },
  });
  // Save post-click frame
  await new Promise(r => setTimeout(r, 600));
  const shot = await client.screenshot({ quality: 75 });
  const verdict = r.success ? 'hit' : 'miss';
  const file = path.join(ROOT, `${t.slug}-ap${approach}-${n.toString().padStart(2, '0')}-${verdict}.jpg`);
  await fs.writeFile(file, shot.buffer);
  const cursor = r.finalMoveResult.finalDetectedPosition;
  const residual = cursor ? Math.hypot(cursor.x - t.x, cursor.y - t.y) : null;
  return {
    target: t.slug, variant: approach, trial: n,
    success: r.success, attempts: r.attempts, residual,
  };
}

console.error(`A/B: preClickApproachMickeys ${VARIANTS.join(' vs ')}, ${TRIALS} trials × ${TARGETS.length} targets × 2 variants = ${TRIALS * TARGETS.length * 2} clicks\n`);

for (const variant of VARIANTS) {
  console.error(`\n=== variant: approach=${variant} mickeys ===`);
  for (const t of TARGETS) {
    console.error(`  --- ${t.name} (${t.x}, ${t.y}) ---`);
    for (let n = 1; n <= TRIALS; n++) {
      try {
        const tr = await runTrial(t, variant, n);
        log.push(tr);
        const status = tr.success ? '✓' : '✗';
        console.error(`    ${n}/${TRIALS} ${status} attempts=${tr.attempts} residual=${tr.residual?.toFixed(0) ?? 'unv'}px`);
      } catch (e) {
        console.error(`    ${n}/${TRIALS} ERROR: ${(e as Error).message}`);
        log.push({ target: t.slug, variant, trial: n, success: false, attempts: 0, residual: null });
      }
    }
  }
}

await fs.writeFile(path.join(ROOT, 'log.json'), JSON.stringify(log, null, 2));

// Aggregate
console.error('\n========== A/B SUMMARY ==========');
console.error('approach | target   | hits | rate  | median residual');
console.error('---------+----------+------+-------+----------------');
for (const variant of VARIANTS) {
  for (const t of TARGETS) {
    const trials = log.filter(x => x.variant === variant && x.target === t.slug);
    const hits = trials.filter(x => x.success).length;
    const residuals = trials.filter(x => x.residual !== null).map(x => x.residual!);
    const median = residuals.length > 0
      ? [...residuals].sort((a, b) => a - b)[Math.floor(residuals.length / 2)].toFixed(0)
      : 'n/a';
    console.error(
      `   ${variant.toString().padStart(2)}    | ${t.slug.padEnd(8)} |  ${hits}/${TRIALS}  | ${(hits/TRIALS*100).toFixed(0).padStart(3)} % |       ${median.padStart(4)} px`
    );
  }
}
const cumulative: Record<number, { hits: number; trials: number }> = {};
for (const v of VARIANTS) cumulative[v] = { hits: 0, trials: 0 };
for (const t of log) {
  cumulative[t.variant].trials++;
  if (t.success) cumulative[t.variant].hits++;
}
console.error(`\nCumulative:`);
for (const v of VARIANTS) {
  const c = cumulative[v];
  console.error(`  approach=${v}: ${c.hits}/${c.trials} = ${(c.hits/c.trials*100).toFixed(0)} %`);
}
process.exit(0);
