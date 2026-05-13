/**
 * v0.5.241 wiggle-verify diagnostic.
 *
 * Phase 310 tautology returned at v0.5.240: ML reports cursor on
 * Settings icon when cursor is actually elsewhere. Phase 317 adds
 * post-detection wiggle-verify (emit, re-detect, reject if static).
 *
 * This script runs moveToPixel against Settings target with verbose
 * logging so we can see whether the wiggle-verify REJECTS the
 * tautological detections. Captures pre/post frames for visual
 * verification.
 *
 * N=5 trials. Expected behavior: more REJECTED logs vs v0.5.240.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/v241-wiggle-verify/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== v0.5.241 wiggle-verify diagnostic at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

const TARGET = { x: 905, y: 800 };  // Settings
const N = 5;

interface TrialResult {
  trial: number;
  preFinalResidualPx: number | null;
  detectedPos: { x: number; y: number } | null;
  verboseLog: string;
  duration: number;
}
const results: TrialResult[] = [];

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

for (let trial = 1; trial <= N; trial++) {
  console.error(`\n--- Trial ${trial} ---`);
  const start = Date.now();
  try {
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  } catch {
    await unlockIpad(client, { dragPx: 1500 });
    await sleep(800);
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  }
  await sleep(1500);

  // Capture verbose output by redirecting console.error temporarily
  const verboseLines: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    verboseLines.push(msg);
    origErr.apply(console, args);
  };

  let move;
  try {
    move = await moveToPixel(
      client,
      { x: TARGET.x, y: TARGET.y },
      {
        strategy: 'detect-then-move',
        forbidSlamFallback: true,
        profile: profile ?? undefined,
        verbose: true,
      },
    );
  } catch (e) {
    move = null;
    verboseLines.push(`THREW: ${(e as Error).message.slice(0, 100)}`);
  } finally {
    console.error = origErr;
  }

  // Capture post-move screenshot
  const shot = await client.screenshot();
  await fs.writeFile(path.join(ROOT, `t${trial}-post.jpg`), shot.buffer);

  // Filter verbose log to ML-related lines only
  const mlLines = verboseLines.filter(l => l.includes('ML') || l.includes('wiggle'));

  results.push({
    trial,
    preFinalResidualPx: move?.finalResidualPx ?? null,
    detectedPos: move?.finalDetectedPosition ?? null,
    verboseLog: mlLines.join('\n'),
    duration: Date.now() - start,
  });

  console.error(`  residual=${move?.finalResidualPx?.toFixed(0) ?? 'n/a'}px detected=${move?.finalDetectedPosition ? `(${move.finalDetectedPosition.x},${move.finalDetectedPosition.y})` : 'NULL'}`);
  console.error(`  ML decisions:`);
  for (const l of mlLines.slice(-5)) console.error(`    ${l}`);
}

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, results }, null, 2));

console.error('\n=== Aggregate ===');
let acceptedCount = 0;
let rejectedCount = 0;
for (const r of results) {
  acceptedCount += (r.verboseLog.match(/ML detect ACCEPTED/g) ?? []).length;
  rejectedCount += (r.verboseLog.match(/ML detect REJECTED/g) ?? []).length;
}
console.error(`ML ACCEPTED total: ${acceptedCount}`);
console.error(`ML REJECTED total: ${rejectedCount}`);
console.error(`Ratio rejected: ${rejectedCount + acceptedCount > 0 ? (rejectedCount / (rejectedCount + acceptedCount) * 100).toFixed(0) : 0}%`);
console.error(`\nResults: ${ROOT}/results.json`);
process.exit(0);
