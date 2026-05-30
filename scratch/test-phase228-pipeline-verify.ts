/**
 * Phase 228: end-to-end verify the Phase 217/219/214 chain at v0.5.206.
 *
 *   1. Capture initial state (whatever the iPad is on)
 *   2. unlockIpad — should leave iPad on home (Phase 217 keys; Phase 219 no swipe-after-keys)
 *   3. ipadGoHome with forceHomeViaSwipe — idempotent if already home (Phase 214)
 *   4. Capture final state
 *
 * Honesty checkpoint: this is NOT a click bench — it just verifies
 * the iPad-state-machine path the recent doc honesty notes assume
 * actually works.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const ROOT = './data/phase228-verify';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const t0 = Date.now();
const s0 = await client.screenshot();
await fs.writeFile(`${ROOT}/00-initial.jpg`, s0.buffer);
console.error(`t=${Date.now() - t0}ms initial`);

console.error('Phase 217 unlockIpad (Esc+Enter+Space, swipe skipped if keys ran)');
const r1 = await unlockIpad(client);
await fs.writeFile(`${ROOT}/01-after-unlock.jpg`, r1.screenshot);
console.error(`t=${Date.now() - t0}ms after unlock: ${r1.message.split('.')[0]}`);

console.error('Phase 214 ipadGoHome forceHomeViaSwipe (idempotent if home)');
const r2 = await ipadGoHome(client, { forceHomeViaSwipe: true });
await fs.writeFile(`${ROOT}/02-after-home.jpg`, r2.screenshot);
console.error(`t=${Date.now() - t0}ms after home: ${r2.message.split('.')[0]}`);

process.exit(0);
