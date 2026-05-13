/**
 * Phase 304: capture pointer-effect on icons using CHUNKED emits.
 *
 * Phase 302 used single big emits that got clamped to -127 — cursor
 * never reached the icons. This version chunks emits at 20 mickeys
 * with 30ms pace (matching production emitChunked defaults).
 *
 * For each bottom-row icon:
 *   1. Home cursor
 *   2. Capture baseline frame (cursor at home)
 *   3. Chunk-emit toward icon center
 *   4. Capture snapped frame
 *   5. Compute pixel diff in icon's 200×200 region
 *
 * Then the diff image reveals the pointer-effect visual signature
 * (which pixels change when cursor is on the icon).
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase304-pointer-effect/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 304 chunked-emit pointer-effect capture at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const HOME = { x: 1060, y: 778 };
const RATIO = 1.2;

const ICONS = [
  { name: 'Settings', x: 905, y: 810 },
  { name: 'TV',       x: 773, y: 810 },
  { name: 'Books',    x: 642, y: 810 },
];

async function chunkEmit(dx: number, dy: number, chunkMag = 20, paceMs = 30) {
  let remX = Math.abs(dx), remY = Math.abs(dy);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(chunkMag, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(chunkMag, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    if (remX > 0 || remY > 0) await sleep(paceMs);
  }
}

for (const icon of ICONS) {
  console.error(`\n=== ${icon.name} (${icon.x}, ${icon.y}) ===`);

  // Baseline
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1500);
  await client.mouseMoveRelative(5, 5); await sleep(200);
  await client.mouseMoveRelative(-5, -5); await sleep(400);
  const baseline = await client.screenshot();
  await fs.writeFile(`${ROOT}/${icon.name}_baseline.jpg`, baseline.buffer);

  // Chunked emit toward icon center
  const dx = Math.round((icon.x - HOME.x) / RATIO);
  const dy = Math.round((icon.y - HOME.y) / RATIO);
  console.error(`  Chunk-emitting (${dx}, ${dy}) in 20-mickey chunks toward ${icon.name}`);
  await chunkEmit(dx, dy, 20, 30);
  await sleep(800);

  const snapped = await client.screenshot();
  await fs.writeFile(`${ROOT}/${icon.name}_snapped.jpg`, snapped.buffer);

  // Crop both at icon ± 100 px region
  const cropL = Math.max(0, icon.x - 100);
  const cropT = Math.max(0, icon.y - 100);
  const cropW = 200;
  const cropH = 200;

  await sharp(baseline.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).png().toFile(`${ROOT}/${icon.name}_baseline_crop.png`);
  await sharp(snapped.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).png().toFile(`${ROOT}/${icon.name}_snapped_crop.png`);

  const { data: aRgb, info: aInfo } = await sharp(baseline.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: bRgb } = await sharp(snapped.buffer).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = aInfo.width, H = aInfo.height;
  const diff = Buffer.alloc(W * H * 3);
  let changed = 0, totalDiff = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 3;
    const a = Math.round(aRgb[o] * 0.299 + aRgb[o+1] * 0.587 + aRgb[o+2] * 0.114);
    const b = Math.round(bRgb[o] * 0.299 + bRgb[o+1] * 0.587 + bRgb[o+2] * 0.114);
    const d = Math.abs(a - b);
    if (d > 10) changed++;
    totalDiff += d;
    diff[o] = Math.min(255, d * 4);
    diff[o+1] = 0;
    diff[o+2] = 0;
  }
  await sharp(diff, { raw: { width: W, height: H, channels: 3 } }).png().toFile(`${ROOT}/${icon.name}_diff.png`);
  console.error(`  Diff: ${changed} pixels >10 brightness change; total diff sum=${totalDiff}`);
}

console.error(`\n=== Done. Inspect ${ROOT}/{Icon}_baseline_crop.png, _snapped_crop.png, _diff.png ===`);
process.exit(0);
