/**
 * Phase 216 — seed templates over multiple backgrounds, then bench.
 * Single masked template doesn't generalize across iPad backgrounds.
 * Seed 5 templates by moving the cursor to different home-screen
 * positions (over teal wallpaper, over an icon, over the dock, etc.)
 * and let the SET-aware matcher pick the best per query.
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

const ROOT = './data/phase216';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 216: multi-template seed + bench ===\n');

await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

// Helper: move cursor to a target position from current state
async function moveTo(target: { x: number; y: number }, label: string) {
  await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
  await new Promise(r => setTimeout(r, 300));
  let remX = Math.round(target.x / 1.3);
  let remY = Math.round(target.y / 1.3);
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(127, remX) : 0;
    const stepY = remY > 0 ? Math.min(127, remY) : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX -= stepX;
    remY -= stepY;
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 500));
  console.error(`Pre-positioned for ${label} (~${target.x},${target.y})`);
}

// Seed templates at 5 different home-screen regions
const positions = [
  { x: 500, y: 350, label: 'centre-teal' },
  { x: 905, y: 800, label: 'settings-icon-area' },
  { x: 645, y: 810, label: 'books-area' },
  { x: 1000, y: 420, label: 'right-edge' },
  { x: 760, y: 950, label: 'dock' },
];

for (const pos of positions) {
  // Reset to home screen (in case previous trial drifted)
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await new Promise(r => setTimeout(r, 800));
  await moveTo(pos, pos.label);
  const result = await seedCursorTemplate(client, { settleMs: 80, emitDx: 80 });
  console.error(`  seed ${pos.label}: ok=${result.ok} (${result.reason ?? 'n/a'})`);
}

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`\nTotal templates: ${templates.length}`);
for (let i = 0; i < templates.length; i++) {
  const t = templates[i] as any;
  if (t.rgb) {
    await sharp(t.rgb, { raw: { width: t.width, height: t.height, channels: 3 } })
      .resize(t.width * 10, t.height * 10, { kernel: 'nearest' })
      .png().toFile(`${ROOT}/seeded-${i}-10x.png`);
  }
}

// Now bench
console.error('\n=== 10-trial bench at Settings (905, 800) ===');
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
    console.error(`t${i}: ` + (cursor ? `cursor=(${cursor.x},${cursor.y}) residual=${residual!.toFixed(1)}` : 'cursor=null'));
  } catch (e: any) {
    console.error(`t${i}: ERROR ${e.message?.split('\n')[0]?.slice(0, 90)}`);
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
