import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';

const name = process.argv[2];
if (!name) { console.error('usage: _save-current-as.ts <filename-without-ext>'); process.exit(1); }
const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const jpg = await takeRawScreenshot(client);
await fs.writeFile(`docs/screenshots/ipad-settings/${name}.jpg`, jpg);
console.log(`saved ${name}.jpg`);
