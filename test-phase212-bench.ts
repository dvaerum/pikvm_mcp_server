/**
 * Phase 212 — does stationary-cluster rejection lift the click rate?
 *
 * Same 10-trial protocol as test-residual-pattern.ts but on the
 * Phase 212 build. Expect: when motion-diff returns one of the
 * three deterministic clusters (Phase 211), the algorithm now
 * falls through to template-match instead of locking onto it.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const TARGET = { x: 905, y: 800 };
const TRIALS = 10;

console.error(`=== Phase 212: cluster-rejection bench, target=(${TARGET.x},${TARGET.y}), n=${TRIALS} ===\n`);

interface Trial {
  trial: number;
  cursor: { x: number; y: number } | null;
  residual: number | null;
  dx: number | null;
  dy: number | null;
}
const trials: Trial[] = [];

for (let i = 1; i <= TRIALS; i++) {
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await new Promise(r => setTimeout(r, 800));

  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    const cursor = r.finalDetectedPosition;
    const dx = cursor ? cursor.x - TARGET.x : null;
    const dy = cursor ? cursor.y - TARGET.y : null;
    const residual = cursor ? Math.hypot(dx!, dy!) : null;
    trials.push({ trial: i, cursor, residual, dx, dy });
    console.error(
      `t${i}: ` +
      (cursor ? `cursor=(${cursor.x},${cursor.y}) dx=${dx} dy=${dy} residual=${residual!.toFixed(1)}` : 'cursor=null'),
    );
  } catch (e: any) {
    console.error(`t${i}: ERROR ${e.message?.split('\n')[0]?.slice(0, 100)}`);
    trials.push({ trial: i, cursor: null, residual: null, dx: null, dy: null });
  }
}

const valid = trials.filter(t => t.cursor !== null);
const residuals = valid.map(t => t.residual!);
console.error('\n=== AGGREGATE ===');
console.error(`Valid trials: ${valid.length}/${TRIALS}`);
if (valid.length > 0) {
  const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  console.error(`residual: mean=${m(residuals).toFixed(1)} min=${Math.min(...residuals).toFixed(1)} max=${Math.max(...residuals).toFixed(1)}`);

  // Cluster check: how many trials returned the Phase 211 deterministic clusters?
  const clusters = [
    { x: 949, y: 795, name: 'A' },
    { x: 970, y: 771, name: 'B' },
    { x: 972, y: 772, name: 'C' },
  ];
  for (const c of clusters) {
    const matches = valid.filter(t => Math.hypot(t.cursor!.x - c.x, t.cursor!.y - c.y) < 5);
    console.error(`Cluster ${c.name} at (${c.x},${c.y}): ${matches.length}/${valid.length} hits`);
  }
}

await fs.writeFile('/tmp/phase212-bench.json', JSON.stringify(trials, null, 2));
process.exit(0);
