import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { unlockIpad } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase219-unlock';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

// Initial state
const s0 = await client.screenshot();
await fs.writeFile(`${ROOT}/00-initial.jpg`, s0.buffer);
console.error('Captured initial state');

// Run unlockIpad with default settings (Phase 217: Esc+Enter+Space + swipe)
const r = await unlockIpad(client);
await fs.writeFile(`${ROOT}/01-after-unlock.jpg`, r.screenshot);
console.error('Saved post-unlock screenshot');
process.exit(0);
