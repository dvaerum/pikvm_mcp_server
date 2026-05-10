import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

console.error('=== Phase 216 verbose: single trial discover ===\n');
await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

try {
  const r = await moveToPixel(client, { x: 905, y: 800 }, {
    profile: profile ?? undefined,
    forbidSlamFallback: true,
    strategy: 'detect-then-move',
    verbose: true,
  });
  console.error(`SUCCESS: cursor=${JSON.stringify(r.finalDetectedPosition)}`);
} catch (e: any) {
  console.error(`FAIL: ${e.message?.split('\n')[0]?.slice(0, 150)}`);
}
process.exit(0);
