/**
 * Phase 194-I — programmatically navigate iPad Settings to verify
 * (and toggle) Pointer Animations using the LATEST source code via
 * tsx, bypassing the deployed MCP server's slam-fallback bug.
 *
 * Strategy:
 *   1. Reset to home via Cmd+H.
 *   2. Open Settings via Spotlight (Cmd+Space + type + Enter).
 *   3. Use clickAtWithRetry with forbidSlamFallback=true to click
 *      sidebar items (large row targets — even with iPadOS snap-
 *      zone on, big rows are reliable).
 *   4. Capture screenshots at each step so the session is auditable.
 *
 * If clickAtWithRetry fails (forbidSlamFallback throws), we abort
 * cleanly without re-locking the iPad. Better than the deployed
 * MCP's slam-and-pray.
 *
 * NOTE: this is a one-shot helper, not a polished skill. The
 * "real" skill needs more robust handling of variable iPadOS
 * versions and Settings layouts.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry } from './src/pikvm/click-verify.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';
import { loadProfile } from './src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/pointer-toggle';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

async function snap(name: string): Promise<void> {
  await new Promise(r => setTimeout(r, 400));
  const shot = await client.screenshot({ quality: 80 });
  const file = path.join(ROOT, `${name}.jpg`);
  await fs.writeFile(file, shot.buffer);
  console.error(`saved ${file}`);
}

async function pressKey(key: string, modifiers: string[] = []): Promise<void> {
  if (modifiers.length > 0) {
    await client.sendShortcut([...modifiers, key]);
  } else {
    await client.sendKey(key);
  }
}

async function typeText(text: string): Promise<void> {
  await client.type(text);
}

async function clickAt(x: number, y: number, label: string): Promise<boolean> {
  console.error(`\n--- click ${label} at (${x}, ${y}) ---`);
  try {
    const r = await clickAtWithRetry(client, { x, y }, {
      maxRetries: 2,
      moveToOptions: {
        profile: profile ?? undefined,
        forbidSlamFallback: true,  // <-- key safety guard
        strategy: 'detect-then-move',
      },
      minBrightness: 0,
      requireVerifiedCursor: false,
      preClickSettleMs: 200,
    });
    console.error(`  result: ${r.success ? 'HIT' : 'MISS'} attempts=${r.attempts}`);
    if (r.finalMoveResult.finalDetectedPosition) {
      const cur = r.finalMoveResult.finalDetectedPosition;
      console.error(`  cursor at (${cur.x}, ${cur.y})`);
    }
    return r.success;
  } catch (e) {
    console.error(`  THREW: ${(e as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.error('=== Phase 194-I: programmatic toggle of Pointer Animations ===\n');

  // Step 1: home
  console.error('Step 1: ipadGoHome');
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 600));
  await snap('01-home');

  // Step 2: open Settings via Spotlight
  console.error('\nStep 2: open Settings via Spotlight');
  await pressKey('Space', ['MetaLeft']);
  await new Promise(r => setTimeout(r, 600));
  await snap('02-spotlight');
  await typeText('Settings');
  await new Promise(r => setTimeout(r, 400));
  await snap('03-spotlight-typed');
  await pressKey('Enter');
  await new Promise(r => setTimeout(r, 1500));
  await snap('04-settings-open');

  // Step 3: dismiss the search field if it's focused
  await pressKey('Escape');
  await new Promise(r => setTimeout(r, 300));
  await snap('05-settings-no-search');

  // Step 4: click Accessibility in the sidebar.
  // From earlier screenshots: "Accessibility" row is at ~(607, 666).
  const accessibilityClicked = await clickAt(607, 666, 'Accessibility');
  await snap('06-after-accessibility-click');
  if (!accessibilityClicked) {
    console.error('\n⚠ Accessibility click did not register. Aborting.');
    return;
  }

  // Step 5: from the Accessibility detail pane (right side), look for
  // "Touch" row (iPadOS 17+) or "Pointer Control" directly. We don't
  // know the exact y-coord without inspecting; let the user check
  // the saved frames.
  console.error('\n*** Manual inspection point ***');
  console.error('Inspect data/pointer-toggle/06-after-accessibility-click.jpg');
  console.error('to confirm Accessibility opened, then identify the y-coord');
  console.error('of "Touch" or "Pointer Control" in the right pane.');
  console.error('Re-run this script with the next click coordinate hard-coded.\n');

  process.exit(0);
}

await main();
