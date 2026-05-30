/**
 * click_at v2: architecturally different click path.
 *
 *   1. ipadGoHome + settle
 *   2. wake-pulse (+20, -20) — small, leaves cursor at same position
 *      but rendered.
 *   3. detect cursor via v5 (full-frame, has presence head). Retry
 *      with bigger wake if presence < 0.5.
 *   4. compute delta = target - detected_cursor in PIXELS
 *   5. emit (delta · 1.3) as ONE big chunk (clamped per-axis to 127).
 *      Single emit gets iPadOS's higher px/mickey regime (~1.3 vs
 *      0.22 for many small bursts).
 *   6. Click immediately, no closed-loop verification.
 *
 * Compare against v1 baseline on Books/Settings/Files.
 *
 *   PIKVM_ML_V5_MODEL=ml/cursor-v5.onnx npx tsx bench-clickv2.ts 10
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { findCursorPresenceV5 } from '../src/pikvm/cursor-ml-detect.js';
import { verifyClickByDiff } from '../src/pikvm/click-verify.js';

const TRIALS = process.argv[2] ? Number(process.argv[2]) : 10;
const STRICT_THRESHOLD = 0.10;  // 10% changed pixels = real app open
const PX_PER_MICKEY = 1.3;
const FRAME_W = 1680;
const FRAME_H = 1050;
const V5_PRESENCE_THRESHOLD = 0.2;

interface Target { name: string; slug: string; x: number; y: number; }
const TARGETS: Target[] = [
  { name: 'Settings', slug: 'settings', x: 905, y: 808 },
  { name: 'Books',    slug: 'books',    x: 642, y: 808 },
  { name: 'Files',    slug: 'files',    x: 1037, y: 425 },
];

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/clickv2';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('ensuring iPad unlocked...');
await unlockIpad(client).catch(e => console.error(`unlock warning: ${e.message}`));
await new Promise(r => setTimeout(r, 1000));

function clampEmit(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v)));
}

let lastWakeShot: Buffer | null = null;
async function wakeAndDetect(): Promise<{ x: number; y: number; presence: number } | null> {
  // Small wake pulse, then detect via v5.
  await client.mouseMoveRelative(20, 0);
  await client.mouseMoveRelative(-20, 0);
  await new Promise(r => setTimeout(r, 150));
  const shot = await client.screenshot();
  lastWakeShot = shot.buffer;
  return findCursorPresenceV5(shot.buffer, FRAME_W, FRAME_H);
}

async function bigWakeAndDetect(): Promise<{ x: number; y: number; presence: number } | null> {
  // Larger wake, used if v5 says no cursor on first try.
  await client.mouseMoveRelative(60, 0);
  await client.mouseMoveRelative(-60, 0);
  await new Promise(r => setTimeout(r, 200));
  const shot = await client.screenshot();
  return findCursorPresenceV5(shot.buffer, FRAME_W, FRAME_H);
}

let totalHits = 0;
let totalTrials = 0;
const perTarget: Record<string, { hits: number; total: number }> = {};

for (const target of TARGETS) {
  perTarget[target.name] = { hits: 0, total: 0 };
  const dir = path.join(ROOT, target.slug);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== Target ${target.name} (${target.x}, ${target.y}) ===`);

  for (let t = 1; t <= TRIALS; t++) {
    const trialDir = path.join(dir, `trial-${String(t).padStart(2, '0')}`);
    await fs.mkdir(trialDir, { recursive: true });

    // 1. Home + settle
    await ipadGoHome(client);
    await new Promise(r => setTimeout(r, 900));
    const homeShot = await client.screenshot();
    await fs.writeFile(path.join(trialDir, '00-after-home.jpg'), homeShot.buffer);

    // 2 + 3. Wake + detect cursor.
    let detected = await wakeAndDetect();
    if (!detected || detected.presence < V5_PRESENCE_THRESHOLD) {
      detected = await bigWakeAndDetect();
    }

    if (!detected || detected.presence < V5_PRESENCE_THRESHOLD) {
      // Couldn't find cursor — log and skip.
      const row = {
        trial: t, target: target.name,
        success: false, reason: 'cursor-not-found',
        v5_presence: detected?.presence ?? null,
      };
      await fs.writeFile(path.join(trialDir, 'result.json'), JSON.stringify(row, null, 2));
      console.error(`  trial ${t}/${TRIALS}: SKIP (cursor not detected, presence=${(detected?.presence ?? 0).toFixed(2)})`);
      perTarget[target.name].total++;
      totalTrials++;
      continue;
    }

    // 4. Compute delta.
    const dxPx = target.x - detected.x;
    const dyPx = target.y - detected.y;
    const dxMickeys = clampEmit(dxPx / PX_PER_MICKEY);
    const dyMickeys = clampEmit(dyPx / PX_PER_MICKEY);

    // 5. ONE big emit. (If delta is huge, this clamps to 127 — won't
    // reach in one shot, but we'll still get the best-single-emit
    // displacement, which on iPadOS's accelerated regime is much more
    // than chunked emits would deliver.)
    await client.mouseMoveRelative(dxMickeys, dyMickeys);
    await new Promise(r => setTimeout(r, 250));
    const afterEmitShot = await client.screenshot();
    await fs.writeFile(path.join(trialDir, '01-after-emit.jpg'), afterEmitShot.buffer);

    // 6. Click + post-screenshot.
    await client.mouseClick('left');
    await new Promise(r => setTimeout(r, 500));
    const postShot = await client.screenshot();
    await fs.writeFile(path.join(trialDir, '02-after-click.jpg'), postShot.buffer);

    // Strict-success check.
    const v = await verifyClickByDiff(homeShot.buffer, postShot.buffer, {
      minChangedFraction: STRICT_THRESHOLD,
    });
    const success = v.screenChanged;

    const row = {
      trial: t, target: target.name,
      detected_cursor: { x: detected.x, y: detected.y, presence: detected.presence },
      delta_px: { x: dxPx, y: dyPx },
      emit_mickeys: { x: dxMickeys, y: dyMickeys },
      success,
      strict_changed_fraction: v.changedFraction,
    };
    await fs.writeFile(path.join(trialDir, 'result.json'), JSON.stringify(row, null, 2));

    if (success) {
      perTarget[target.name].hits++;
      totalHits++;
    }
    perTarget[target.name].total++;
    totalTrials++;
    console.error(
      `  trial ${t}/${TRIALS}: ${success ? 'HIT' : 'MISS'} ` +
      `cursor@(${detected.x.toFixed(0)},${detected.y.toFixed(0)}) pres=${detected.presence.toFixed(2)} ` +
      `emit=(${dxMickeys},${dyMickeys}) Δ=${(v.changedFraction * 100).toFixed(1)}%`,
    );
  }
  console.error(
    `  ${target.name}: ${perTarget[target.name].hits}/${perTarget[target.name].total} ` +
    `(${(100 * perTarget[target.name].hits / perTarget[target.name].total).toFixed(0)}%)`,
  );
}

console.error(`\n=== clickv2 total: ${totalHits}/${totalTrials} (${(100 * totalHits / totalTrials).toFixed(0)}%) ===`);
for (const t of TARGETS) {
  const r = perTarget[t.name];
  console.error(`  ${t.name}: ${r.hits}/${r.total} (${(100 * r.hits / r.total).toFixed(0)}%)`);
}
