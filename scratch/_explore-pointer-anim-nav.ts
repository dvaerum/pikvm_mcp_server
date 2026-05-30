/**
 * Exploration: can we drive Settings → Accessibility → Touch → Pointer
 * Control → Pointer Animations via keyboard on iPadOS 26.1?
 *
 * Takes a screenshot before AND after each step so we can see what
 * actually happened. No automation built yet — this is reconnaissance.
 *
 * Each frame is saved to data/explore-pointer-anim-<ts>/NN-step-label.jpg.
 *
 * Step plan:
 *   0. capture baseline (current iPad state)
 *   1. dismiss any modal: Escape × 3, Enter × 1, Cmd+Period × 1
 *   2. open Settings via launchIpadApp
 *   3. try Tab then Down arrow to move into sidebar
 *   4. arrow-down N times looking for "Accessibility"
 *   5. (TBD based on what we observe in 1-4)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { launchIpadApp } from '../src/pikvm/ipad-unlock.js';
import { analyzeBrightness } from '../src/pikvm/brightness.js';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/explore-pointer-anim-${ts}`);

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

let step = 0;
async function shot(label: string): Promise<void> {
  const jpg = await takeRawScreenshot(client);
  const fname = `${String(step).padStart(2, '0')}-${label}.jpg`;
  await fs.writeFile(path.join(OUT, fname), jpg);
  const b = await analyzeBrightness(jpg, {});
  console.log(`  [${fname}] mean=${b.mean.toFixed(1)} stddev=${b.stddev.toFixed(1)} severity=${b.severity}`);
  step++;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`Output: ${OUT}\n`);

  console.log('Step 0: baseline');
  await shot('baseline');

  console.log('Step 1: try to dismiss any modal');
  for (let i = 0; i < 3; i++) await client.sendKey('Escape');
  await new Promise(r => setTimeout(r, 600));
  await shot('after-escape');

  await client.sendKey('Enter');
  await new Promise(r => setTimeout(r, 600));
  await shot('after-enter');

  await client.sendShortcut(['MetaLeft', 'Period']);
  await new Promise(r => setTimeout(r, 600));
  await shot('after-cmd-period');

  console.log('Step 2: open Settings via Spotlight');
  try {
    await launchIpadApp(client, 'Settings', {});
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.log(`  launchIpadApp threw: ${e}`);
  }
  await shot('after-launch-settings');

  console.log('Step 3: Tab to leave search field');
  await client.sendKey('Tab');
  await new Promise(r => setTimeout(r, 500));
  await shot('after-tab');

  console.log('Step 4: arrow-down through sidebar (10x), screenshot after each');
  for (let i = 0; i < 10; i++) {
    await client.sendKey('ArrowDown');
    await new Promise(r => setTimeout(r, 300));
    await shot(`after-arrowdown-${i + 1}`);
  }

  console.log(`\nDone. ${step} screenshots in ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
