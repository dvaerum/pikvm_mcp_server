import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase217-aggressive';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Variant A: tap to wake then swipe
console.error('Variant A: click+swipe');
await client.mouseClick('left');
await sleep(400);
await client.mouseClick('left', { state: true });
let rem = 1800;
while (rem > 0) { await client.mouseMoveRelative(0, -Math.min(30, rem)); rem -= 30; }
await client.mouseClick('left', { state: false });
await sleep(1500);
const sA = await client.screenshot();
await fs.writeFile(`${ROOT}/A-click-swipe.jpg`, sA.buffer);

// Variant B: Enter
console.error('Variant B: Enter');
await client.sendKey('Enter');
await sleep(800);
const sB = await client.screenshot();
await fs.writeFile(`${ROOT}/B-enter.jpg`, sB.buffer);

// Variant C: Globe-like via Cmd+Space (Spotlight could wake)
console.error('Variant C: Cmd+Space');
await client.sendShortcut(['MetaLeft', 'Space']);
await sleep(800);
const sC = await client.screenshot();
await fs.writeFile(`${ROOT}/C-cmd-space.jpg`, sC.buffer);

// Variant D: Escape then Enter
console.error('Variant D: Escape+Enter');
await client.sendKey('Escape');
await sleep(300);
await client.sendKey('Enter');
await sleep(800);
const sD = await client.screenshot();
await fs.writeFile(`${ROOT}/D-esc-enter.jpg`, sD.buffer);

console.error('Saved 4 unlock-variant screenshots');
process.exit(0);
