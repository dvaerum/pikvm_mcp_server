import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const TARGET = { x: 905, y: 800 };

console.error('=== Phase 212 verbose: 3 trials ===\n');
for (let i = 1; i <= 3; i++) {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
      verbose: true,
    });
    console.error(`\n--- t${i}: cursor=${JSON.stringify(r.finalDetectedPosition)} ---\n`);
  } catch (e: any) {
    console.error(`\n--- t${i}: ERROR ${e.message?.split('\n')[0]} ---\n`);
  }
}
process.exit(0);
