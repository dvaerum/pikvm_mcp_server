import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
await client.sendKey('Escape');
await new Promise((r) => setTimeout(r, 500));
await client.sendKey('Escape');
await new Promise((r) => setTimeout(r, 500));
const shot = await client.screenshot();
await fs.writeFile('./data/d2-post-escape.jpg', shot.buffer);
console.log('saved data/d2-post-escape.jpg');
