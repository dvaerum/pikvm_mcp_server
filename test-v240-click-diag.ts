/**
 * v0.5.240 click-protocol diagnostic.
 *
 * The Phase 316 bench showed cursor at residual ≤ 20 px on Settings
 * icon (cursor unambiguously on icon) but click registered 0/5
 * times. This script captures the actual frames during the click
 * sequence so we can SEE what's happening:
 *
 *   1. Move cursor to Settings (905, 800)
 *   2. Wait 300 ms (let snap animation settle)
 *   3. Capture pre-click frame
 *   4. Click with downMs=150 (current default)
 *   5. Wait 1500 ms
 *   6. Capture post-click frame
 *
 * Then repeat with downMs=300 and downMs=500 to test if longer hold
 * helps.
 *
 * Per memory: screenshots are source of truth. Look at them.
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

const ROOT = `./data/v240-click-diag/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== v0.5.240 click-protocol diagnostic at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

const TARGET = { x: 905, y: 800 };  // Settings

interface TrialResult {
  trial: number;
  variant: string;
  downMs: number;
  preSettleMs: number;
  preFinalResidualPx: number | null;
  detectedPos: { x: number; y: number } | null;
  changedFraction: number;
  duration: number;
}
const results: TrialResult[] = [];

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const VARIANTS = [
  { name: 'baseline-150', downMs: 150, preSettleMs: 0 },
  { name: 'settle300-down150', downMs: 150, preSettleMs: 300 },
  { name: 'settle500-down300', downMs: 300, preSettleMs: 500 },
  { name: 'settle500-down500', downMs: 500, preSettleMs: 500 },
];

let trialN = 0;
for (const variant of VARIANTS) {
  console.error(`\n--- Variant: ${variant.name} (downMs=${variant.downMs}, preSettle=${variant.preSettleMs}) ---`);
  for (let trial = 1; trial <= 3; trial++) {
    trialN++;
    const start = Date.now();
    try {
      await ipadGoHome(client, { forceHomeViaSwipe: true });
    } catch {
      await unlockIpad(client, { dragPx: 1500 });
      await sleep(800);
      await ipadGoHome(client, { forceHomeViaSwipe: true });
    }
    await sleep(1500);

    // Move cursor to target using moveToPixel (the production path)
    const move = await moveToPixel(
      client,
      { x: TARGET.x, y: TARGET.y },
      {
        strategy: 'detect-then-move',
        forbidSlamFallback: true,
        profile: profile ?? undefined,
      },
    ).catch((e) => {
      console.error(`  [${variant.name} t${trial}] moveToPixel threw: ${(e as Error).message.slice(0, 80)}`);
      return null;
    });
    if (!move) {
      results.push({ trial: trialN, variant: variant.name, downMs: variant.downMs, preSettleMs: variant.preSettleMs, preFinalResidualPx: null, detectedPos: null, changedFraction: 0, duration: Date.now() - start });
      continue;
    }

    // Variant-specific pre-click settle
    if (variant.preSettleMs > 0) await sleep(variant.preSettleMs);

    // Capture pre-click frame
    const pre = await client.screenshot();
    await fs.writeFile(path.join(ROOT, `t${trialN}-${variant.name}-pre.jpg`), pre.buffer);

    // Click with variant downMs
    await client.mouseClick('left', { downMs: variant.downMs });

    // Wait for any UI response
    await sleep(1500);

    // Capture post-click frame
    const post = await client.screenshot();
    await fs.writeFile(path.join(ROOT, `t${trialN}-${variant.name}-post.jpg`), post.buffer);

    // Compute changedFraction (simple sum-abs-diff over downsampled RGB)
    let changed = 0;
    let total = 0;
    const preB = pre.buffer;
    const postB = post.buffer;
    const len = Math.min(preB.length, postB.length);
    const stride = Math.max(1, Math.floor(len / 50000));
    for (let i = 0; i < len; i += stride) {
      if (Math.abs(preB[i] - postB[i]) > 10) changed++;
      total++;
    }
    const changedFraction = total > 0 ? changed / total : 0;

    results.push({
      trial: trialN,
      variant: variant.name,
      downMs: variant.downMs,
      preSettleMs: variant.preSettleMs,
      preFinalResidualPx: move.finalResidualPx,
      detectedPos: move.finalDetectedPosition,
      changedFraction,
      duration: Date.now() - start,
    });
    console.error(
      `  [${variant.name} t${trial}] residual=${move.finalResidualPx?.toFixed(0) ?? 'n/a'}px ` +
      `changed=${(changedFraction * 100).toFixed(1)}% ${(Date.now() - start)}ms`,
    );
  }
}

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, results }, null, 2));

console.error('\n=== Aggregate ===');
for (const variant of VARIANTS) {
  const subset = results.filter(r => r.variant === variant.name);
  const triggered = subset.filter(r => r.changedFraction > 0.05).length;
  console.error(`  ${variant.name}: ${triggered}/${subset.length} screen-changed (changedFraction > 5%)`);
}
console.error(`\nResults: ${ROOT}/results.json`);
console.error(`Inspect pre/post frame pairs to verify cursor visibility and any UI response.`);
process.exit(0);
