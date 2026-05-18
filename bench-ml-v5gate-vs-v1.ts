/**
 * Live A/B: v1 baseline vs (v5 presence gate + v1) two-stage.
 *
 *   # Baseline (v1 alone):
 *   PIKVM_ML_MODEL=ml/cursor-v1.onnx \
 *     npx tsx bench-ml-v5gate-vs-v1.ts v1 10
 *
 *   # v5-gated (v5 short-circuits v1 when no cursor):
 *   PIKVM_ML_MODEL=ml/cursor-v1.onnx \
 *   PIKVM_ML_V5_PRESENCE_GATE=1 \
 *     npx tsx bench-ml-v5gate-vs-v1.ts v5gate 10
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor, verifyClickByDiff } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

// 2026-05-17: strict-success threshold. The default screenChanged
// uses minChangedFraction=0.005 (0.5%), which a single clock-minute
// tick on the iPad home screen can satisfy via JPEG noise around the
// clock digits — producing phantom "hit" classifications even when
// the click did nothing. Real app-open changes essentially the
// entire iPad area, ≥30-50% of pixels. Audit (2026-05-17) confirmed
// 3 of 3 v1 Books "hits" were clock-tick false positives.
const STRICT_MIN_CHANGED_FRACTION = 0.10;

const variant = process.argv[2];
if (variant !== 'v1' && variant !== 'v5gate') {
  console.error('usage: bench-ml-v5gate-vs-v1.ts <v1|v5gate> [trials]');
  process.exit(1);
}
const TRIALS = process.argv[3] !== undefined ? Number(process.argv[3]) : 10;

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = path.join('./data/ml-v5gate-ab', variant);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'results.jsonl');

interface Target { name: string; slug: string; x: number; y: number; }
const TARGETS: Target[] = [
  { name: 'Settings', slug: 'settings', x: 905, y: 808 },
  { name: 'Books',    slug: 'books',    x: 642, y: 808 },
  { name: 'Files',    slug: 'files',    x: 1037, y: 425 },
];

console.error(
  `variant=${variant} model=${process.env.PIKVM_ML_MODEL ?? '(default)'} ` +
  `v5_gate=${process.env.PIKVM_ML_V5_PRESENCE_GATE === '1' ? 'on' : 'off'}`,
);
console.error(`trials per target=${TRIALS}`);

for (const target of TARGETS) {
  const dir = path.join(ROOT, target.slug);
  await fs.mkdir(dir, { recursive: true });
  let hits = 0;
  let strictHits = 0;
  for (let i = 0; i < TRIALS; i++) {
    await ipadGoHome(client);
    await new Promise((r) => setTimeout(r, 900));
    // Strict-metric pre-screenshot: taken AFTER ipadGoHome settles so
    // a real app-open will be obviously different from the home-screen
    // baseline. Compared post-click against `shot` below to compute
    // the strict success signal.
    const preStrictShot = await client.screenshot();
    const t0 = Date.now();
    let success = false;
    let residual: number | null = null;
    let attempts = 0;
    let error: string | null = null;
    try {
      const r = await clickAtWithRetry(client, { x: target.x, y: target.y }, {
        maxRetries: defaultMaxRetriesFor(false),
        moveToOptions: {
          profile: profile ?? undefined,
        },
      });
      success = r.success;
      attempts = r.attempts ?? 0;
      const finalDetected = r.finalMoveResult?.finalDetectedPosition ?? null;
      if (finalDetected) {
        residual = Math.round(Math.hypot(
          finalDetected.x - target.x,
          finalDetected.y - target.y,
        ));
      }
    } catch (e: unknown) {
      error = (e as Error).message;
    }
    const elapsedMs = Date.now() - t0;
    const shot = await client.screenshot();
    // Strict success: ≥10% of the full frame changed between pre-bench
    // and post-bench screenshots. A real app-open changes essentially
    // the whole iPad area; a clock tick changes <0.1%.
    const strictVerify = await verifyClickByDiff(preStrictShot.buffer, shot.buffer, {
      minChangedFraction: STRICT_MIN_CHANGED_FRACTION,
    });
    const strictSuccess = strictVerify.screenChanged;
    const tag = success ? 'hit' : 'miss';
    const strictTag = strictSuccess ? 'strict-hit' : 'strict-miss';
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${tag}-${strictTag}.jpg`);
    await fs.writeFile(file, shot.buffer);
    if (success) hits++;
    if (strictSuccess) strictHits++;
    const row = {
      variant, target: target.name, trial: i + 1,
      success, strictSuccess,
      strictChangedFraction: strictVerify.changedFraction,
      attempts, residual, elapsedMs, file, error,
    };
    await fs.appendFile(LOG, JSON.stringify(row) + '\n');
    console.error(
      `${variant} ${target.name} trial ${i + 1}/${TRIALS}: ` +
      `${success ? 'HIT' : 'MISS'} (strict=${strictSuccess ? 'HIT' : 'MISS'} ` +
      `Δ=${(strictVerify.changedFraction * 100).toFixed(1)}%) ` +
      `attempts=${attempts} residual=${residual ?? '-'} ${elapsedMs}ms` +
      (error ? ` err=${error}` : ''),
    );
  }
  console.error(
    `  ${target.name} ${variant}: original=${hits}/${TRIALS} ` +
    `(${(100 * hits / TRIALS).toFixed(0)}%)  ` +
    `STRICT=${strictHits}/${TRIALS} (${(100 * strictHits / TRIALS).toFixed(0)}%)`,
  );
}

console.error(`\nlogs: ${LOG}`);
