// Try keyboard shortcuts to wake/unstick the iPad. If keyboard input is
// also dead, the iPad is genuinely powered off (vs. just modal-stuck).
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { promises as fs } from 'node:fs';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

async function snap(label: string): Promise<void> {
  const shot = await client.screenshot();
  const out = `/tmp/ipad-wake-${label}.jpg`;
  await fs.writeFile(out, shot.buffer);
  console.log(`  saved ${out} (${shot.buffer.byteLength} bytes)`);
}

console.log('[wake] before:');
await snap('00-before');

console.log('[wake] step 1: Escape (dismiss modal if alive)');
await client.sendShortcut(['Escape']);
await new Promise((r) => setTimeout(r, 800));
await snap('01-after-escape');

console.log('[wake] step 2: Cmd+H (go home)');
await client.sendShortcut(['MetaLeft', 'KeyH']);
await new Promise((r) => setTimeout(r, 1200));
await snap('02-after-cmd-h');

console.log('[wake] step 3: Cmd+Space (Spotlight — keyboard-wake test)');
await client.sendShortcut(['MetaLeft', 'Space']);
await new Promise((r) => setTimeout(r, 1200));
await snap('03-after-cmd-space');

console.log('[wake] step 4: Escape (dismiss Spotlight)');
await client.sendShortcut(['Escape']);
await new Promise((r) => setTimeout(r, 600));
await snap('04-final');
