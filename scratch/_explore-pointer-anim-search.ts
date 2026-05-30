/**
 * Exploration #2: use the Settings search field to deep-link to Pointer
 * Animations. The first exploration showed the search field is focused
 * (or one Tab away) and arrow keys navigate the suggestion popover.
 *
 * If "Pointer Animations" is a search result, typing it and pressing
 * Enter should land directly on the Touch > Pointer Control screen.
 *
 * Steps:
 *   0. baseline
 *   1. launch Settings
 *   2. wait, screenshot (does search auto-focus on launch?)
 *   3. type "Pointer Animations"
 *   4. screenshot the suggestion list
 *   5. press Enter
 *   6. screenshot the landed pane
 *   7. try Tab a few times to see what receives focus on the pane
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { launchIpadApp } from '../src/pikvm/ipad-unlock.js';
import { analyzeBrightness } from '../src/pikvm/brightness.js';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/explore-pointer-anim-search-${ts}`);

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

  console.log('Step 1: launch Settings');
  try {
    await launchIpadApp(client, 'Settings', {});
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.log(`  launchIpadApp threw: ${e}`);
  }
  await shot('after-launch');

  console.log('Step 2: type "Pointer Animations" directly (search field may already be focused)');
  await client.type('Pointer Animations');
  await new Promise(r => setTimeout(r, 800));
  await shot('after-type');

  console.log('Step 3: press Enter to navigate to first result');
  await client.sendKey('Enter');
  await new Promise(r => setTimeout(r, 1500));
  await shot('after-enter');

  console.log('Step 4: Tab to see what receives focus on the destination pane');
  for (let i = 0; i < 6; i++) {
    await client.sendKey('Tab');
    await new Promise(r => setTimeout(r, 400));
    await shot(`after-tab-${i + 1}`);
  }

  console.log(`\nDone. ${step} screenshots in ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
