// Wake the iPad from sleep (any key on attached keyboard wakes it), then
// send Enter to dismiss the lock screen (Phase 217: Enter unlocks
// iPadOS 26 with no passcode), then screenshot. Used to recover from
// a Ctrl+Cmd+Q lock and confirm the unlock path works.
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { promises as fs } from 'node:fs';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

console.log('[wake] sending a tap key to wake the screen…');
await client.sendKey('Enter');
await new Promise((r) => setTimeout(r, 2000));

console.log('[wake] sending Enter again to dismiss lock screen (Phase 217)…');
await client.sendKey('Enter');
await new Promise((r) => setTimeout(r, 1500));

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    const shot = await client.screenshot();
    const out = '/tmp/wake-confirm.jpg';
    await fs.writeFile(out, shot.buffer);
    console.log(`[wake] success on attempt ${attempt}: ${out}  ${shot.buffer.byteLength} bytes`);
    process.exit(0);
  } catch (e) {
    console.error(`[wake] attempt ${attempt}: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
console.error('[wake] FAILED — streamer still unavailable after 5 attempts');
process.exit(1);
