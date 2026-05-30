/**
 * Exploration #4: validate the Phase 195 keyboard path end-to-end.
 *
 * Steps:
 *   1. Cmd+H to home
 *   2. Open Settings via launchIpadApp
 *   3. Tab to focus search (exploration #1 showed this opens the popover)
 *   4. Per-key type "Accessibility" slowly (Phase 195 warned bulk type
 *      breaks via autocorrect)
 *   5. Down-arrow to highlight first result
 *   6. Enter to navigate
 *   7. Screenshot the landed pane
 *   8. Try Tab N times to see what receives focus inside the pane
 *   9. Try ArrowDown N times to see if focus moves
 *  10. If we end up on a row with "Touch", press Enter and repeat
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { launchIpadApp, ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { analyzeBrightness } from '../src/pikvm/brightness.js';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/explore-pointer-anim-fka-${ts}`);

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

// Per-key send — Phase 195 says bulk type breaks via autocorrect.
async function slowType(text: string): Promise<void> {
  for (const ch of text) {
    if (ch === ' ') {
      await client.sendKey('Space');
    } else if (ch.toUpperCase() !== ch.toLowerCase() && ch === ch.toUpperCase()) {
      await client.sendShortcut(['ShiftLeft', `Key${ch}`]);
    } else {
      await client.sendKey(`Key${ch.toUpperCase()}`);
    }
    await new Promise(r => setTimeout(r, 60));
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`Output: ${OUT}`);

  console.log('Step 1: go home');
  try { await ipadGoHome(client, {}); } catch (e) { console.log(`  ipadGoHome err: ${e}`); }
  await new Promise(r => setTimeout(r, 1000));
  await shot('01-home');

  console.log('Step 2: open Settings');
  try {
    await launchIpadApp(client, 'Settings', {});
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.log(`  launchIpadApp err: ${e}`);
  }
  await shot('02-settings');

  console.log('Step 3: Tab to focus search field');
  await client.sendKey('Tab');
  await new Promise(r => setTimeout(r, 500));
  await shot('03-tabbed');

  console.log('Step 4: slow-type "Accessibility"');
  await slowType('Accessibility');
  await new Promise(r => setTimeout(r, 800));
  await shot('04-typed-accessibility');

  console.log('Step 5: ArrowDown (should highlight first result)');
  await client.sendKey('ArrowDown');
  await new Promise(r => setTimeout(r, 400));
  await shot('05-arrowdown-1');

  console.log('Step 6: Enter (navigate)');
  await client.sendKey('Enter');
  await new Promise(r => setTimeout(r, 1500));
  await shot('06-enter');

  console.log('Step 7-12: Tab 6× to see what receives focus in pane');
  for (let i = 0; i < 6; i++) {
    await client.sendKey('Tab');
    await new Promise(r => setTimeout(r, 400));
    await shot(`07-tab-${i + 1}`);
  }

  console.log('Step 13-22: ArrowDown 10× to see if focus moves within pane');
  for (let i = 0; i < 10; i++) {
    await client.sendKey('ArrowDown');
    await new Promise(r => setTimeout(r, 300));
    await shot(`13-arrdn-${i + 1}`);
  }

  console.log(`\nDone. ${step} screenshots in ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
