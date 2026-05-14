import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';

async function main() {
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);
  const shot = await client.screenshot();
  console.log(`reachable=true frame=${shot.width}x${shot.height} bytes=${shot.buffer.length}`);
}
main().catch((e) => {
  console.error(`reachable=false reason=${e.message}`);
  process.exit(1);
});
