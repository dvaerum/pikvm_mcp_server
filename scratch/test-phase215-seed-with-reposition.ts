/**
 * Phase 215b — pre-position cursor to centre before seeding template.
 * Cursor was edge-pinned at right side, so wake-emit had no effect on
 * pixel motion (per-call cap saturated). Slam to top-left first, then
 * emit a known displacement to land roughly mid-screen, then seed.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { seedCursorTemplate } from '../src/pikvm/seed-template.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { slamToCorner } from '../src/pikvm/ballistics.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase215b';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 215b: pre-position + seed + bench ===\n');

// 1. Reach home screen
await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

// 2. Pre-position cursor to ~centre of iPad screen
// Slam to top-left to anchor (cursor will be at (0,0) of iPad letterbox).
console.error('Slam to top-left to anchor cursor');
await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
await new Promise(r => setTimeout(r, 300));

// Move to centre. iPad in portrait at this resolution is ~840x1050.
// At ~1.3 px/mickey, ~640 mickey-px right + ~400 down. Emit in chunks.
console.error('Move toward centre via chunked emits');
let remX = 500, remY = 350;
while (remX > 0 || remY > 0) {
  const stepX = remX > 0 ? Math.min(127, remX) : 0;
  const stepY = remY > 0 ? Math.min(127, remY) : 0;
  await client.mouseMoveRelative(stepX, stepY);
  remX -= stepX;
  remY -= stepY;
  await new Promise(r => setTimeout(r, 30));
}
await new Promise(r => setTimeout(r, 500));

// Save the screenshot to confirm cursor is in centre
const centreShot = await client.screenshot();
await fs.writeFile(`${ROOT}/01-cursor-centred.jpg`, centreShot.buffer);

// 3. Seed
console.error('seedCursorTemplate after centring');
const seed = await seedCursorTemplate(client, { settleMs: 80, emitDx: 80 });
console.error(`Seed result: ok=${seed.ok}, reason=${seed.reason ?? 'success'}`);

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Templates after seed: ${templates.length}`);
for (let i = 0; i < templates.length; i++) {
  const t = templates[i] as any;
  console.error(`  [${i}] ${t.width}×${t.height}`);
  if (t.rgb) {
    await sharp(t.rgb, { raw: { width: t.width, height: t.height, channels: 3 } })
      .resize(t.width * 10, t.height * 10, { kernel: 'nearest' })
      .png().toFile(`${ROOT}/02-template-${i}-10x.png`);
  }
}

if (templates.length === 0) {
  console.error('FAIL: no template seeded.');
  process.exit(1);
}

// 4. Bench
console.error('\n10-trial bench at Settings (905, 800)');
const TARGET = { x: 905, y: 800 };
const trials: { i: number; cursor: { x: number; y: number } | null; residual: number | null }[] = [];

for (let i = 1; i <= 10; i++) {
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await new Promise(r => setTimeout(r, 800));
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    const cursor = r.finalDetectedPosition;
    const residual = cursor ? Math.hypot(cursor.x - TARGET.x, cursor.y - TARGET.y) : null;
    trials.push({ i, cursor, residual });
    console.error(
      `t${i}: ` +
      (cursor ? `cursor=(${cursor.x},${cursor.y}) residual=${residual!.toFixed(1)}` : 'cursor=null'),
    );
  } catch (e: any) {
    const msg = e.message?.split('\n')[0]?.slice(0, 90);
    console.error(`t${i}: ERROR ${msg}`);
    trials.push({ i, cursor: null, residual: null });
  }
}

const valid = trials.filter(t => t.cursor !== null);
console.error('\n=== AGGREGATE ===');
console.error(`Valid trials: ${valid.length}/10`);
if (valid.length > 0) {
  const residuals = valid.map(t => t.residual!);
  const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  console.error(`residual: mean=${m(residuals).toFixed(1)} min=${Math.min(...residuals).toFixed(1)} max=${Math.max(...residuals).toFixed(1)}`);
  const within35 = valid.filter(t => t.residual! <= 35).length;
  console.error(`Within 35 px of target: ${within35}/${valid.length}`);
}

await fs.writeFile(`${ROOT}/trials.json`, JSON.stringify(trials, null, 2));
process.exit(0);
