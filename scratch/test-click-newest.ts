/**
 * Live test of click_at using the NEWEST source code (v0.5.199),
 * not the deployed MCP binary. This bypasses the deployed-server
 * staleness so I can verify Phase 197 (requireWithinRadius) +
 * Phase 202 (cursor-keepalive) + Phase 32 (forbidSlamFallback) actually
 * work on this iPad.
 *
 * Click target: Settings icon at (905, 800).
 */

import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor, defaultMaxResidualPxFor } from '../src/pikvm/click-verify.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

console.error('=== Live test: click_at(905, 800) using NEWEST src/ code ===');
console.error(`Phase 197 requireWithinRadius: ON in move-to.ts`);
console.error(`Phase 202 cursor-keepalive: ON for detection screenshots`);
console.error(`Phase 32 forbidSlamFallback: TRUE for iPad (relative mode)`);
console.error(`Phase 210 unlock Space-first: tested separately, verified working`);
console.error('');

await ipadGoHome(client);
await new Promise(r => setTimeout(r, 800));

const r = await clickAtWithRetry(client, { x: 905, y: 800 }, {
  maxRetries: defaultMaxRetriesFor(false),  // iPad → 3
  maxResidualPx: defaultMaxResidualPxFor(false),  // iPad → 35
  requireVerifiedCursor: true,
  moveToOptions: {
    profile: profile ?? undefined,
    forbidSlamFallback: true,  // CRITICAL: avoid hot-corner re-lock
    strategy: 'detect-then-move',
  },
});

console.error(`\nResult: success=${r.success}, attempts=${r.attempts}`);
console.error(`Final cursor: ${r.finalMoveResult?.finalDetectedPosition ? `(${r.finalMoveResult.finalDetectedPosition.x}, ${r.finalMoveResult.finalDetectedPosition.y})` : 'null'}`);
if (r.failureSummary) console.error(`Failure: ${r.failureSummary}`);
console.error(`Last verification message: ${r.finalVerification?.message ?? 'n/a'}`);

const shot = await client.screenshot({ quality: 70 });
const fs = await import('fs');
await fs.promises.writeFile('/tmp/test-click-newest.jpg', shot.buffer);
console.error('\nPost-click screenshot at /tmp/test-click-newest.jpg');

process.exit(r.success ? 0 : 1);
