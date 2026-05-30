/**
 * Phase 302: capture and characterize the iPadOS pointer-effect-on-icon
 * visual signature.
 *
 * For each icon in the bottom row (Books, TV, Settings):
 *   1. Capture frame with cursor AT HOME (not on icon) — baseline
 *   2. Drive cursor to icon center via large emit
 *   3. Capture frame with cursor SNAPPED to icon
 *   4. Crop both around the icon, save side by side
 *   5. Visually compare to identify pointer-effect pattern
 *
 * The goal: see what pixels CHANGE between baseline and snapped state.
 * That diff IS the pointer-effect signature.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase302-pointer-effect/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 302 pointer-effect capture at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const ICONS = [
  { name: 'Settings', x: 905, y: 810, mickeys: -155 },  // from home (1060, 778) → 905 = -155 mickeys
  { name: 'TV',       x: 773, y: 810, mickeys: -287 },
  { name: 'Books',    x: 642, y: 810, mickeys: -418 },
];

for (const icon of ICONS) {
  console.error(`\n=== ${icon.name} (target: ${icon.x}, ${icon.y}) ===`);

  // Step 1: baseline (cursor at home, not on icon)
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1500);
  // Wake cursor with a tiny wiggle
  await client.mouseMoveRelative(5, 5);
  await sleep(200);
  await client.mouseMoveRelative(-5, -5);
  await sleep(400);
  const baseline = await client.screenshot();
  await fs.writeFile(`${ROOT}/${icon.name}_baseline.jpg`, baseline.buffer);
  console.error(`  Saved baseline frame (cursor at home)`);

  // Step 2: drive cursor onto the icon with a single emit
  // Phase 301 showed ~1.2 px/mickey. So to move from (1060) to icon.x:
  // mickeys = (icon.x - 1060) / 1.2 ≈ icon.mickeys
  // We override icon.mickeys to use 1.2 ratio explicitly
  const moveMickeys = Math.round((icon.x - 1060) / 1.2);
  console.error(`  Emitting ${moveMickeys} mickeys leftward to drive cursor toward ${icon.name}`);
  await client.mouseMoveRelative(moveMickeys, Math.round((icon.y - 778) / 1.2));
  await sleep(800);

  const snapped = await client.screenshot();
  await fs.writeFile(`${ROOT}/${icon.name}_snapped.jpg`, snapped.buffer);
  console.error(`  Saved snapped frame (cursor expected on/near ${icon.name})`);

  // Step 3: compute diff image — sharp's composite with difference mode
  // Crops both at icon ± 80 px region; save the cropped region
  const cropL = Math.max(0, icon.x - 80);
  const cropT = Math.max(0, icon.y - 80);
  const cropW = 160;
  const cropH = 160;

  try {
    await sharp(baseline.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).png().toFile(`${ROOT}/${icon.name}_baseline_crop.png`);
    await sharp(snapped.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).png().toFile(`${ROOT}/${icon.name}_snapped_crop.png`);

    // Pixel-level diff: gray(baseline) vs gray(snapped), keep absolute difference
    const { data: aRgb, info: aInfo } = await sharp(baseline.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data: bRgb } = await sharp(snapped.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = aInfo.width, H = aInfo.height;
    const diff = Buffer.alloc(W * H * 3);
    let totalDiff = 0;
    let changedPixels = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 3;
      const a = Math.round(aRgb[o] * 0.299 + aRgb[o+1] * 0.587 + aRgb[o+2] * 0.114);
      const b = Math.round(bRgb[o] * 0.299 + bRgb[o+1] * 0.587 + bRgb[o+2] * 0.114);
      const d = Math.abs(a - b);
      if (d > 5) changedPixels++;
      totalDiff += d;
      // Render diff as red intensity
      diff[o] = Math.min(255, d * 3); // red boost
      diff[o+1] = 0;
      diff[o+2] = 0;
    }
    await sharp(diff, { raw: { width: W, height: H, channels: 3 } }).png().toFile(`${ROOT}/${icon.name}_diff.png`);
    console.error(`  Diff: ${changedPixels} pixels changed (>5 brightness diff), total diff sum=${totalDiff}`);
  } catch (e) {
    console.error(`  crop/diff failed: ${(e as Error).message}`);
  }
}

console.error(`\n=== Done. Inspect ${ROOT}/{Icon}_baseline_crop.png, _snapped_crop.png, _diff.png ===`);
process.exit(0);
