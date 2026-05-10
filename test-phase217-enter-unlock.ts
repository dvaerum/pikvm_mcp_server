import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase217-enter';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Try locking the iPad first via the side-button-equivalent: cmd+ctrl+q (sleep)
// Actually the iPad will auto-lock. Let's just take a screenshot of current state.
const s0 = await client.screenshot();
await fs.writeFile(`${ROOT}/00-current.jpg`, s0.buffer);
console.error('Captured current state');

// Try Enter alone
console.error('Sending Enter key');
await client.sendKey('Enter');
await sleep(800);
const s1 = await client.screenshot();
await fs.writeFile(`${ROOT}/01-after-enter.jpg`, s1.buffer);
console.error('Saved screenshot');
process.exit(0);
