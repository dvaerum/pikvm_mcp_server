/**
 * Phase 243 hypothesis test: is the Phase 242 ~58 px Y-axis
 * difference cursor-visualization-lag (alg correct, visual stale)
 * or detection bias (alg wrong, visual correct)?
 *
 * Protocol: same N=5 targets as Phase 242, but the post-shot is
 * taken IMMEDIATELY after moveToPixel returns with NO settle
 * delay before the keepalive nudge. If alg and visual agree, the
 * Phase 242 difference was settle-delay-induced lag (alg correct).
 * If they still differ by ~58 px, detection has a real bias.
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

const ROOT = './data/phase243-viz-lag';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 243 viz-lag hypothesis test at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const targets = [
  { label: 'settings',  x: 905, y: 800 },
  { label: 'books',     x: 645, y: 815 },
  { label: 'reminders', x: 905, y: 555 },
];

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  try {
    const r = await moveToPixel(client, { x: t.x, y: t.y }, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    const c = r.finalDetectedPosition;

    // CRITICAL: no settle delay. snapshot IMMEDIATELY.
    const after = await client.screenshotKeepingCursorAlive();
    await fs.writeFile(`${ROOT}/t${i + 1}-${t.label}-immediate.jpg`, after.buffer);

    // For comparison, ALSO take a delayed shot.
    await new Promise(r => setTimeout(r, 500));
    const delayed = await client.screenshotKeepingCursorAlive();
    await fs.writeFile(`${ROOT}/t${i + 1}-${t.label}-delayed.jpg`, delayed.buffer);

    const residual = c ? Math.hypot(c.x - t.x, c.y - t.y) : null;
    console.error(
      `t${i + 1} ${t.label.padEnd(10)} target=(${t.x},${t.y})` +
      `  alg=${c ? `(${c.x},${c.y})` : 'null'}` +
      `  residual=${residual !== null ? residual.toFixed(0).padStart(4) : ' n/a'}`,
    );
  } catch (e: any) {
    console.error(`t${i + 1} ${t.label}: ERROR ${e.message?.split('\n')[0]?.slice(0, 80)}`);
  }
}

console.error('\nVisually compare each t*-immediate.jpg vs t*-delayed.jpg:');
console.error(' - If cursor visible at SAME position in both → viz-lag was wrong, alg has bias');
console.error(' - If cursor visible at DIFFERENT positions (immediate matches alg, delayed off) → viz-lag confirmed');
process.exit(0);
