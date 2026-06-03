import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const c = new PiKVMClient(cfg.pikvm);
const s = await c.getStreamerStatus();
console.log(JSON.stringify(s, null, 2));
