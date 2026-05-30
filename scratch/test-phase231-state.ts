import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
await fs.mkdir('./data/phase231', { recursive: true });

const s = await client.screenshot();
await fs.writeFile('./data/phase231/state.jpg', s.buffer);
console.error('Saved state');
