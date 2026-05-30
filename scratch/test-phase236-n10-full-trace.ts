/**
 * Phase 236 N=10 evidence-gathering bench at v0.5.208.
 *
 * Phase 235 removed top-edge pinning. Remaining failure modes are
 * detection errors and X-axis overshoot. This bench:
 *   - unlocks + forceHomeViaSwipe ONCE (Phase 235 in effect)
 *   - 10 sequential moveToPixel trials to varied targets
 *   - between trials, no swipe — cursor stays where the previous
 *     trial left it, mimicking real-world repeated-click cadence
 *   - saves before-and-after screenshots per trial
 *   - reports algorithm-reported cursor + residual + flag for later
 *     visual cross-check against the saved frames
 *
 * Targets cover all four screen quadrants so single-direction biases
 * (e.g. always-overshoot-right) become visible.
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

const ROOT = './data/phase236-n10';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== Phase 236 N=10 evidence bench at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

// Cover quadrants and a few specific known iPad icons.
const targets: { label: string; x: number; y: number }[] = [
  { label: 'settings',     x: 905, y: 800 },
  { label: 'top-left-q',   x: 400, y: 250 },
  { label: 'top-right-q',  x: 1050, y: 250 },
  { label: 'center',       x: 720, y: 540 },
  { label: 'bot-left-q',   x: 400, y: 850 },
  { label: 'bot-right-q',  x: 1050, y: 850 },
  { label: 'books',        x: 645, y: 815 },
  { label: 'tv',           x: 775, y: 815 },
  { label: 'files',        x: 1035, y: 425 },
  { label: 'home-icon',    x: 645, y: 680 },
];

interface Trial {
  i: number;
  label: string;
  target: { x: number; y: number };
  algReported: { x: number; y: number } | null;
  residual: number | null;
  error?: string;
}
const trials: Trial[] = [];

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  const beforeShot = await client.screenshot();
  await fs.writeFile(`${ROOT}/t${i + 1}-${t.label}-before.jpg`, beforeShot.buffer);
  try {
    const r = await moveToPixel(client, { x: t.x, y: t.y }, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    const cursor = r.finalDetectedPosition;
    const residual = cursor ? Math.hypot(cursor.x - t.x, cursor.y - t.y) : null;
    trials.push({ i: i + 1, label: t.label, target: t, algReported: cursor, residual });
    const after = await client.screenshot();
    await fs.writeFile(`${ROOT}/t${i + 1}-${t.label}-after.jpg`, after.buffer);
    console.error(
      `t${i + 1} ${t.label.padEnd(13)} target=(${t.x},${t.y})` +
      `  alg=${cursor ? `(${cursor.x},${cursor.y})` : 'null      '}` +
      `  residual=${residual !== null ? residual.toFixed(0).padStart(4) : ' n/a'}`,
    );
  } catch (e: any) {
    const msg = e.message?.split('\n')[0]?.slice(0, 100);
    trials.push({ i: i + 1, label: t.label, target: t, algReported: null, residual: null, error: msg });
    console.error(`t${i + 1} ${t.label}: ERROR ${msg}`);
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
