// Probe candidate iPadOS lock-screen keyboard shortcuts and capture
// before/after screenshots so we can visually decide which one (if
// any) actually locks the screen.
//
// Candidates tried (in this order, with a screenshot before/after each):
//   1. Ctrl+Cmd+Q                (macOS Lock Screen — most likely)
//   2. Cmd+Option+Q              (alt; some keyboards bind this)
//   3. Ctrl+Cmd+Power            (Apple "force shutdown" precursor; long-press style)
//   4. Cmd+Eject                 (Mac shortcut; iPad keyboards rarely have Eject)
//   5. Shift+Cmd+Q               (macOS "Log Out" — sanity check that it does NOT lock)
//
// A successful "lock" candidate: post-shortcut screenshot shows
// either (a) a black/sleep frame, or (b) the lock-screen wallpaper
// with no app icons. A failing candidate: screen unchanged.
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { promises as fs } from 'node:fs';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

async function snap(label: string): Promise<void> {
  const shot = await client.screenshot();
  const out = `/tmp/lock-${label}.jpg`;
  await fs.writeFile(out, shot.buffer);
  console.log(`  ${out}  ${shot.buffer.byteLength} bytes`);
}

async function tryShortcut(label: string, keys: string[]): Promise<void> {
  console.log(`[lock] ${label}: ${keys.join('+')}`);
  await snap(`${label}-before`);
  await client.sendShortcut(keys);
  await new Promise((r) => setTimeout(r, 1500));
  await snap(`${label}-after`);
}

await tryShortcut('01-ctrl-cmd-q', ['ControlLeft', 'MetaLeft', 'KeyQ']);
await tryShortcut('02-cmd-opt-q',  ['MetaLeft', 'AltLeft', 'KeyQ']);
await tryShortcut('03-ctrl-cmd-power', ['ControlLeft', 'MetaLeft', 'Power']);
await tryShortcut('04-cmd-eject',  ['MetaLeft', 'Eject']);
await tryShortcut('05-shift-cmd-q', ['ShiftLeft', 'MetaLeft', 'KeyQ']);
console.log('done — review /tmp/lock-*.jpg to compare before/after pairs');
