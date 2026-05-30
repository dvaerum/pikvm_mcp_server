/**
 * Hypothesis: iPadOS treats a single discrete mouseMoveRelative emit
 * differently from a continuous stream of small reports (like a real
 * USB/Bluetooth mouse sends at ~125 Hz). My prior wake tests sent
 * ONE emit of N mickeys; this test sends MANY small emits in rapid
 * succession (closer to a real mouse's HID stream).
 *
 * Burst patterns tested:
 *   burst-10x1  : 10 × (+1, 0) emits no delay  =  10 mickeys total
 *   burst-30x1  : 30 × (+1, 0)                =  30 mickeys total
 *   burst-60x1  : 60 × (+1, 0)                =  60 mickeys total
 *   burst-30x2  : 30 × (+2, 0)                =  60 mickeys total
 *   burst-30x3  : 30 × (+3, 0)                =  90 mickeys total
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const TRIALS_PER_PATTERN = 3;
const PATTERNS: { name: string; count: number; mag: number }[] = [
  { name: 'burst-10x1', count: 10, mag: 1 },
  { name: 'burst-30x1', count: 30, mag: 1 },
  { name: 'burst-60x1', count: 60, mag: 1 },
  { name: 'burst-30x2', count: 30, mag: 2 },
  { name: 'burst-30x3', count: 30, mag: 3 },
];

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/cursor-wake-burst';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('ensuring iPad unlocked...');
await unlockIpad(client).catch(e => console.error(`unlock warning: ${e.message}`));
await new Promise(r => setTimeout(r, 1000));

for (const p of PATTERNS) {
  const dir = path.join(ROOT, p.name);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== ${p.name} (${p.count} × (+${p.mag}, 0) emits, no delay) ===`);
  for (let t = 1; t <= TRIALS_PER_PATTERN; t++) {
    // Scramble (so each trial doesn't inherit previous state).
    await client.mouseMoveRelative(40, 40);
    await new Promise(r => setTimeout(r, 60));
    await client.mouseMoveRelative(-80, 80);
    await new Promise(r => setTimeout(r, 60));

    await ipadGoHome(client);
    await new Promise(r => setTimeout(r, 1200));

    // Burst emit: many tiny moves, no delay. Tries to mimic real-
    // mouse HID stream where many reports arrive continuously.
    for (let i = 0; i < p.count; i++) {
      await client.mouseMoveRelative(p.mag, 0);
    }
    // Immediate screenshot (no settle). Want to catch the cursor
    // rendered before any fade.
    const shot = await client.screenshot();
    const file = path.join(dir, `run-${String(t).padStart(2, '0')}.jpg`);
    await fs.writeFile(file, shot.buffer);
    console.error(`  trial ${t}/${TRIALS_PER_PATTERN}: saved ${file}`);
  }
}

console.error(`\nFrames in ${ROOT}/`);
