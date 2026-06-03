// End-to-end live verification of the lock/screen-state cycle:
//   1. Wake the iPad (sendKey Enter)
//   2. Streamer should report sourceOnline=true
//   3. Lock via Ctrl+Cmd+Q
//   4. Streamer should report sourceOnline=false within a couple seconds
//   5. Wake again with Enter — verify it returns to on=true
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const c = new PiKVMClient(cfg.pikvm);

async function pollOnline(want: boolean, label: string, timeoutMs = 10000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const s = await c.getStreamerStatus();
      const dt = Date.now() - t0;
      if (s.sourceOnline === want) {
        console.log(`  ✓ ${label}: sourceOnline=${want} after ${dt} ms`);
        return true;
      }
    } catch (e) {
      // ignore transient API errors during transitions
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const s = await c.getStreamerStatus();
  console.log(`  ✗ ${label}: timeout — last sourceOnline=${s.sourceOnline}`);
  return false;
}

console.log('[verify] step 1: wake the iPad with sendKey Enter');
await c.sendKey('Enter');
await new Promise((r) => setTimeout(r, 1500));
await c.sendKey('Enter');  // dismiss lock screen on iPadOS 26

console.log('[verify] step 2: poll for sourceOnline=true');
const wokeOK = await pollOnline(true, 'wake', 15000);
if (!wokeOK) {
  console.log('[verify] FAILED to wake — aborting');
  process.exit(1);
}

console.log('[verify] step 3: lock via Ctrl+Cmd+Q');
await c.sendShortcut(['ControlLeft', 'MetaLeft', 'KeyQ']);

console.log('[verify] step 4: poll for sourceOnline=false');
const lockedOK = await pollOnline(false, 'lock', 10000);

console.log('[verify] step 5: wake again with Enter');
await c.sendKey('Enter');
await new Promise((r) => setTimeout(r, 1500));
await c.sendKey('Enter');
const reWokeOK = await pollOnline(true, 'rewake', 15000);

console.log('');
console.log(`[verify] wake-from-stuck: ${wokeOK ? 'PASS' : 'FAIL'}`);
console.log(`[verify] lock via Ctrl+Cmd+Q: ${lockedOK ? 'PASS' : 'FAIL'}`);
console.log(`[verify] unlock via Enter+Enter: ${reWokeOK ? 'PASS' : 'FAIL'}`);
process.exit(wokeOK && lockedOK && reWokeOK ? 0 : 1);
