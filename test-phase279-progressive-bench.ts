/**
 * Phase 279: interleaved A/B bench of progressiveOpenLoop on iPad.
 *
 * The bet: skip the big single-shot open-loop emit and rely entirely
 * on small chunked moves (~26 px each, up to 12 passes) with cursor
 * detection between each chunk. iPadOS's per-command px/mickey ratio
 * variance (live data: 9x spread on identical commands) should
 * average out across many short emissions instead of being amplified
 * by one big open-loop guess.
 *
 * The `progressiveOpenLoop` option has shipped (default false) since
 * Phase 22 but has never been live-benched. This phase tests it.
 *
 * Methodology:
 *   - 2 targets: (905, 800) near + (757, 832) far (documented
 *     ballistic-shortfall failure at ~2.5%)
 *   - 2 arms: progressiveOpenLoop=true vs false
 *   - Interleaved coin-flip per trial so iPad warm-up/drift cancels
 *     across arms
 *   - N=80 trials per arm (40 per target) = 160 total
 *   - Per-trial dump: full debugDir frames + full MoveToResult JSON
 *     for offline analysis and future ML cursor-classifier training
 *
 * Ship gate: any improvement (far > 2.5% AND near > 55%) — if the
 * bet works, flip default in MCP handler.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel, type MoveToResult } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT_BASE = './data/phase279-progressive-bench';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `${ROOT_BASE}/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TARGETS = [
  { name: 'near', x: 905, y: 800 },
  { name: 'far', x: 757, y: 832 },
];
const TRIALS_PER_TARGET_PER_ARM = 40;
const TOLERANCE_PX = 35;
const TOTAL_TRIALS = TARGETS.length * TRIALS_PER_TARGET_PER_ARM * 2;

interface TrialRecord {
  trialIndex: number;
  arm: 'on' | 'off';
  target: { name: string; x: number; y: number };
  detected: { x: number; y: number } | null;
  residual: number | null;
  withinTolerance: boolean;
  passCount: number;
  modes: string[];
  threw: string | null;
  durationMs: number;
}

console.error(`=== Phase 279 progressiveOpenLoop A/B bench at v${VERSION} ===`);
console.error(`Root:    ${ROOT}`);
console.error(`Trials:  ${TOTAL_TRIALS} (${TRIALS_PER_TARGET_PER_ARM}/target/arm × 2 targets × 2 arms)`);
console.error(`Targets: ${TARGETS.map(t => `${t.name}(${t.x},${t.y})`).join(', ')}`);
console.error(`Tol:     ${TOLERANCE_PX} px\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

// Build interleaved trial plan up-front so we can write it to disk
// for resumability and reproducibility. Each (arm, target) pair has
// TRIALS_PER_TARGET_PER_ARM slots. Interleave with a deterministic
// shuffle so the bench is repeatable.
function buildPlan(): { arm: 'on' | 'off'; target: typeof TARGETS[number] }[] {
  const slots: { arm: 'on' | 'off'; target: typeof TARGETS[number] }[] = [];
  for (const target of TARGETS) {
    for (let i = 0; i < TRIALS_PER_TARGET_PER_ARM; i++) {
      slots.push({ arm: 'on', target });
      slots.push({ arm: 'off', target });
    }
  }
  // Fisher-Yates with fixed seed for reproducibility
  let seed = 0x279abc;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots;
}

const plan = buildPlan();
await fs.writeFile(
  `${ROOT}/plan.json`,
  JSON.stringify(plan.map((p, i) => ({ trial: i + 1, arm: p.arm, target: p.target.name })), null, 2),
);

const trials: TrialRecord[] = [];

for (let i = 0; i < plan.length; i++) {
  const slot = plan[i];
  const trialNum = i + 1;
  const trialDir = `${ROOT}/${slot.arm}/${slot.target.name}/t${trialNum.toString().padStart(3, '0')}`;
  await fs.mkdir(trialDir, { recursive: true });

  console.error(
    `\n--- Trial ${trialNum}/${plan.length} ` +
    `[arm=${slot.arm}] target=${slot.target.name}(${slot.target.x},${slot.target.y}) ---`,
  );

  try {
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  } catch (e) {
    console.error(`  goHome failed: ${(e as Error).message.slice(0, 80)} — re-unlocking`);
    try {
      await unlockIpad(client, { dragPx: 1500 });
      await sleep(800);
      await ipadGoHome(client, { forceHomeViaSwipe: true });
    } catch (e2) {
      console.error(`  recovery failed: ${(e2 as Error).message.slice(0, 80)} — skipping trial`);
      continue;
    }
  }
  await sleep(1200);

  const t0 = Date.now();
  let result: MoveToResult | null = null;
  let threw: string | null = null;

  try {
    result = await moveToPixel(
      client,
      { x: slot.target.x, y: slot.target.y },
      {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
        progressiveOpenLoop: slot.arm === 'on',
        debugDir: trialDir,
      },
    );
  } catch (e) {
    threw = (e as Error).message;
  }

  const durationMs = Date.now() - t0;

  let detected: { x: number; y: number } | null = null;
  let residual: number | null = null;
  let passCount = 0;
  let modes: string[] = [];
  if (result) {
    if (result.finalDetectedPosition) {
      detected = { x: result.finalDetectedPosition.x, y: result.finalDetectedPosition.y };
      residual = Math.hypot(detected.x - slot.target.x, detected.y - slot.target.y);
    }
    passCount = result.diagnostics.length;
    modes = result.diagnostics.map(d => d.mode);

    // Persist full MoveToResult minus the heavy screenshot Buffer.
    // The debugDir frames cover that; we want lossless diagnostics
    // for offline analysis and ML labelling.
    const { screenshot: _drop, ...resultSerialisable } = result;
    void _drop;
    await fs.writeFile(
      `${trialDir}/result.json`,
      JSON.stringify(resultSerialisable, null, 2),
    );
  }

  const within = residual !== null && residual <= TOLERANCE_PX;
  const record: TrialRecord = {
    trialIndex: trialNum,
    arm: slot.arm,
    target: slot.target,
    detected,
    residual,
    withinTolerance: within,
    passCount,
    modes,
    threw,
    durationMs,
  };
  trials.push(record);
  await fs.writeFile(`${trialDir}/trial-meta.json`, JSON.stringify(record, null, 2));

  console.error(
    `  detected=${detected ? `(${detected.x},${detected.y})` : 'null'.padEnd(10)} ` +
    `residual=${residual !== null ? residual.toFixed(0).padStart(4) + 'px' : ' n/a '} ` +
    `${within ? 'HIT' : 'MISS'} ` +
    `passes=${passCount} modes=[${modes.join(',')}] ` +
    `${durationMs}ms${threw ? ` THREW: ${threw.slice(0, 60)}` : ''}`,
  );
}

// Aggregate per (arm, target)
interface CellSummary {
  arm: 'on' | 'off';
  target: string;
  n: number;
  hits: number;
  hitRate: number;
  medianResidual: number | null;
  threwCount: number;
}

const cells: CellSummary[] = [];
for (const arm of ['on', 'off'] as const) {
  for (const target of TARGETS) {
    const cellTrials = trials.filter(t => t.arm === arm && t.target.name === target.name);
    const hits = cellTrials.filter(t => t.withinTolerance).length;
    const valid = cellTrials.filter(t => t.residual !== null).map(t => t.residual!);
    valid.sort((a, b) => a - b);
    const median = valid.length > 0 ? valid[Math.floor(valid.length / 2)] : null;
    cells.push({
      arm,
      target: target.name,
      n: cellTrials.length,
      hits,
      hitRate: cellTrials.length > 0 ? hits / cellTrials.length : 0,
      medianResidual: median,
      threwCount: cellTrials.filter(t => t.threw !== null).length,
    });
  }
}

const summary = {
  version: VERSION,
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  trialsPerCell: TRIALS_PER_TARGET_PER_ARM,
  toleranceX: TOLERANCE_PX,
  cells,
};
await fs.writeFile(`${ROOT}/summary.json`, JSON.stringify(summary, null, 2));

console.error(`\n\n=== AGGREGATE RESULT ===`);
console.error(`Version: ${VERSION}`);
console.error(`Run:     ${RUN_ID}`);
console.error(`Trials:  ${trials.length}/${plan.length}\n`);
console.error(
  `| Arm | Target | N  | Hits | Rate    | Median | Threw |`,
);
console.error(
  `|-----|--------|----|------|---------|--------|-------|`,
);
for (const c of cells) {
  console.error(
    `| ${c.arm.padEnd(3)} | ${c.target.padEnd(6)} | ${c.n.toString().padStart(2)} | ` +
    `${c.hits.toString().padStart(4)} | ` +
    `${(c.hitRate * 100).toFixed(1).padStart(5)}% | ` +
    `${c.medianResidual !== null ? c.medianResidual.toFixed(0).padStart(5) + 'p' : '   n/a'} | ` +
    `${c.threwCount.toString().padStart(5)} |`,
  );
}

console.error(`\n=== SHIP GATE ===`);
const onNear = cells.find(c => c.arm === 'on' && c.target === 'near')!;
const offNear = cells.find(c => c.arm === 'off' && c.target === 'near')!;
const onFar = cells.find(c => c.arm === 'on' && c.target === 'far')!;
const offFar = cells.find(c => c.arm === 'off' && c.target === 'far')!;

const nearBeats = onNear.hitRate > offNear.hitRate;
const farBeats = onFar.hitRate > offFar.hitRate;
const nearDelta = (onNear.hitRate - offNear.hitRate) * 100;
const farDelta = (onFar.hitRate - offFar.hitRate) * 100;

console.error(`near: on=${(onNear.hitRate * 100).toFixed(1)}% off=${(offNear.hitRate * 100).toFixed(1)}% Δ=${nearDelta >= 0 ? '+' : ''}${nearDelta.toFixed(1)}pp ${nearBeats ? '✓ ON better' : '✗ off >= on'}`);
console.error(`far : on=${(onFar.hitRate * 100).toFixed(1)}% off=${(offFar.hitRate * 100).toFixed(1)}% Δ=${farDelta >= 0 ? '+' : ''}${farDelta.toFixed(1)}pp ${farBeats ? '✓ ON better' : '✗ off >= on'}`);

if (nearBeats && farBeats) {
  console.error(`\nVERDICT: SHIP — progressiveOpenLoop improves both targets.`);
} else if (nearBeats || farBeats) {
  console.error(`\nVERDICT: MIXED — improves only one target. Don't ship yet; investigate why.`);
} else {
  console.error(`\nVERDICT: NO-SHIP — progressiveOpenLoop did not improve over status quo. Keep default false.`);
}

console.error(`\nFull trial dumps under ${ROOT}`);
console.error(`Summary: ${ROOT}/summary.json`);
process.exit(0);
