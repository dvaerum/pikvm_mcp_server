/**
 * Use clickAtWithRetry (the 90% hit-rate path proven in
 * bench-click-production) to navigate Settings → Accessibility →
 * Pointer Control → Colour and capture each panel.
 *
 * Pre-requisite: cursor color is Orange (per the user-side config) so
 * the v9-bordered model can find it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { clickAtWithRetry, defaultMaxRetriesFor, defaultMaxResidualPxFor } from '../src/pikvm/click-verify.js';
import { ipadGoHome, launchIpadApp } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const OUT = path.resolve(process.cwd(), 'docs/screenshots/ipad-settings');
await fs.mkdir(OUT, { recursive: true });

async function shot(label: string): Promise<void> {
  await new Promise(r => setTimeout(r, 800));
  const jpg = await takeRawScreenshot(client);
  await fs.writeFile(path.join(OUT, `${label}.jpg`), jpg);
  console.log(`  → ${label}.jpg`);
}

async function clickTarget(x: number, y: number, label: string): Promise<void> {
  console.log(`click ${label} at (${x},${y})…`);
  const r = await clickAtWithRetry(client, { x, y }, {
    maxRetries: defaultMaxRetriesFor(false),
    moveToOptions: {
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    },
    maxResidualPx: 60,  // looser than the 35 default — rows are ~70 px tall, 60 px is still well within the correct row
    requireVerifiedCursor: true,
    verifyOptions: {
      region: { x, y, halfWidth: 80, halfHeight: 80 },
      minChangedFraction: 0.02,
    },
  });
  console.log(`  ${r.success ? 'HIT' : 'SKIP/MISS'} attempts=${r.attempts}`);
  if (!r.success) {
    throw new Error(`Failed to click ${label}: ${r.attemptHistory[r.attemptHistory.length - 1]?.skippedClickReason ?? 'no reason'}`);
  }
}

// Start: home screen (assume).
await ipadGoHome(client, {});
await new Promise(r => setTimeout(r, 1000));
await shot('00-home');

// Step 1: launch Settings
console.log('Launching Settings via Spotlight…');
await launchIpadApp(client, 'Settings', { unlockFirst: false });
await new Promise(r => setTimeout(r, 1500));
await shot('01-settings-landing-clean');

// Step 2: click Accessibility in sidebar (~725, 494)
// (skip if already showing Accessibility from earlier session state)
// Bias Y up by 40 px to compensate for the overshoot pattern seen in
// the first attempt (clicked Apple Pencil instead of Accessibility).
await clickTarget(725, 455, 'Accessibility (sidebar)');
await shot('02-accessibility-pane-fresh');

// Step 3: click Pointer Control row in right pane (~1090, 807 after bias)
await clickTarget(1090, 807, 'Pointer Control row');
await shot('03-pointer-control-panel');

// Step 4: click Colour row in Pointer Control (~1090, 240 after bias)
await clickTarget(1090, 240, 'Colour row');
await shot('04-colour-picker');

console.log(`\nAll screens captured to ${OUT}`);
