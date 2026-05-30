/**
 * Phase 235 diagnostic: does skipping forceHomeViaSwipe between
 * trials change click rate? Hypothesis: the swipe pins cursor at
 * top edge each trial, which is the dominant failure mode.
 *
 * Protocol: unlock + forceHomeViaSwipe ONCE, then alternate
 * moveToPixel(905,800) [target] and moveToPixel(640,540) [center].
 * No re-swipe between trials.
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

const ROOT = './data/phase235-no-swipe';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 235: skip swipe between trials ===\n');

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const TARGET = { x: 905, y: 800 };
const CENTER = { x: 640, y: 540 };
const trials: { i: number; goal: string; residual: number | null; cursor: { x: number; y: number } | null; error?: string }[] = [];

const sequence: { goal: string; pt: typeof TARGET }[] = [
  { goal: 'target', pt: TARGET },
  { goal: 'center', pt: CENTER },
  { goal: 'target', pt: TARGET },
  { goal: 'center', pt: CENTER },
  { goal: 'target', pt: TARGET },
];

for (let i = 1; i <= sequence.length; i++) {
  const { goal, pt } = sequence[i - 1];
  try {
    const r = await moveToPixel(client, pt, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    const cursor = r.finalDetectedPosition;
    const residual = cursor ? Math.hypot(cursor.x - pt.x, cursor.y - pt.y) : null;
    trials.push({ i, goal, residual, cursor });
    const s = await client.screenshot();
    await fs.writeFile(`${ROOT}/t${i}-${goal}-after.jpg`, s.buffer);
    console.error(`t${i} (${goal} ${pt.x},${pt.y}): ${cursor ? `cursor=(${cursor.x},${cursor.y}) residual=${residual!.toFixed(1)}` : 'cursor=null'}`);
  } catch (e: any) {
    const msg = e.message?.split('\n')[0]?.slice(0, 120);
    trials.push({ i, goal, residual: null, cursor: null, error: msg });
    console.error(`t${i} (${goal}): ERROR ${msg}`);
  }
}

const targetTrials = trials.filter(t => t.goal === 'target');
const within35 = targetTrials.filter(t => t.residual !== null && t.residual <= 35).length;
const valid = targetTrials.filter(t => t.residual !== null).length;
console.error(`\n=== RESULT: target trials valid=${valid}/${targetTrials.length}, within 35 px=${within35}/${valid} ===`);
process.exit(0);
