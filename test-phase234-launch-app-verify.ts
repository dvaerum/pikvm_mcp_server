import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { launchIpadApp } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase234-launch';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 234: verify launchIpadApp at v${VERSION} ===`);
const r = await launchIpadApp(client, 'Settings', { verbose: true });
await fs.writeFile(`${ROOT}/01-after-launch.jpg`, r.screenshot);
console.error(`Result: ${r.message.split('.')[0]}`);
process.exit(0);
