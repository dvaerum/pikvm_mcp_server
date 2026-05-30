/**
 * Phase 237 A/B: same N=10 protocol as Phase 236, but with
 * maxCorrectionPasses bumped from default 5 → 10. If the dominant
 * failure mode is "ran out of correction passes," this should
 * lift hit rate without code changes — informing whether a
 * permanent default bump is justified.
 */
import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase237-n10-bumped';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 237: maxCorrectionPasses=10 (bumped from 5) ===\n');

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const targets = [
  { label: 'settings',    x: 905,  y: 800 },
  { label: 'top-left-q',  x: 400,  y: 250 },
  { label: 'top-right-q', x: 1050, y: 250 },
  { label: 'center',      x: 720,  y: 540 },
  { label: 'bot-left-q',  x: 400,  y: 850 },
  { label: 'bot-right-q', x: 1050, y: 850 },
  { label: 'books',       x: 645,  y: 815 },
  { label: 'tv',          x: 775,  y: 815 },
  { label: 'files',       x: 1035, y: 425 },
  { label: 'home-icon',   x: 645,  y: 680 },
];

const trials: any[] = [];
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  try {
    const r = await moveToPixel(client, { x: t.x, y: t.y }, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
      maxCorrectionPasses: 10, // bumped from default 5
    });
    const c = r.finalDetectedPosition;
    const residual = c ? Math.hypot(c.x - t.x, c.y - t.y) : null;
    trials.push({ i: i + 1, label: t.label, target: t, alg: c, residual });
    console.error(
      `t${i + 1} ${t.label.padEnd(13)} target=(${t.x},${t.y})` +
      `  alg=${c ? `(${c.x},${c.y})` : 'null      '}` +
      `  residual=${residual !== null ? residual.toFixed(0).padStart(4) : ' n/a'}`,
    );
  } catch (e: any) {
    trials.push({ i: i + 1, label: t.label, target: t, alg: null, residual: null, error: e.message?.slice(0, 100) });
    console.error(`t${i + 1} ${t.label}: ERROR`);
  }
}

await fs.writeFile(`${ROOT}/trials.json`, JSON.stringify(trials, null, 2));
const valid = trials.filter(t => t.residual !== null);
const within35 = valid.filter(t => t.residual! <= 35).length;
const within75 = valid.filter(t => t.residual! <= 75).length;
console.error(
  `\n=== RESULT: valid=${valid.length}/${targets.length}` +
  `, within 35 px=${within35}/${valid.length}` +
  `, within 75 px=${within75}/${valid.length} ===`,
);
process.exit(0);
