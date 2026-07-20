import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
const c = new PiKVMClient(loadConfig().pikvm);
const shot = await c.screenshot();
await fs.writeFile('scratch/health.jpg', shot.buffer);
console.log(`wrote scratch/health.jpg ${shot.buffer.length}b ${shot.screenshotWidth ?? shot.width}x${shot.screenshotHeight ?? shot.height}`);
