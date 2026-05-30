import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/state-check';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 214: iPad state check ===\n');

// 1. Capture current state (as-is)
const s1 = await client.screenshot();
await fs.writeFile(`${ROOT}/01-current.jpg`, s1.buffer);
console.error('01-current: as-is');

// 2. Try Cmd+H (may not exit app switcher cleanly)
await client.sendShortcut(['MetaLeft', 'KeyH']);
await new Promise(r => setTimeout(r, 800));
const s2 = await client.screenshot();
await fs.writeFile(`${ROOT}/02-after-cmd-h.jpg`, s2.buffer);
console.error('02-after-cmd-h');

// 3. Try Escape
await client.sendKey('Escape');
await new Promise(r => setTimeout(r, 500));
const s3 = await client.screenshot();
await fs.writeFile(`${ROOT}/03-after-escape.jpg`, s3.buffer);
console.error('03-after-escape');

// 4. Try Cmd+H again (after escape)
await client.sendShortcut(['MetaLeft', 'KeyH']);
await new Promise(r => setTimeout(r, 800));
const s4 = await client.screenshot();
await fs.writeFile(`${ROOT}/04-after-second-cmd-h.jpg`, s4.buffer);
console.error('04-after-second-cmd-h');

console.error('Saved 4 screenshots to', ROOT);
process.exit(0);
