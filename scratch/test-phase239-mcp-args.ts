/**
 * Phase 239 live-verify: MCP-style call with the newly-exposed
 * tryKeyPressFirst + swipeOnKeyPressFailure options actually
 * forwards them through to the library function.
 *
 * Tests by passing `swipeOnKeyPressFailure: false` on an already-
 * unlocked iPad. Library semantics (counter-intuitive name): when
 * `false`, the legacy always-swipe path is forced, so the swipe
 * runs even after keys. If args forward correctly, the swipe
 * re-locks the iPad (Phase 219 documented hazard).
 *
 * PASS criteria: lock screen visible in 03-final-state.jpg →
 *   swipe ran → arg was forwarded.
 * FAIL criteria: Settings still visible → swipe was suppressed →
 *   arg was NOT forwarded.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { unlockIpad, ipadGoHome, launchIpadApp } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase239-mcp-args';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 239 MCP arg forwarding live-verify ===\n');

// Step 1: open Settings so iPad is in a foreground app
console.error('Step 1: launching Settings to put iPad in a known app state');
await launchIpadApp(client, 'Settings');
await new Promise(r => setTimeout(r, 1500));
const before = await client.screenshot();
await fs.writeFile(`${ROOT}/01-after-launch.jpg`, before.buffer);

// Step 2: unlock with swipeOnKeyPressFailure=false. Iff arg
// forwarding works, the swipe is suppressed and Settings stays
// foregrounded (a stray swipe would close it).
console.error('Step 2: unlockIpad({ swipeOnKeyPressFailure: false })');
const r = await unlockIpad(client, { swipeOnKeyPressFailure: false });
await fs.writeFile(`${ROOT}/02-after-unlock.jpg`, r.screenshot);
console.error(`  message: ${r.message.slice(0, 100)}...`);

// Step 3: Settings should still be foreground (the new MCP arg
// stopped the swipe that would close it)
console.error('Step 3: take diagnostic screenshot for visual verification');
const after = await client.screenshot();
await fs.writeFile(`${ROOT}/03-final-state.jpg`, after.buffer);

console.error('\nDone. Visually inspect 03-final-state.jpg:');
console.error(' - PASS: Settings still foreground → arg forwarded, swipe suppressed');
console.error(' - FAIL: home screen visible → arg ignored, swipe ran and closed Settings');
process.exit(0);
