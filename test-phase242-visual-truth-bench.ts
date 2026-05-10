/**
 * Phase 242 visual-truth bench at v0.5.210.
 *
 * Phase 236 found the algorithm-reported residuals can't be cross-
 * checked visually because iPadOS fades the cursor between
 * moveToPixel's last internal probe and our post-screenshot. Fix:
 * before each post-shot, emit a ±1 px wake nudge so the cursor is
 * visible. Then we can manually compare alg-reported position vs
 * visible truth and identify whether failures are detection error
 * vs actual mispositioning.
 *
 * N=5 covering 5 distinct targets to surface different failure
 * modes.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase242-visual-truth';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 242 visual-truth bench at v0.5.210 ===\n');

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const targets = [
  { label: 'settings',    x: 905, y: 800 },
  { label: 'books',       x: 645, y: 815 },
  { label: 'tv',          x: 775, y: 815 },
  { label: 'files',       x: 1035, y: 425 },
  { label: 'reminders',   x: 905, y: 555 },
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
    const residual = c ? Math.hypot(c.x - t.x, c.y - t.y) : null;

    // Phase 242: use the production-proven keepalive screenshot which
    // emits ±1 px wake nudge IMMEDIATELY before the snapshot so the
    // cursor stays visible (Phase 202).
    const after = await client.screenshotKeepingCursorAlive();
    await fs.writeFile(`${ROOT}/t${i + 1}-${t.label}.jpg`, after.buffer);
    console.error(
      `t${i + 1} ${t.label.padEnd(10)} target=(${t.x},${t.y})` +
      `  alg=${c ? `(${c.x},${c.y})` : 'null      '}` +
      `  residual=${residual !== null ? residual.toFixed(0).padStart(4) : ' n/a'}`,
    );
  } catch (e: any) {
    console.error(`t${i + 1} ${t.label}: ERROR ${e.message?.split('\n')[0]?.slice(0, 80)}`);
  }
}
console.error('\nVisually inspect each t*-*.jpg: cursor should be visible thanks to wake nudge.');
process.exit(0);
