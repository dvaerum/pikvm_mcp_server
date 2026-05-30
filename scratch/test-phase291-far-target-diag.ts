/**
 * Phase 291: deep diagnostic of far-target (757, 832) failures.
 *
 * Far target hits 0% with the production click pipeline. Phase 286
 * showed the cursor is visible in the frames but shape-detect locks
 * onto clock-widget FP. Phase 290 confirmed the locality gate
 * already suppresses clock-FP in production — yet far still fails.
 *
 * Methodology: 5 trials. For each:
 *   - Re-home iPad
 *   - Save PRE frame (cursor at home position)
 *   - moveToPixel to (757, 832)
 *   - Save POST frame + dump full diagnostics array
 *   - Save belief.position history
 *
 * Output dir: data/phase291-far-target/{timestamp}/t{NN}/
 *   - t01-pre.jpg
 *   - t01-post.jpg
 *   - t01-diagnostics.json (passes + belief snapshots)
 *
 * Then visually inspect: where IS the cursor in post.jpg? What did
 * the algorithm think? Where did it land?
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

const ROOT = `./data/phase291-far-target/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 291 far-target diagnostic at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 757, y: 832 };
const N = 5;

interface TrialResult {
  trial: number;
  preCursorBelief: { x: number; y: number };
  preCursorVariance: number;
  predicted: { x: number; y: number };
  emittedMickeys: { x: number; y: number };
  chunkCount: number;
  finalDetected: { x: number; y: number } | null;
  finalResidual: number | null;
  bailedToBestPass: boolean;
  passesSinceLastVerification: number;
  diagnostics: unknown[];
  postBeliefPosition: { x: number; y: number };
  postBeliefVariance: number;
}

const results: TrialResult[] = [];

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);

  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  // Save PRE frame
  const pre = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-pre.jpg`, pre.buffer);

  // Snapshot belief
  const preBelief = {
    x: client.belief.position.x,
    y: client.belief.position.y,
  };
  const preVar = Math.hypot(client.belief.variance.x, client.belief.variance.y);
  console.error(`  pre belief: (${preBelief.x.toFixed(0)},${preBelief.y.toFixed(0)}) σ²=${preVar.toFixed(0)}`);

  let r: Awaited<ReturnType<typeof moveToPixel>> | null = null;
  try {
    r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
  } catch (e) {
    console.error(`  moveToPixel threw: ${(e as Error).message.slice(0, 150)}`);
  }

  // Save POST frame
  const post = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-post.jpg`, post.buffer);

  const postBelief = {
    x: client.belief.position.x,
    y: client.belief.position.y,
  };
  const postVar = Math.hypot(client.belief.variance.x, client.belief.variance.y);

  if (r) {
    const detected = r.finalDetectedPosition;
    const residual = r.finalResidualPx;
    console.error(
      `  detected=${detected ? `(${detected.x},${detected.y})` : 'null'} ` +
      `residual=${residual !== null ? residual.toFixed(0) + 'px' : 'n/a'} ` +
      `bail=${r.bailedToBestPass} passesSinceVerif=${r.passesSinceLastVerification}`,
    );

    // Compact diagnostics summary
    console.error('  passes:');
    for (const d of r.diagnostics) {
      const at = d.detectedAt ? `(${d.detectedAt.x},${d.detectedAt.y})` : 'null';
      console.error(`    p${d.pass} ${d.mode.padEnd(9)} ${at.padEnd(15)} r=${d.residualPx.toFixed(0)}px reason=${(d.reason ?? 'ok').slice(0, 40)}`);
    }

    results.push({
      trial: i,
      preCursorBelief: preBelief,
      preCursorVariance: preVar,
      predicted: r.predicted,
      emittedMickeys: r.emittedMickeys,
      chunkCount: r.chunkCount,
      finalDetected: detected ?? null,
      finalResidual: residual ?? null,
      bailedToBestPass: r.bailedToBestPass,
      passesSinceLastVerification: r.passesSinceLastVerification,
      diagnostics: r.diagnostics as unknown[],
      postBeliefPosition: postBelief,
      postBeliefVariance: postVar,
    });
  }
}

// Write full diagnostic JSON
await fs.writeFile(`${ROOT}/results.json`, JSON.stringify({ version: VERSION, target: TARGET, trials: results }, null, 2));

console.error(`\n=== RESULT ===`);
const hitCount = results.filter(r => r.finalResidual !== null && r.finalResidual <= 35).length;
console.error(`Hit rate: ${hitCount}/${N} within 35 px`);
console.error(`See ${ROOT}/t*-post.jpg and visually verify cursor position.`);
process.exit(0);
