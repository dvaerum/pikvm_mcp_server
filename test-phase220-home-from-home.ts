import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase220-home';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const s0 = await client.screenshot();
await fs.writeFile(`${ROOT}/00-initial.jpg`, s0.buffer);
console.error('Initial');

const r = await ipadGoHome(client, { forceHomeViaSwipe: true });
await fs.writeFile(`${ROOT}/01-after.jpg`, r.screenshot);
console.error('After ipadGoHome forceHomeViaSwipe');
process.exit(0);
