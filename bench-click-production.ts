/**
 * Phase 199 — production-defaults click bench.
 *
 * The existing bench-click-extensive.ts measures algorithm INTERNALS
 * (cursor detection accuracy, retry behavior, residuals). It runs with
 * `requireVerifiedCursor: false` and no `maxResidualPx`, which bypasses
 * the safety gates that production MCP applies by default.
 *
 * This bench measures USER EXPERIENCE — what someone calling
 * `pikvm_mouse_click_at` via MCP actually sees. With production defaults:
 * - `requireVerifiedCursor: true` (skip click if cursor not verified)
 * - `maxResidualPx: 35` (skip click if cursor > 35px from target)
 * - same retry budget (3 retries on iPad)
 *
 * Three success classes per trial:
 *   - HIT — click registered, screen changed at the target
 *   - SKIP — algorithm refused to click (safety gate fired)
 *   - MISS — clicked but missed (snap-zone or genuinely wrong position)
 *
 * SKIP is much better than MISS for users: they get a clear error and
 * can retry / use Spotlight. MISS silently lands on adjacent UI.
 *
 * Usage: npx tsx bench-click-production.ts [trials=5]
 */

import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { clickAtWithRetry, defaultMaxRetriesFor, defaultMaxResidualPxFor } from './src/pikvm/click-verify.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

// PA20: real-launch detector. iPadOS pointer-effect cursor-on-icon
// highlight + cursor motion in a 100x100 region around target was
// enough to satisfy verifyClickByDiff without the iPad registering a
// real tap. To get an honest HIT rate, take a HOME-SCREEN REFERENCE
// at the bench start, then after every click compare the WHOLE frame
// to the reference. If the post-click frame is mostly identical to
// home (>= 0.9 similarity), the click did not launch anything,
// regardless of what verifyClickByDiff said.
async function rgbFromJpeg(jpeg: Buffer): Promise<{ rgb: Buffer; w: number; h: number }> {
  // Downscale before comparing — small variation in cursor position
  // would dominate the per-pixel diff otherwise. 96x54 keeps gross
  // structural change (home → app) easily detectable while smoothing
  // over the 1-2 cursor-sized differences that don't matter.
  const meta = await sharp(jpeg).metadata();
  const targetW = 96, targetH = 54;
  const { data } = await sharp(jpeg)
    .resize(targetW, targetH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgb: data, w: targetW, h: targetH };
}

async function similarityToHome(
  postClickJpeg: Buffer,
  homeRgb: Buffer,
): Promise<number> {
  // Mean absolute pixel difference, mapped to [0,1] where 1 = identical.
  const { rgb } = await rgbFromJpeg(postClickJpeg);
  if (rgb.length !== homeRgb.length) return 0;
  let sum = 0;
  for (let i = 0; i < rgb.length; i++) {
    sum += Math.abs(rgb[i] - homeRgb[i]);
  }
  const meanDiff = sum / rgb.length; // 0..255
  return 1 - meanDiff / 255;
}

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);
const MAX_RETRIES = defaultMaxRetriesFor(/*absolute=*/false);
const MAX_RESIDUAL_PX = defaultMaxResidualPxFor(/*absolute=*/false);

const TRIALS = Number(process.argv[2] ?? 5);
const ROOT = './data/click-bench-prod';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
console.error(`Production-defaults bench: ${TRIALS} trials × 4 targets`);
console.error(`maxRetries=${MAX_RETRIES}, maxResidualPx=${MAX_RESIDUAL_PX}, requireVerifiedCursor=true`);

// Capture home-screen reference for the PA20 launch detector.
await ipadGoHome(client);
await new Promise(r => setTimeout(r, 800));
const homeShot = await client.screenshot({ quality: 75 });
const { rgb: homeRgb } = await rgbFromJpeg(homeShot.buffer);
await fs.writeFile(path.join(ROOT, 'home-reference.jpg'), homeShot.buffer);
console.error(`Captured home reference (96x54 RGB, ${homeRgb.length} bytes)`);
// PA20: similarity-to-home threshold for "still home" vs "launched
// app". Bimodal data from the first PA20 run:
//   - 0.924-0.948 when an app (Settings, Maps) is visible
//   - 0.999 when home is unchanged
// The big constant noise floor (~0.92) is the HDMI letterbox black
// border, which is identical between home and any app screenshot.
// 0.95 cleanly separates the two modes; 0.9 (initial guess) was too
// lax and misclassified successful launches as NOLAUNCH.
const HOME_SIM_THRESHOLD = 0.95;

// 2026-05-28: re-measured against the current iPad home-screen layout
// after the bench started producing MISSes (cursor landing in icon
// gaps). The previous coords (905,800) etc. were stale — they hit
// empty wallpaper between icons. Current icon centers:
const TARGETS = [
  { name: 'Settings',  slug: 'settings',  x: 1027, y: 837 },
  { name: 'Books',     slug: 'books',     x: 757,  y: 837 },
  { name: 'AppStore',  slug: 'appstore',  x: 1027, y: 702 },
  { name: 'Files',     slug: 'files',     x: 1162, y: 435 },
];

interface ResultClass {
  hit: number;       // app actually launched (post-click frame differs from home)
  skip: number;      // safety gate refused the click
  miss: number;      // clicked but verifyClickByDiff said no screen change
  nolaunch: number;  // PA20: clickAtWithRetry succeeded but app didn't launch
}

const results: Record<string, ResultClass> = {};

for (const t of TARGETS) {
  results[t.slug] = { hit: 0, skip: 0, miss: 0, nolaunch: 0 };
  const dir = path.join(ROOT, t.slug);
  await fs.mkdir(dir, { recursive: true });
  console.error(`\n=== ${t.name} (${t.x}, ${t.y}) — ${TRIALS} trials ===`);

  for (let i = 1; i <= TRIALS; i++) {
    await ipadGoHome(client);
    await new Promise(r => setTimeout(r, 800));
    // PA23 attempted + reverted: a pre-trial 4-mickey diagonal wake
    // wiggle made HIT rate worse (32% → 20% at n=60). The wake
    // added ~310 ms latency per trial without measurable cursor-
    // visibility benefit; per-target Books 2→0, AppStore 11→7.
    // PA21 baseline (no wake) remains the local maximum.

    const r = await clickAtWithRetry(client, { x: t.x, y: t.y }, {
      maxRetries: MAX_RETRIES,
      moveToOptions: {
        profile: profile ?? undefined,
        forbidSlamFallback: true,
        strategy: 'detect-then-move',
      },
      // Production defaults below — match what MCP calls do.
      maxResidualPx: MAX_RESIDUAL_PX,
      requireVerifiedCursor: true,
      verifyOptions: {
        region: { x: t.x, y: t.y, halfWidth: 50, halfHeight: 50 },
        minChangedFraction: 0.05,
      },
    });

    // Take post-trial screenshot first so we can run the PA20 launch
    // check before classifying.
    const shot = await client.screenshot({ quality: 75 });
    const sim = await similarityToHome(shot.buffer, homeRgb);

    let cls: 'hit' | 'skip' | 'miss' | 'nolaunch';
    if (r.success) {
      // PA20: clickAtWithRetry succeeded (verifyClickByDiff fired), but
      // demote to "nolaunch" if the post-click frame is still mostly
      // home. The local verify region picks up pointer-effect highlight
      // and cursor motion; only a frame-wide change indicates an app
      // actually launched.
      cls = sim >= HOME_SIM_THRESHOLD ? 'nolaunch' : 'hit';
    } else if (r.attemptHistory.every(a => a.skippedClickReason)) {
      cls = 'skip';
    } else {
      cls = 'miss';
    }

    results[t.slug][cls]++;

    const file = path.join(dir, `${String(i).padStart(2, '0')}-${cls}.jpg`);
    await fs.writeFile(file, shot.buffer);
    const skipReasons = r.attemptHistory
      .filter(a => a.skippedClickReason)
      .map(a => `[a${a.attempt}] ${a.skippedClickReason}`)
      .join(' | ');
    const finalPos = r.finalMoveResult.finalDetectedPosition;
    const posStr = finalPos ? `pos=(${finalPos.x},${finalPos.y})` : 'pos=null';
    console.error(
      `  ${i}/${TRIALS} ${cls.toUpperCase()} attempts=${r.attempts} ${posStr} ` +
      `sim=${sim.toFixed(3)} → ${file}`,
    );
    if (skipReasons) console.error(`    reasons: ${skipReasons}`);
  }
}

console.error('\n========== SUMMARY (PRODUCTION DEFAULTS) ==========\n');
console.error('Target      | hit | skip | miss | nolaunch | n');
console.error('------------+-----+------+------+----------+----');
let totalHit = 0, totalSkip = 0, totalMiss = 0, totalNolaunch = 0, totalN = 0;
for (const t of TARGETS) {
  const c = results[t.slug];
  const n = c.hit + c.skip + c.miss + c.nolaunch;
  totalHit += c.hit;
  totalSkip += c.skip;
  totalMiss += c.miss;
  totalNolaunch += c.nolaunch;
  totalN += n;
  const fmt = (v: number) => `${v}/${n}`;
  console.error(
    `${t.name.padEnd(11)} | ${fmt(c.hit).padStart(3)} | ${fmt(c.skip).padStart(4)} | ${fmt(c.miss).padStart(4)} | ${fmt(c.nolaunch).padStart(8)} | ${n}`,
  );
}
console.error('------------+-----+------+------+----------+----');
console.error(
  `${'TOTAL'.padEnd(11)} | ${`${totalHit}/${totalN}`.padStart(3)} | ${`${totalSkip}/${totalN}`.padStart(4)} | ${`${totalMiss}/${totalN}`.padStart(4)} | ${`${totalNolaunch}/${totalN}`.padStart(8)} | ${totalN}`,
);
console.error(`\nReal launch rate: ${((100 * totalHit) / totalN).toFixed(0)}%`);
console.error(`Skip rate (safety gate fired): ${((100 * totalSkip) / totalN).toFixed(0)}%`);
console.error(`Miss rate (verifyClickByDiff said no change): ${((100 * totalMiss) / totalN).toFixed(0)}%`);
console.error(`PA20 NO-LAUNCH rate (verifyClickByDiff said HIT but frame still home): ${((100 * totalNolaunch) / totalN).toFixed(0)}%`);
console.error('\nNote: SKIPs are graceful failures (user gets a clear error).');
console.error('NO-LAUNCH means the bench thought a click registered but the iPad did not launch the app.');

process.exit(0);
