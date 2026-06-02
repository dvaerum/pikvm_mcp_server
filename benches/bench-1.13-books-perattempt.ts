/**
 * 1.13 Diagnostic — per-attempt frame capture on the Books target.
 *
 * The 1.11 production bench saved one POST-FINAL-ATTEMPT frame per
 * trial. That isn't enough to distinguish "cursor moved between
 * attempts" (pointer-accel / retry-strategy story) from "detector
 * reported different positions while cursor stayed roughly still"
 * (detector-confusion story). The roadmap walked back 1.13's first
 * closure because the appstore/02 trial proved the detector can
 * report a 60 px residual while the cursor visibly sits ON target.
 *
 * This bench bypasses clickAtWithRetry's retry loop and instead
 * iterates moveToPixel manually, saving a fresh screenshot AFTER
 * each call. The output lets a human eye answer two questions
 * per trial:
 *   (a) Did the cursor actually move between attempts?
 *   (b) Was the detector's reported position physically correct?
 *
 * Books target is the focus because it failed 2/5 in 1.11 treatment
 * (highest per-target failure rate among the v2-wider arm).
 *
 * Usage: npx tsx benches/bench-1.13-books-perattempt.ts [trials=8]
 *
 * No CLICKING — this is a positioning diagnostic only. We don't want
 * the iPad launching apps between attempts.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const TRIALS = Number(process.argv[2] ?? 8);
const TARGET = { name: 'Books', x: 757, y: 837 };
const ATTEMPTS_PER_TRIAL = 4; // matches production maxRetries=3 → 4 attempts
const ROOT = './data/bench-1.13-books-perattempt';

await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

console.error(`Per-attempt diagnostic on ${TARGET.name} (${TARGET.x}, ${TARGET.y})`);
console.error(`Trials: ${TRIALS}, attempts/trial: ${ATTEMPTS_PER_TRIAL}`);
console.error(`Output: ${ROOT}/`);
console.error(`Profile: ${profile ? 'loaded' : 'none'}`);
console.error('');

// One row per (trial, attempt) — written incrementally so we can
// CTRL-C and still inspect partial output.
const summaryPath = path.join(ROOT, 'summary.tsv');
await fs.writeFile(summaryPath, 'trial\tattempt\tdetected_x\tdetected_y\tresidual_px\tframe\n');

for (let trial = 1; trial <= TRIALS; trial++) {
  const trialDir = path.join(ROOT, `trial-${String(trial).padStart(2, '0')}`);
  await fs.mkdir(trialDir, { recursive: true });
  console.error(`=== trial ${trial}/${TRIALS} ===`);

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));

  // Snapshot the home-state pre-attempt frame for "where did cursor
  // start" context.
  const startShot = await client.screenshot({ quality: 75 });
  await fs.writeFile(path.join(trialDir, '00-start.jpg'), startShot.buffer);

  for (let attempt = 1; attempt <= ATTEMPTS_PER_TRIAL; attempt++) {
    let detected: { x: number; y: number } | null = null;
    let residual = Number.NaN;
    let errMsg: string | null = null;

    try {
      const r = await moveToPixel(client, TARGET, {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
      });
      detected = r.finalDetectedPosition;
      if (detected) {
        residual = Math.hypot(detected.x - TARGET.x, detected.y - TARGET.y);
      }
    } catch (e) {
      errMsg = (e as Error).message;
    }

    // Capture the frame as moveToPixel left it.
    const shot = await client.screenshot({ quality: 75 });
    const frameName = `a${attempt}-detected${detected ? `_${detected.x},${detected.y}` : '_null'}_resid${Number.isFinite(residual) ? residual.toFixed(0) : 'NA'}.jpg`;
    await fs.writeFile(path.join(trialDir, frameName), shot.buffer);

    const summaryRow =
      `${trial}\t${attempt}\t` +
      `${detected?.x ?? ''}\t${detected?.y ?? ''}\t` +
      `${Number.isFinite(residual) ? residual.toFixed(1) : ''}\t` +
      `trial-${String(trial).padStart(2, '0')}/${frameName}\n`;
    await fs.appendFile(summaryPath, summaryRow);

    if (errMsg) {
      console.error(`  a${attempt}: moveToPixel THREW — ${errMsg.slice(0, 100)}`);
    } else {
      console.error(
        `  a${attempt}: detector=${detected ? `(${detected.x},${detected.y})` : 'null'} residual=${Number.isFinite(residual) ? residual.toFixed(1) : 'NA'}px → ${frameName}`,
      );
    }
  }

  console.error('');
}

console.error(`Summary: ${summaryPath}`);
console.error(`Frames:  ${ROOT}/trial-NN/aN-detected_X,Y_residZ.jpg`);
console.error('');
console.error('Next: visually inspect each trial-NN/ to answer per attempt:');
console.error('  (1) Did the cursor physically move between attempts?');
console.error('  (2) Is the detector-reported position correct?');
