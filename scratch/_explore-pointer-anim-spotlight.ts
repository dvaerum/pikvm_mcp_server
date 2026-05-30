/**
 * Exploration #3: deep-link to Pointer Control / Pointer Animations via
 * Spotlight (Cmd+Space). The in-Settings search said "No Results for
 * Pointer Animations" — apparently it only indexes section names, not
 * toggle names. Spotlight may index more.
 *
 * Try a few queries to see what Spotlight returns:
 *   - "Pointer Animations"  (exact toggle)
 *   - "Pointer Control"     (parent section)
 *   - "Pointer"             (broadest)
 *
 * Steps per query:
 *   - go home (Cmd+H + dismiss app switcher etc.)
 *   - Cmd+Space → Spotlight
 *   - type query
 *   - screenshot the Spotlight results
 *   - Enter
 *   - screenshot the landed pane
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { analyzeBrightness } from '../src/pikvm/brightness.js';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/explore-pointer-anim-spotlight-${ts}`);

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

async function tryQuery(query: string, queryTag: string): Promise<void> {
  console.log(`\n--- Spotlight query: "${query}" ---`);

  console.log('  go home');
  try { await ipadGoHome(client, {}); } catch (e) { console.log(`  ipadGoHome err: ${e}`); }
  await new Promise(r => setTimeout(r, 600));
  await shot(`${queryTag}-home`);

  console.log('  Cmd+Space');
  await client.sendShortcut(['MetaLeft', 'Space']);
  await new Promise(r => setTimeout(r, 700));
  await shot(`${queryTag}-spotlight`);

  console.log(`  type "${query}"`);
  await client.type(query);
  await new Promise(r => setTimeout(r, 1000));
  await shot(`${queryTag}-typed`);

  console.log('  Enter');
  await client.sendKey('Enter');
  await new Promise(r => setTimeout(r, 1500));
  await shot(`${queryTag}-after-enter`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`Output: ${OUT}`);

  await shot('start');

  await tryQuery('Pointer Animations', 'A');
  await tryQuery('Pointer Control', 'B');
  await tryQuery('Pointer', 'C');

  console.log(`\nDone. ${step} screenshots in ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
