import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

// Cursor was at ~(925, 700) per last screenshot. Continue button is at
// (960, 740). Emit ~(35, 40) then click.
await client.mouseMoveRelative(35, 50);
await new Promise(r => setTimeout(r, 400));
await client.mouseClick('left');
console.log('clicked');
