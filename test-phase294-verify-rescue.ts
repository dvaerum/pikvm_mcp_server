/**
 * Phase 294: confirm Phase 293 bright-rescue actually fires in
 * production, and analyze diagnostic detail per pass on both
 * near and far targets.
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

const ROOT = `./data/phase294-verify-rescue/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 294 verify rescue at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGETS = [
  { x: 905, y: 800, label: 'near (Settings)' },
  { x: 757, y: 832, label: 'far (between Books/TV)' },
];
const N = 5;

for (const target of TARGETS) {
  console.error(`\n>>> Target ${target.label}: (${target.x}, ${target.y}) <<<`);
  for (let i = 1; i <= N; i++) {
    console.error(`\n--- Trial ${i}/${N} ---`);
    await ipadGoHome(client, { forceHomeViaSwipe: true });
    await sleep(1200);
    try {
      const r = await moveToPixel(client, target, {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
      });
      const detected = r.finalDetectedPosition;
      const residual = r.finalResidualPx;
      console.error(`  final: ${detected ? `(${detected.x},${detected.y})` : 'null'} residual=${residual !== null ? residual.toFixed(0) + 'px' : 'n/a'} bail=${r.bailedToBestPass}`);
      console.error(`  passes (${r.diagnostics.length}):`);
      for (const d of r.diagnostics) {
        const at = d.detectedAt ? `(${d.detectedAt.x},${d.detectedAt.y})` : 'null';
        const reason = (d.reason ?? 'ok').slice(0, 60);
        console.error(`    p${d.pass} ${d.mode.padEnd(9)} ${at.padEnd(15)} r=${d.residualPx.toFixed(0).padStart(3)}px reason=${reason}`);
      }
    } catch (e) {
      console.error(`  threw: ${(e as Error).message.slice(0, 100)}`);
    }
  }
}
process.exit(0);
