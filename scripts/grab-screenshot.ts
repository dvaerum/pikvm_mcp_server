import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { promises as fs } from 'node:fs';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const shot = await client.screenshot();
const outPath = process.argv[2] ?? '/tmp/ipad-current.jpg';
await fs.writeFile(outPath, shot.buffer);
console.log(`saved ${shot.buffer.byteLength} bytes to ${outPath}`);
