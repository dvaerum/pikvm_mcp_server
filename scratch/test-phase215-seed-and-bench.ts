/**
 * Phase 215 — seed a fresh template, visually verify, then re-bench.
 *
 * After Phase 214 fixed `ipadGoHome` to reliably reach the home
 * screen (forceHomeViaSwipe), the cached template was found to be
 * contaminated (a thin white vertical line, not a cursor). Cache
 * has been cleared. Now:
 *   1. Reset to home screen via Phase 214's swipe
 *   2. Run seedCursorTemplate to get a fresh capture
 *   3. Save the seeded template as PNG so we can visually verify
 *      it actually shows a cursor
 *   4. Run a 10-trial bench to measure honest residuals on the
 *      home screen
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

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const ROOT = './data/phase215';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 215: seed fresh template + home-screen bench ===\n');

// 1. Unlock first (handles lock-screen state)
console.error('Step 1a: unlockIpad (Space + swipe)');
await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));

// 1b. Reach home screen reliably (in case we landed in app switcher / app)
console.error('Step 1b: ipadGoHome with forceHomeViaSwipe');
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));
const homeShot = await client.screenshot();
await fs.writeFile(`${ROOT}/01-home-screen.jpg`, homeShot.buffer);

// 2. Seed a fresh template
console.error('Step 2: seedCursorTemplate (wake-and-capture)');
const seed = await seedCursorTemplate(client, { settleMs: 80, emitDx: 80 });
console.error(`Seed result: ok=${seed.ok}, reason=${seed.reason ?? 'success'}`);

// 3. Verify what was captured
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Templates after seed: ${templates.length}`);
for (let i = 0; i < templates.length; i++) {
  const t = templates[i] as any;
  console.error(`  [${i}] ${t.width}×${t.height} hotspot=(${t.hotspotX},${t.hotspotY})`);
  if (t.rgb) {
    await sharp(t.rgb, { raw: { width: t.width, height: t.height, channels: 3 } })
      .png()
      .toFile(`${ROOT}/02-template-${i}.png`);
  }
}

if (templates.length === 0) {
  console.error('FAIL: no template seeded. Skipping bench (algorithm is detection-broken).');
  process.exit(1);
}

// 4. Re-run the 10-trial bench
console.error('\nStep 3: 10-trial bench at Settings (905, 800)');
const TARGET = { x: 905, y: 800 };
const trials: { i: number; cursor: { x: number; y: number } | null; residual: number | null }[] = [];

for (let i = 1; i <= 10; i++) {
  // Per-trial: ensure home screen via swipe (idempotent if already home)
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
    // Save post-trial screenshot
    const shot = await client.screenshot();
    await fs.writeFile(`${ROOT}/03-trial-${String(i).padStart(2, '0')}.jpg`, shot.buffer);
  } catch (e: any) {
    const msg = e.message?.split('\n')[0]?.slice(0, 100);
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
  // Within-tolerance count (≤ 35 px)
  const within35 = valid.filter(t => t.residual! <= 35).length;
  console.error(`Within 35 px of target: ${within35}/${valid.length}`);
}

await fs.writeFile(`${ROOT}/trials.json`, JSON.stringify(trials, null, 2));
process.exit(0);
