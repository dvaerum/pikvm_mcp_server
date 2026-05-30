import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/dismiss-attempts';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 214: dismiss App Switcher attempts ===\n');

// Method 1: Cmd+UP (sometimes used as home gesture)
await client.sendShortcut(['MetaLeft', 'ArrowUp']);
await new Promise(r => setTimeout(r, 1000));
const s1 = await client.screenshot();
await fs.writeFile(`${ROOT}/01-cmd-up.jpg`, s1.buffer);
console.error('01 - Cmd+Up');

// Method 2: Cmd+Tab + release (cycle through apps)
await client.sendShortcut(['MetaLeft', 'Tab']);
await new Promise(r => setTimeout(r, 800));
const s2 = await client.screenshot();
await fs.writeFile(`${ROOT}/02-cmd-tab.jpg`, s2.buffer);
console.error('02 - Cmd+Tab');

// Method 3: Cmd+Q (quit?)
await client.sendShortcut(['MetaLeft', 'KeyQ']);
await new Promise(r => setTimeout(r, 500));
const s3 = await client.screenshot();
await fs.writeFile(`${ROOT}/03-cmd-q.jpg`, s3.buffer);
console.error('03 - Cmd+Q');

// Method 4: pikvm_ipad_unlock (Space/swipe up combo)
const { unlockIpad } = await import('../src/pikvm/ipad-unlock.js');
const r = await unlockIpad(client, { dragPx: 1500 });
console.error(`04 - unlockIpad: ${r.ok ? 'ok' : 'fail'} ${r.message}`);
await fs.writeFile(`${ROOT}/04-unlock.jpg`, r.screenshot);

process.exit(0);
