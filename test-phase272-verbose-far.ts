/**
 * Phase 272: verbose-logged moveToPixel run at far target (757, 832)
 * to see which detector path each correction-pass uses.
 *
 * Phase 270 measured 2.5% click rate at this target (vs 50% at the
 * near target 905, 800). Phase 271 confirmed the detector itself
 * is tuned correctly. So WHERE in the move-to-far-target pipeline
 * is the failure?
 *
 * Hypothesis A: ballistic emit doesn't carry cursor close to target
 *   → cursor ends ~300 px from predicted → outside locality radius
 *   → shape returns null → fall through to predicted (wrong)
 *   passMode distribution: mostly 'predicted'
 *
 * Hypothesis B: detector picks confident-wrong at intermediate
 *   positions → algorithm converges believing it's at target
 *   when actually not
 *   passMode distribution: 'template' or 'motion' with wrong positions
 *
 * Hypothesis C: shape-detect IS firing but at wrong positions
 *   (false positive from dock icons or widgets along the path)
 *   passMode distribution: 'shape' with positions in dock/widget areas
 *
 * Procedure: 3 trials, verbose=true, capture stderr per trial.
 * Examine pass-by-pass diagnostics to determine which mode is
 * winning each correction pass.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase272-verbose/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 272 verbose far-target diagnostic at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 757, y: 832 };
const N = 3;

for (let i = 1; i <= N; i++) {
  console.error(`\n========== Trial ${i}/${N} ==========`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
      verbose: true,
    });

    console.error(`\n--- Trial ${i} pass diagnostics ---`);
    for (const d of r.diagnostics) {
      console.error(
        `  pass ${d.pass} mode=${d.mode.padEnd(10)} ` +
        `detected (${d.detectedAt.x},${d.detectedAt.y}) residual=${d.residualPx.toFixed(0)}px`,
      );
    }
    console.error(`\n--- Trial ${i} corrections ---`);
    for (const c of r.corrections) {
      console.error(`  mode=${c.mode.padEnd(10)} reason: ${c.reason}`);
    }
    console.error(`\n--- Trial ${i} final ---`);
    console.error(`  finalDetectedPosition: ${r.finalDetectedPosition ? `(${r.finalDetectedPosition.x},${r.finalDetectedPosition.y})` : 'null'}`);
    const finalResid = r.finalDetectedPosition
      ? Math.hypot(r.finalDetectedPosition.x - TARGET.x, r.finalDetectedPosition.y - TARGET.y)
      : null;
    console.error(`  final residual: ${finalResid !== null ? finalResid.toFixed(0) + ' px' : 'n/a'}`);
  } catch (e) {
    console.error(`  moveToPixel threw: ${(e as Error).message.slice(0, 200)}`);
  }

  try {
    const shot = await client.screenshot();
    await fs.writeFile(`${ROOT}/t${i}-post.jpg`, shot.buffer);
  } catch {/* ignore */}
}

console.error(`\nFrames saved to ${ROOT}`);
process.exit(0);
