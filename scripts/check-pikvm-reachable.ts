import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
try {
  const shot = await client.screenshot();
  console.log('PiKVM ok, screenshot size:', shot.buffer.length, 'bytes');
} catch (e: unknown) {
  console.error('PiKVM failed:', (e as Error).message);
  process.exit(1);
}
