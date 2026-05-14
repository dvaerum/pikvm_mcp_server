/**
 * Live A/B: cursor-v0.bad-labels.onnx vs cursor-v1.onnx click rate.
 *
 * Run twice with different env vars:
 *   PIKVM_ML_MODEL=ml/cursor-v0.bad-labels.onnx npx tsx bench-ml-v0-vs-v1.ts v0
 *   PIKVM_ML_MODEL=ml/cursor-v1.onnx            npx tsx bench-ml-v0-vs-v1.ts v1
 *
 * Outputs:
 *   ./data/ml-ab/<variant>/results.jsonl
 *   ./data/ml-ab/<variant>/<target-slug>/NN-{hit|miss}.jpg
 *
 * For each trial:
 *   - go home via Cmd+H
 *   - clickAtWithRetry to the target
 *   - save the post-click screenshot
 *   - record success (screenChanged) and residual
 *
 * The two runs interleave with different env vars but use the
 * same code path otherwise.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const variant = process.argv[2];
if (variant !== 'v0' && variant !== 'v1') {
  console.error('usage: bench-ml-v0-vs-v1.ts <v0|v1>');
  process.exit(1);
}
const TRIALS = process.argv[3] !== undefined ? Number(process.argv[3]) : 8;

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = path.join('./data/ml-ab', variant);
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'results.jsonl');

// D1 fix (2026-05-14): Files coord (1180, 800) was wrong — landed
// in empty wallpaper to the right of the icon grid. Page-1 Files
// icon is at approx (1037, 425). Settings/Books were already
// roughly correct (≤10px off icon center).
interface Target { name: string; slug: string; x: number; y: number; }
const TARGETS: Target[] = [
  { name: 'Settings', slug: 'settings', x: 905, y: 808 },
  { name: 'Books',    slug: 'books',    x: 642, y: 808 },
  { name: 'Files',    slug: 'files',    x: 1037, y: 425 },
];

console.error(`variant=${variant} model=${process.env.PIKVM_ML_MODEL ?? '(default cursor-v1)'}`);
console.error(`trials per target=${TRIALS}`);

for (const target of TARGETS) {
  const dir = path.join(ROOT, target.slug);
  await fs.mkdir(dir, { recursive: true });
  let hits = 0;
  for (let i = 0; i < TRIALS; i++) {
    await ipadGoHome(client);
    await new Promise((r) => setTimeout(r, 900));
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
    // Save post-click screenshot for visual verification.
    const shot = await client.screenshot();
    const tag = success ? 'hit' : 'miss';
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${tag}.jpg`);
    await fs.writeFile(file, shot.buffer);
    if (success) hits++;
    const row = {
      variant, target: target.name, trial: i + 1, success,
      attempts, residual, elapsedMs, file, error,
    };
    await fs.appendFile(LOG, JSON.stringify(row) + '\n');
    console.error(
      `${variant} ${target.name} trial ${i + 1}/${TRIALS}: ` +
      `${success ? 'HIT' : 'MISS'} attempts=${attempts} ` +
      `residual=${residual ?? '-'} ${elapsedMs}ms` +
      (error ? ` err=${error}` : ''),
    );
  }
  console.error(
    `  ${target.name} ${variant}: hits=${hits}/${TRIALS} ` +
    `(${(100 * hits / TRIALS).toFixed(0)}%)`,
  );
}

console.error(`\nlogs: ${LOG}`);
