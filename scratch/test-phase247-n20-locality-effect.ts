/**
 * Phase 247 N=20 bench at v0.5.212: measure click rate post-Phase-244
 * locality gate against a single fixed target. Phase 244 N=10 showed
 * confident-wrong → null shift; this larger N tests whether end-to-end
 * "I clicked the right place" rate changed.
 *
 * Protocol: unlock + forceHomeViaSwipe ONCE, then 20 sequential
 * moveToPixel calls to (905, 800). No re-swipe between trials —
 * cursor stays where the previous trial left it (consistent with
 * how a real caller's repeated clicks would behave).
 *
 * Records per-trial residual (Euclidean from target) and a hit/null
 * classification. Aggregates: hit rate within {35, 50, 75} px,
 * null rate, mean residual on valid trials.
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

const ROOT = './data/phase247-n20-locality';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 247 N=20 locality-effect bench at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const TARGET = { x: 905, y: 800 };
const N = 20;

interface Trial {
  i: number;
  alg: { x: number; y: number } | null;
  residual: number | null;
  error?: string;
}
const trials: Trial[] = [];

for (let i = 1; i <= N; i++) {
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
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
    const msg = e.message?.split('\n')[0]?.slice(0, 100);
    trials.push({ i, alg: null, residual: null, error: msg });
    console.error(`t${i.toString().padStart(2, '0')}: ERROR ${msg}`);
  }
}

await fs.writeFile(`${ROOT}/trials.json`, JSON.stringify(trials, null, 2));

const valid = trials.filter(t => t.residual !== null);
const nullCount = trials.length - valid.length;
const within35 = valid.filter(t => t.residual! <= 35).length;
const within50 = valid.filter(t => t.residual! <= 50).length;
const within75 = valid.filter(t => t.residual! <= 75).length;
const meanResidual = valid.length > 0
  ? valid.reduce((s, t) => s + t.residual!, 0) / valid.length
  : 0;

console.error('\n=== AGGREGATE ===');
console.error(`N=${trials.length}`);
console.error(`null detections:    ${nullCount}/${trials.length} (${(100 * nullCount / trials.length).toFixed(0)}%)`);
console.error(`within 35 px:       ${within35}/${trials.length} (${(100 * within35 / trials.length).toFixed(0)}%)`);
console.error(`within 50 px:       ${within50}/${trials.length} (${(100 * within50 / trials.length).toFixed(0)}%)`);
console.error(`within 75 px:       ${within75}/${trials.length} (${(100 * within75 / trials.length).toFixed(0)}%)`);
console.error(`mean residual (valid): ${meanResidual.toFixed(0)} px`);
process.exit(0);
