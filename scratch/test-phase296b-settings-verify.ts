/**
 * Phase 296b: verify the Phase 294 "95%" claim — is the algorithm
 * actually finding the cursor, or the Settings label text?
 *
 * Phase 296 trial 1 showed algorithm claimed cursor at (652, 840)
 * r=32 (Books label text position) when the real cursor was at
 * (845, 813) — 200 px away. The "hit" was an FP on app-icon text.
 *
 * This run: 5 trials on Settings target. For each:
 *   - Save post-frame
 *   - Visually verify where the cursor REALLY is
 *   - Compare to algorithm's reported position
 *
 * If algorithm consistently reports positions ~30 px from target
 * but cursor is elsewhere, the 95% Phase 294 result is illusory.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = `./data/phase296b-settings/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 296b Settings honesty check at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 905, y: 800 };
const N = 5;

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  let r: Awaited<ReturnType<typeof moveToPixel>> | null = null;
  try {
    r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
  } catch {/* */}

  await sleep(500);
  const post = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}-post.jpg`, post.buffer);

  const algo = r?.finalDetectedPosition;
  console.error(`  algo claims: ${algo ? `(${algo.x},${algo.y}) r=${r?.finalResidualPx?.toFixed(0)}px` : 'null'}`);
  console.error(`  passes (${r?.diagnostics.length}):`);
  if (r) {
    for (const d of r.diagnostics) {
      console.error(`    p${d.pass} ${d.mode.padEnd(9)} at=${d.detectedAt ? `(${d.detectedAt.x},${d.detectedAt.y})` : 'null'} r=${d.residualPx.toFixed(0)}px`);
    }
  }
}
console.error(`\nNow visually inspect each ${ROOT}/t*-post.jpg to verify cursor's REAL position.`);
process.exit(0);
