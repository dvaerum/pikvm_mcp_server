import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

await client.mouseMoveRelative(-20, -35);
await new Promise(r => setTimeout(r, 400));
await client.mouseClick('left');
console.log('clicked');
