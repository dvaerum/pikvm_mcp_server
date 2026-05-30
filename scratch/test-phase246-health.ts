/**
 * Phase 246 follow-up: quick health-check via tsx to confirm
 * resolution / streamer / HID profile are all healthy at v0.5.212.
 */
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
console.error(`=== Health check at v${VERSION} ===`);
const res = await client.getResolution(true);
console.error(`Resolution: ${res.width}x${res.height}`);
const streamer = await client.getStreamerStatus();
console.error(`Streamer source online: ${streamer.sourceOnline}`);
const hid = await client.getHidProfile();
console.error(`HID online: ${hid.online}, mouseAbsolute: ${hid.mouseAbsolute}`);
process.exit(0);
