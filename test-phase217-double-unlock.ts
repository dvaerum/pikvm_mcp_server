import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase217-double';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('Step 1: first unlock');
const r1 = await unlockIpad(client, { dragPx: 1500 });
await fs.writeFile(`${ROOT}/01-unlock1.jpg`, r1.screenshot);
await new Promise(r => setTimeout(r, 800));

console.error('Step 2: second unlock');
const r2 = await unlockIpad(client, { dragPx: 1500 });
await fs.writeFile(`${ROOT}/02-unlock2.jpg`, r2.screenshot);
await new Promise(r => setTimeout(r, 800));

console.error('Step 3: forceHomeViaSwipe');
const r3 = await ipadGoHome(client, { forceHomeViaSwipe: true });
await fs.writeFile(`${ROOT}/03-home.jpg`, r3.screenshot);

process.exit(0);
