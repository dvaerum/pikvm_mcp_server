/**
 * Phase 248 inspection: snapshot iPad home screen and document
 * what's at the recurring false-positive locations from Phase 247.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
await fs.mkdir('./data/phase248-fp-inspection', { recursive: true });

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const shot = await client.screenshotKeepingCursorAlive();
await fs.writeFile('./data/phase248-fp-inspection/home-screen.jpg', shot.buffer);
console.error(`saved ${shot.screenshotWidth}x${shot.screenshotHeight} screenshot`);
console.error('Phase 247 FP locations to check:');
console.error('  (852, 941) — appeared 3× in N=20');
console.error('  (773, 769) cluster — appeared 3× in N=20');
console.error('  (782, 958) — appeared 2× in N=20');
process.exit(0);
