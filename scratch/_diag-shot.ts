import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { promises as fs } from 'node:fs';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const jpg = await takeRawScreenshot(client);
await fs.writeFile('/tmp/diag-current.jpg', jpg);
console.log('saved /tmp/diag-current.jpg', jpg.length, 'bytes');
