import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase217-state';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

// Initial state
const s1 = await client.screenshot();
await fs.writeFile(`${ROOT}/01-initial.jpg`, s1.buffer);

// Unlock
await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
const s2 = await client.screenshot();
await fs.writeFile(`${ROOT}/02-after-unlock.jpg`, s2.buffer);

// Force home
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));
const s3 = await client.screenshot();
await fs.writeFile(`${ROOT}/03-after-home.jpg`, s3.buffer);

console.error('Saved 3 state screenshots');
process.exit(0);
