/**
 * Phase 216 verbose-discover diagnostic.
 *
 * Single-trial run of moveToPixel with forbidSlamFallback=true.
 * Captures screenshots at every step so a failure can be traced to
 * iPad state (lock screen, App Switcher, edge-pinned cursor) vs.
 * detection-layer issues.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase216-verbose';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 216 verbose discover (Phase 231 enhanced diagnostics) ===\n');

const s0 = await client.screenshot();
await fs.writeFile(`${ROOT}/00-initial.jpg`, s0.buffer);
console.error('00-initial.jpg captured');

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
const s1 = await client.screenshot();
await fs.writeFile(`${ROOT}/01-after-unlock.jpg`, s1.buffer);
console.error('01-after-unlock.jpg captured');

await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));
const s2 = await client.screenshot();
await fs.writeFile(`${ROOT}/02-after-force-home.jpg`, s2.buffer);
console.error('02-after-force-home.jpg captured');

try {
  const r = await moveToPixel(client, { x: 905, y: 800 }, {
    profile: profile ?? undefined,
    forbidSlamFallback: true,
    strategy: 'detect-then-move',
    verbose: true,
  });
  console.error(`SUCCESS: cursor=${JSON.stringify(r.finalDetectedPosition)}`);
  const s3 = await client.screenshot();
  await fs.writeFile(`${ROOT}/03-after-move.jpg`, s3.buffer);
} catch (e: any) {
  console.error(`FAIL: ${e.message?.split('\n')[0]?.slice(0, 150)}`);
  const s3 = await client.screenshot();
  await fs.writeFile(`${ROOT}/03-after-fail.jpg`, s3.buffer);
}
process.exit(0);
