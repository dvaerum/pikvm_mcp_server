/**
 * Navigate to Settings → Accessibility → Pointer Control and capture
 * screenshots of each settings screen we want to document.
 *
 * Uses the new orange-cursor v9-bordered ML detector path (90% click
 * rate per the 2026-05-28 bench) to drive the navigation.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { launchIpadApp } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const OUT = path.resolve(process.cwd(), 'docs/screenshots/ipad-settings');
await fs.mkdir(OUT, { recursive: true });

async function shot(name: string): Promise<string> {
  const jpg = await takeRawScreenshot(client);
  const p = path.join(OUT, `${name}.jpg`);
  await fs.writeFile(p, jpg);
  console.log(`  → ${p}`);
  return p;
}

console.log('1. Opening Settings via Spotlight…');
await launchIpadApp(client, 'Settings', { unlockFirst: false });
await new Promise(r => setTimeout(r, 1500));
await shot('01-settings-landing');

// Settings opens to whatever pane was last shown — likely Accessibility
// from earlier in the session. Capture as-is, then navigate to Pointer
// Control. The Accessibility sidebar item is around (725, 494); inside
// Accessibility, the Pointer Control row is on the right pane somewhere
// near bottom of Accessories section.

console.log('2. Searching for Pointer Control via in-Settings search…');
// Tab focuses the search field (per exploration #1)
await client.sendKey('Tab');
await new Promise(r => setTimeout(r, 600));
// Type the partial query that Phase 195 confirms returns deep-link results
await client.type('Pointer Control');
await new Promise(r => setTimeout(r, 1000));
await shot('02-search-results');

console.log('3. Arrow-down + Enter to pick first result…');
await client.sendKey('ArrowDown');
await new Promise(r => setTimeout(r, 400));
await client.sendKey('Enter');
await new Promise(r => setTimeout(r, 1500));
await shot('03-pointer-control');

console.log(`\nScreenshots saved to ${OUT}`);
