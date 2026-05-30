import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { promises as fs } from 'node:fs';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const jpg = await takeRawScreenshot(client);
const out = 'data/pointer-control-state-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.jpg';
await fs.writeFile(out, jpg);
console.log(out);
