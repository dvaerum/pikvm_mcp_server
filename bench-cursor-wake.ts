/**
 * Characterize what wake-wiggle magnitude reliably renders the cursor.
 *
 * For each magnitude in {1, 5, 10, 20, 30, 60}:
 *   - 5 trials
 *   - Each trial:
 *     - Scramble cursor (so we don't carry state)
 *     - ipadGoHome + 1.2s settle (cursor presumed faded by now)
 *     - Emit (+mag, 0) then (-mag, 0) — back-and-forth, net zero
 *     - 200ms settle
 *     - Screenshot
 *
 * Output: data/cursor-wake/mag-NN/run-MM.jpg
 *
 * Then we visually inspect to see which magnitude consistently leaves
 * the cursor visible in the screenshot.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';

const TRIALS_PER_MAG = 5;
const WAKE_MAGS = [1, 5, 10, 20, 30, 60];

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/cursor-wake';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('ensuring iPad unlocked...');
await unlockIpad(client).catch(e => console.error(`unlock warning: ${e.message}`));
await new Promise(r => setTimeout(r, 1000));

for (const mag of WAKE_MAGS) {
  const magDir = path.join(ROOT, `mag-${String(mag).padStart(3, '0')}`);
  await fs.mkdir(magDir, { recursive: true });
  console.error(`\n=== Wake magnitude ${mag} (back-and-forth, net zero) ===`);
  for (let t = 1; t <= TRIALS_PER_MAG; t++) {
    // Scramble so each trial doesn't inherit last trial's cursor.
    await client.mouseMoveRelative(40, 40);
    await new Promise(r => setTimeout(r, 80));
    await client.mouseMoveRelative(-80, 80);
    await new Promise(r => setTimeout(r, 80));

    await ipadGoHome(client);
    await new Promise(r => setTimeout(r, 1200));

    // One-way wake: emit (+mag, 0). Cursor moves visibly, hopefully
    // re-renders. (Earlier back-and-forth net-zero variant produced 0/30
    // visible — iPadOS may aggregate the cancel-pair before render.)
    await client.mouseMoveRelative(mag, 0);
    await new Promise(r => setTimeout(r, 200));

    const shot = await client.screenshot();
    const file = path.join(magDir, `run-${String(t).padStart(2, '0')}.jpg`);
    await fs.writeFile(file, shot.buffer);
    console.error(`  trial ${t}/${TRIALS_PER_MAG}: saved ${file}`);
  }
}

console.error(`\nFrames in ${ROOT}/mag-*/`);
