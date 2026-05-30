/**
 * Phase 196 — single-target Files bench to test if wiping cursor-templates
 * fixes the deterministic 245px residual seen in bench-click-extensive.ts.
 *
 * If the residual changes (especially if it varies across trials rather
 * than being identical to many decimal places), then stale region-
 * contaminated templates were the cause. If the residual stays at
 * exactly 245.15... px, the bug is somewhere else.
 *
 * Usage: npx tsx bench-files-only.ts [trials=3]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor } from '../src/pikvm/click-verify.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false);

const TRIALS = Number(process.argv[2] ?? 3);
const ROOT = './data/files-only';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`Files-only bench: ${TRIALS} trials, target (1035, 420)`);
console.error(`Templates dir cleared at start of run.`);

for (let i = 1; i <= TRIALS; i++) {
  console.error(`\n--- trial ${i}/${TRIALS} ---`);
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));

  const r = await clickAtWithRetry(client, { x: 1035, y: 420 }, {
    maxRetries: MAX_RETRIES,
    moveToOptions: {
      profile: profile ?? undefined,
      strategy: 'detect-then-move',
    },
  });

  const cur = r.finalMoveResult?.finalDetectedPosition;
  const residual = cur ? Math.hypot(cur.x - 1035, cur.y - 420) : null;
  console.error(`  result: ${r.success ? 'HIT' : 'MISS'}`);
  console.error(`  attempts: ${r.attempts}`);
  console.error(`  cursor detected at: ${cur ? `(${cur.x}, ${cur.y})` : 'null'}`);
  console.error(`  residual: ${residual?.toFixed(6) ?? 'null'} px`);

  await new Promise(r => setTimeout(r, 200));
  const shot = await client.screenshot({ quality: 75 });
  const filepath = path.join(ROOT, `trial-${String(i).padStart(2, '0')}-${r.success ? 'hit' : 'miss'}.jpg`);
  await fs.writeFile(filepath, shot.buffer);
  console.error(`  saved ${filepath}`);
}

console.error('\nDone. Check data/files-only/ for screenshots.');
process.exit(0);
