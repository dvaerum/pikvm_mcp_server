/**
 * Phase 250 diagnostic: does the score-margin gate fire on the
 * iPad home screen?
 *
 * NOT a click-rate validation (per Phase 248 lesson, that needs
 * N>=100 alternating randomized). Just counts how often the
 * AMBIGUOUS condition triggers across N=10 trials at v0.5.215.
 *
 * If gate fires 0/10: hypothesis dead (FPs don't cluster at
 * similar scores after all). If gate fires 5+/10: hypothesis is
 * plausible and worth a real A/B. Between: uncertain.
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

const ROOT = './data/phase250-gate-fires';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

// Capture stderr for AMBIGUOUS counting.
let ambiguousCount = 0;
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = args.map((a) => String(a)).join(' ');
  if (msg.includes('AMBIGUOUS')) ambiguousCount++;
  originalConsoleError(...args);
};

originalConsoleError(`=== Phase 250 gate-fires diagnostic at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

const TARGET = { x: 905, y: 800 };
const N = 10;
const trials: { i: number; residual: number | null }[] = [];

for (let i = 1; i <= N; i++) {
  const ambBefore = ambiguousCount;
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
      scoreMargin: 0.03,
      verbose: true,
    });
    const c = r.finalDetectedPosition;
    const residual = c ? Math.hypot(c.x - TARGET.x, c.y - TARGET.y) : null;
    trials.push({ i, residual });
    const fired = ambiguousCount - ambBefore;
    originalConsoleError(
      `t${i.toString().padStart(2, '0')}: ` +
      `alg=${c ? `(${c.x},${c.y})` : 'null'}  ` +
      `residual=${residual !== null ? residual.toFixed(0).padStart(4) : ' n/a'}  ` +
      `gate-fired=${fired}x`,
    );
  } catch (_e) {
    trials.push({ i, residual: null });
  }
}

const valid = trials.filter(t => t.residual !== null);
const within35 = valid.filter(t => t.residual! <= 35).length;

originalConsoleError('\n=== RESULT ===');
originalConsoleError(`AMBIGUOUS gate fired: ${ambiguousCount} times across ${N} trials`);
originalConsoleError(`within 35 px: ${within35}/${trials.length}`);
originalConsoleError(`nulls: ${trials.length - valid.length}/${trials.length}`);
process.exit(0);
