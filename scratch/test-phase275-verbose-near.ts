/**
 * Phase 275: verbose bench at NEAR target (905, 800) to diagnose
 * the remaining 50% failures.
 *
 * Phase 269 measured 50% within 35 px at this target. What happens
 * in the failed trials? Need passMode + per-pass detection mode +
 * final residual to know which detector class is leading to misses.
 *
 * Hypotheses:
 *   - Hyp A: failures are 'predicted' (no detector found cursor)
 *     → locality radius might be too tight, or cursor drifts beyond
 *       100 px expectation between emits
 *   - Hyp B: failures are 'template' (NCC) or 'motion' picking
 *     confident-wrong at non-cursor location
 *     → Phase 268 cross-check idea might still merit, with different
 *       rules
 *   - Hyp C: failures are 'shape' itself picking wrong feature
 *     → detector param tuning needed
 *
 * Procedure: N=10 trials, verbose=true on moveToPixel, log
 * final passMode + residual + reason per trial. Aggregate stats
 * separately for hit (<35 px) and miss (>35 px) trials.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase275-near-failures/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 275 near-target failure diagnostic at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 905, y: 800 };
const TOLERANCE = 35;
const N = 10;

interface TrialResult {
  i: number;
  residual: number | null;
  finalMode: string;
  finalReason: string | null;
  modeHistory: string[];
  hit: boolean;
}

const trials: TrialResult[] = [];

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  let residual: number | null = null;
  let finalMode = 'none';
  let finalReason: string | null = null;
  let modeHistory: string[] = [];

  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });

    if (r.finalDetectedPosition) {
      residual = Math.hypot(r.finalDetectedPosition.x - TARGET.x, r.finalDetectedPosition.y - TARGET.y);
    }

    modeHistory = r.diagnostics.map(d => d.mode);
    const lastDiag = r.diagnostics[r.diagnostics.length - 1];
    if (lastDiag) {
      finalMode = lastDiag.mode;
    }
    const lastCorr = r.corrections[r.corrections.length - 1];
    if (lastCorr) {
      finalReason = lastCorr.reason;
    }
  } catch (e) {
    finalReason = (e as Error).message.slice(0, 100);
  }

  const hit = residual !== null && residual <= TOLERANCE;
  trials.push({ i, residual, finalMode, finalReason, modeHistory, hit });

  console.error(
    `  residual=${residual !== null ? residual.toFixed(0).padStart(4) + 'px' : 'null  '}  ` +
    `final=${finalMode.padEnd(10)}  ` +
    `modes=[${modeHistory.join(',')}]  ` +
    `${hit ? '✓ HIT' : '✗ MISS'}`,
  );
}

console.error(`\n\n=== AGGREGATE ===`);
const hits = trials.filter(t => t.hit);
const misses = trials.filter(t => !t.hit);
console.error(`Hits: ${hits.length}/${N}  Misses: ${misses.length}/${N}`);

console.error(`\nFINAL passMode distribution among MISSES:`);
const missModes: Record<string, number> = {};
for (const t of misses) {
  missModes[t.finalMode] = (missModes[t.finalMode] || 0) + 1;
}
for (const [m, c] of Object.entries(missModes).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${m.padEnd(10)} ${c}/${misses.length}`);
}

console.error(`\nFINAL passMode distribution among HITS:`);
const hitModes: Record<string, number> = {};
for (const t of hits) {
  hitModes[t.finalMode] = (hitModes[t.finalMode] || 0) + 1;
}
for (const [m, c] of Object.entries(hitModes).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${m.padEnd(10)} ${c}/${hits.length}`);
}

console.error(`\nMiss residual distribution:`);
for (const t of misses) {
  console.error(`  t${t.i.toString().padStart(2)}: ${t.residual !== null ? t.residual.toFixed(0) + ' px' : 'null'} ` +
    `final=${t.finalMode} reason="${t.finalReason ? t.finalReason.slice(0, 80) : ''}"`);
}

console.error(`\n=== INTERPRETATION ===`);
if ((missModes['predicted'] ?? 0) > misses.length / 2) {
  console.error('Most misses ended in "predicted" mode (no detector found cursor).');
  console.error('Locality radius may be too tight OR cursor drifts beyond expected region.');
} else if ((missModes['template'] ?? 0) + (missModes['motion'] ?? 0) > misses.length / 2) {
  console.error('Most misses ended in "template" or "motion" with wrong position.');
  console.error('NCC or motion-diff returning confident-wrong matches — bypassing shape-detect.');
} else if ((missModes['shape'] ?? 0) > misses.length / 2) {
  console.error('Most misses ended in "shape" mode — detector itself picking wrong feature.');
  console.error('Re-examine shape-detect parameters or locality strategy.');
} else {
  console.error('Miss mode distribution is mixed; no single failure class dominates.');
}
process.exit(0);
