/**
 * Phase 199 — production-defaults click bench.
 *
 * The existing bench-click-extensive.ts measures algorithm INTERNALS
 * (cursor detection accuracy, retry behavior, residuals). It runs with
 * `requireVerifiedCursor: false` and no `maxResidualPx`, which bypasses
 * the safety gates that production MCP applies by default.
 *
 * This bench measures USER EXPERIENCE — what someone calling
 * `pikvm_mouse_click_at` via MCP actually sees. With production defaults:
 * - `requireVerifiedCursor: true` (skip click if cursor not verified)
 * - `maxResidualPx: 35` (skip click if cursor > 35px from target)
 * - same retry budget (3 retries on iPad)
 *
 * Three success classes per trial:
 *   - HIT — click registered, screen changed at the target
 *   - SKIP — algorithm refused to click (safety gate fired)
 *   - MISS — clicked but missed (snap-zone or genuinely wrong position)
 *
 * SKIP is much better than MISS for users: they get a clear error and
 * can retry / use Spotlight. MISS silently lands on adjacent UI.
 *
 * Usage: npx tsx bench-click-production.ts [trials=5]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor, defaultMaxResidualPxFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false);
const MAX_RESIDUAL_PX = defaultMaxResidualPxFor(/*absolute=*/false);

const TRIALS = Number(process.argv[2] ?? 5);
const ROOT = './data/click-bench-prod';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
console.error(`Production-defaults bench: ${TRIALS} trials × 4 targets`);
console.error(`maxRetries=${MAX_RETRIES}, maxResidualPx=${MAX_RESIDUAL_PX}, requireVerifiedCursor=true`);

// 2026-05-28: re-measured against the current iPad home-screen layout
// after the bench started producing MISSes (cursor landing in icon
// gaps). The previous coords (905,800) etc. were stale — they hit
// empty wallpaper between icons. Current icon centers:
const TARGETS = [
  { name: 'Settings',  slug: 'settings',  x: 1027, y: 837 },
  { name: 'Books',     slug: 'books',     x: 757,  y: 837 },
  { name: 'AppStore',  slug: 'appstore',  x: 1027, y: 702 },
  { name: 'Files',     slug: 'files',     x: 1162, y: 435 },
];

interface ResultClass {
  hit: number;
  skip: number;
  miss: number;
}

const results: Record<string, ResultClass> = {};

for (const t of TARGETS) {
  results[t.slug] = { hit: 0, skip: 0, miss: 0 };
  const dir = path.join(ROOT, t.slug);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== ${t.name} (${t.x}, ${t.y}) — ${TRIALS} trials ===`);

  for (let i = 1; i <= TRIALS; i++) {
    await ipadGoHome(client);
    await new Promise(r => setTimeout(r, 800));

    const r = await clickAtWithRetry(client, { x: t.x, y: t.y }, {
      maxRetries: MAX_RETRIES,
      moveToOptions: {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
      },
      // Production defaults below — match what MCP calls do.
      maxResidualPx: MAX_RESIDUAL_PX,
      requireVerifiedCursor: true,
      verifyOptions: {
        region: { x: t.x, y: t.y, halfWidth: 50, halfHeight: 50 },
        minChangedFraction: 0.05,
      },
    });

    let cls: 'hit' | 'skip' | 'miss';
    if (r.success) cls = 'hit';
    else if (r.attemptHistory.every(a => a.skippedClickReason)) cls = 'skip';
    else cls = 'miss';

    results[t.slug][cls]++;

    const shot = await client.screenshot({ quality: 75 });
    const file = path.join(dir, `${String(i).padStart(2, '0')}-${cls}.jpg`);
    await fs.writeFile(file, shot.buffer);
    console.error(`  ${i}/${TRIALS} ${cls.toUpperCase()} attempts=${r.attempts} → ${file}`);
  }
}

console.error('\n========== SUMMARY (PRODUCTION DEFAULTS) ==========\n');
console.error('Target      |  hit  | skip | miss | n');
console.error('------------+-------+------+------+----');
let totalHit = 0, totalSkip = 0, totalMiss = 0, totalN = 0;
for (const t of TARGETS) {
  const c = results[t.slug];
  const n = c.hit + c.skip + c.miss;
  totalHit += c.hit;
  totalSkip += c.skip;
  totalMiss += c.miss;
  totalN += n;
  const fmt = (v: number) => `${v}/${n}`;
  console.error(
    `${t.name.padEnd(11)} | ${fmt(c.hit).padStart(5)} | ${fmt(c.skip).padStart(4)} | ${fmt(c.miss).padStart(4)} | ${n}`,
  );
}
console.error('------------+-------+------+------+----');
console.error(
  `${'TOTAL'.padEnd(11)} | ${`${totalHit}/${totalN}`.padStart(5)} | ${`${totalSkip}/${totalN}`.padStart(4)} | ${`${totalMiss}/${totalN}`.padStart(4)} | ${totalN}`,
);
console.error(`\nHit rate: ${((100 * totalHit) / totalN).toFixed(0)}%`);
console.error(`Skip rate (safety gate fired): ${((100 * totalSkip) / totalN).toFixed(0)}%`);
console.error(`Miss rate (clicked but wrong): ${((100 * totalMiss) / totalN).toFixed(0)}%`);
console.error('\nNote: SKIPs are graceful failures (user gets a clear error).');
console.error('MISSes are silent failures (might land on adjacent UI).');

process.exit(0);
