/**
 * Phase 248 N=20 A/B: same protocol as Phase 247 but with the
 * Phase 248 fpBlocklist enabled. Compare to Phase 247 baseline:
 * - Phase 247 v0.5.212: 5/20 = 25% within 35 px
 * - Phase 248 v0.5.213: this run
 *
 * Hypothesis: rejecting the 3 known FP locations (852,941),
 * (773,769), (782,958) within 50 px radius means moveToPixel falls
 * back to predicted-position when those FPs would have been picked.
 * If prediction is reasonably good, click rate may improve.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { KNOWN_HOME_SCREEN_FPS_1680x1050 } from '../src/pikvm/cursor-fp-blocklist.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase248-n20-blocklist';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 248 N=20 with fpBlocklist at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const TARGET = { x: 905, y: 800 };
const N = 20;
const trials: { i: number; alg: { x: number; y: number } | null; residual: number | null }[] = [];

for (let i = 1; i <= N; i++) {
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
      fpBlocklist: KNOWN_HOME_SCREEN_FPS_1680x1050,
    });
    const c = r.finalDetectedPosition;
    const residual = c ? Math.hypot(c.x - TARGET.x, c.y - TARGET.y) : null;
    trials.push({ i, alg: c, residual });
    console.error(
      `t${i.toString().padStart(2, '0')}: ` +
      `alg=${c ? `(${c.x},${c.y})` : 'null      '}` +
      `  residual=${residual !== null ? residual.toFixed(0).padStart(4) : ' n/a'}`,
    );
  } catch (e: any) {
    trials.push({ i, alg: null, residual: null });
    console.error(`t${i.toString().padStart(2, '0')}: ERROR`);
  }
}

await fs.writeFile(`${ROOT}/trials.json`, JSON.stringify(trials, null, 2));
const valid = trials.filter(t => t.residual !== null);
const nullCount = trials.length - valid.length;
const within35 = valid.filter(t => t.residual! <= 35).length;
const within75 = valid.filter(t => t.residual! <= 75).length;
const meanResidual = valid.length > 0
  ? valid.reduce((s, t) => s + t.residual!, 0) / valid.length
  : 0;

console.error('\n=== AGGREGATE (Phase 248, blocklist ON) ===');
console.error(`null detections:    ${nullCount}/${trials.length} (${(100 * nullCount / trials.length).toFixed(0)}%)`);
console.error(`within 35 px:       ${within35}/${trials.length} (${(100 * within35 / trials.length).toFixed(0)}%)`);
console.error(`within 75 px:       ${within75}/${trials.length} (${(100 * within75 / trials.length).toFixed(0)}%)`);
console.error(`mean residual:      ${meanResidual.toFixed(0)} px`);
console.error('\nPhase 247 baseline: within 35 px = 5/20 (25%), nulls = 2/20 (10%)');
process.exit(0);
