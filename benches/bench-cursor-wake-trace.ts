/**
 * Trace cursor position across each step of the wake protocol.
 * Captures a screenshot after each step so we can SEE whether
 * the cursor is somewhere off-screen vs really gone.
 *
 * Per trial:
 *   step 0: baseline (whatever state iPad is in)
 *   step 1: after scramble (up-right, so cursor stays in iPad area)
 *   step 2: after ipadGoHome
 *   step 3: after a sustained wake (40 × +3 mickeys)
 *
 * 3 trials.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const TRIALS = 3;
const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/cursor-wake-trace';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('ensuring iPad unlocked...');
await unlockIpad(client).catch(e => console.error(`unlock warning: ${e.message}`));
await new Promise(r => setTimeout(r, 1000));

async function snap(dir: string, step: number, label: string): Promise<void> {
  const shot = await client.screenshot();
  await fs.writeFile(
    path.join(dir, `step-${step}-${label}.jpg`),
    shot.buffer,
  );
}

for (let t = 1; t <= TRIALS; t++) {
  const dir = path.join(ROOT, `trial-${t}`);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== Trial ${t}/${TRIALS} ===`);

  // step 0: baseline
  await snap(dir, 0, 'baseline');

  // step 1: scramble UP-RIGHT (keep cursor in visible iPad area).
  // Emit (+40, -40) then (+40, -40) — net (+80, -80) mickeys
  // = roughly (+100, -100) px assuming ratio 1.3.
  await client.mouseMoveRelative(40, -40);
  await new Promise(r => setTimeout(r, 60));
  await client.mouseMoveRelative(40, -40);
  await new Promise(r => setTimeout(r, 200));
  await snap(dir, 1, 'after-scramble');

  // step 2: ipadGoHome + settle
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 1200));
  await snap(dir, 2, 'after-home');

  // step 3: sustained wake — 40 × +3 mickeys (120 mickeys ≈ 156 px right).
  for (let i = 0; i < 40; i++) {
    await client.mouseMoveRelative(3, 0);
  }
  await new Promise(r => setTimeout(r, 100));
  await snap(dir, 3, 'after-wake');

  console.error(`  saved 4 frames in ${dir}`);
}

console.error(`\nDone. Frames in ${ROOT}/`);
