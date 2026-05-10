/**
 * Phase 231 N=3 verification: confirm the moveToPixel lift is
 * reproducible after the defensive Esc+Enter fix.
 *
 * This is NOT a click-rate bench — just 3 trials to verify the fix
 * works consistently. Per-trial: unlockIpad → forceHomeViaSwipe →
 * moveToPixel(905, 800). Records residual + final cursor position.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase231-n3';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 231 N=3 verification at v${VERSION} ===\n`);

const TARGET = { x: 905, y: 800 };
const trials: { i: number; residual: number | null; cursor: { x: number; y: number } | null; error?: string }[] = [];

for (let i = 1; i <= 3; i++) {
  await unlockIpad(client, { dragPx: 1500 });
  await new Promise(r => setTimeout(r, 800));
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await new Promise(r => setTimeout(r, 800));

  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    const cursor = r.finalDetectedPosition;
    const residual = cursor ? Math.hypot(cursor.x - TARGET.x, cursor.y - TARGET.y) : null;
    trials.push({ i, residual, cursor });
    const s = await client.screenshot();
    await fs.writeFile(`${ROOT}/t${i}-after-move.jpg`, s.buffer);
    console.error(`t${i}: ${cursor ? `cursor=(${cursor.x},${cursor.y}) residual=${residual!.toFixed(1)}` : 'cursor=null (algorithm reported success but didn\'t record final position)'}`);
  } catch (e: any) {
    const msg = e.message?.split('\n')[0]?.slice(0, 120);
    trials.push({ i, residual: null, cursor: null, error: msg });
    console.error(`t${i}: ERROR ${msg}`);
  }
}

const valid = trials.filter(t => t.residual !== null);
const within35 = valid.filter(t => t.residual! <= 35).length;
console.error(`\n=== RESULT: valid=${valid.length}/3, within 35 px=${within35}/${valid.length} ===`);
process.exit(0);
