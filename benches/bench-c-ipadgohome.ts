/**
 * (c) Where does the cursor land after `ipadGoHome`?
 *
 * Run ipadGoHome 10 times. Capture a screenshot after each. We then
 * visually identify cursor position to see if it's deterministic or
 * varied (and if varied, what the distribution is).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const TRIALS = process.argv[2] ? Number(process.argv[2]) : 10;
const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/c-ipadgohome';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

// Ensure iPad is unlocked at start so we're measuring the home-screen
// behavior, not lock-screen artifacts.
console.error('ensuring iPad unlocked...');
await unlockIpad(client).catch(e => console.error(`unlock warning: ${e.message}`));
await new Promise(r => setTimeout(r, 1000));

for (let t = 1; t <= TRIALS; t++) {
  console.error(`\n=== Trial ${t}/${TRIALS} ===`);

  // Move cursor somewhere arbitrary first so each trial doesn't
  // inherit the previous trial's cursor position.
  await client.mouseMoveRelative(40, 40);
  await new Promise(r => setTimeout(r, 100));
  await client.mouseMoveRelative(-80, 80);
  await new Promise(r => setTimeout(r, 100));

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 1200));  // settle
  // Wake-wiggle: small but rendering-visible (+15, -15) pair to make
  // cursor render before screenshot. (+1, -1) was too small to wake
  // it on this iPad. Net displacement zero, so position is preserved.
  await client.mouseMoveRelative(15, 0);
  await client.mouseMoveRelative(-15, 0);
  await new Promise(r => setTimeout(r, 200));
  const shot = await client.screenshot();
  const file = path.join(ROOT, `run-${String(t).padStart(2, '0')}.jpg`);
  await fs.writeFile(file, shot.buffer);
  console.error(`  saved ${file}`);
}

console.error(`\nDone. Frames in ${ROOT}/`);
