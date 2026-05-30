import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { decodeScreenshot, findClusters, diffPixels, extractCursorTemplateDecoded } from '../src/pikvm/cursor-detect.js';
import { extractMaskedTemplate } from '../src/pikvm/seed-template.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { looksLikeCursor } from '../src/pikvm/move-to.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/phase215-diagnose';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 215 diagnose: why looksLikeCursor rejects ===\n');

// Reach home screen
await unlockIpad(client, { dragPx: 1500 });
await new Promise(r => setTimeout(r, 800));
await ipadGoHome(client, { forceHomeViaSwipe: true });
await new Promise(r => setTimeout(r, 800));

// Pre-position cursor to centre via slam + chunked emit
const { slamToCorner } = await import('../src/pikvm/ballistics.js');
await slamToCorner(client, { corner: 'top-left', paceMs: 60 });
await new Promise(r => setTimeout(r, 300));
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

// Capture pre-emit
const pre = await client.screenshot();
const decPre = await decodeScreenshot(pre.buffer);
await fs.writeFile(`${ROOT}/01-pre.jpg`, pre.buffer);

// Wake the cursor with a clear lateral motion
await client.mouseMoveRelative(80, 0);
await new Promise(r => setTimeout(r, 80));

// Capture post-emit
const post = await client.screenshot();
const decPost = await decodeScreenshot(post.buffer);
await fs.writeFile(`${ROOT}/02-post.jpg`, post.buffer);

// Compute diff mask
const diffMask = diffPixels(
  decPre.rgb, decPost.rgb,
  decPre.width, decPre.height,
  30, 100, 0,
);

// Find clusters
const clusters = findClusters(diffMask, decPre.width, decPre.height, 15, 200);
console.error(`Clusters found: ${clusters.length}`);
for (let i = 0; i < clusters.length; i++) {
  const c = clusters[i];
  console.error(`  [${i}] (${Math.round(c.centroidX)}, ${Math.round(c.centroidY)}) pixels=${c.pixels}`);
}

// For each cluster, extract masked + unmasked templates and run looksLikeCursor
const sorted = [...clusters].sort((a, b) => b.pixels - a.pixels);
for (let i = 0; i < sorted.length; i++) {
  const c = sorted[i];
  const pos = { x: Math.round(c.centroidX), y: Math.round(c.centroidY) };

  const masked = extractMaskedTemplate(decPost, pos, 24, diffMask);
  const unmasked = extractCursorTemplateDecoded(decPost, pos, 24);

  await sharp(masked.rgb, { raw: { width: 24, height: 24, channels: 3 } })
    .resize(240, 240, { kernel: 'nearest' })
    .png().toFile(`${ROOT}/03-cluster-${i}-masked-10x.png`);
  await sharp(unmasked.rgb, { raw: { width: 24, height: 24, channels: 3 } })
    .resize(240, 240, { kernel: 'nearest' })
    .png().toFile(`${ROOT}/04-cluster-${i}-unmasked-10x.png`);

  const maskedOk = looksLikeCursor(masked);
  const unmaskedOk = looksLikeCursor(unmasked);
  console.error(`  cluster ${i}: masked looksLikeCursor=${maskedOk}, unmasked looksLikeCursor=${unmaskedOk}`);

  // Stat dump
  let maxBrightness = 0;
  let minBrightness = 255;
  let sumSat = 0;
  for (let p = 0; p < 24*24; p++) {
    const o = p * 3;
    const r = masked.rgb[o], g = masked.rgb[o+1], b = masked.rgb[o+2];
    const cMin = Math.min(r, g, b);
    const cMax = Math.max(r, g, b);
    if (cMin < minBrightness) minBrightness = cMin;
    if (cMax > maxBrightness) maxBrightness = cMax;
    sumSat += cMax - cMin;
  }
  const meanSat = sumSat / (24*24);
  console.error(`    masked stats: brightness range=[${minBrightness}, ${maxBrightness}], meanSat=${meanSat.toFixed(1)}`);
}

// Crop the post screenshot around the brightest cluster for visual confirmation
if (sorted.length > 0) {
  const c = sorted[0];
  const cx = Math.round(c.centroidX), cy = Math.round(c.centroidY);
  const halfW = 60;
  const cropX = Math.max(0, cx - halfW);
  const cropY = Math.max(0, cy - halfW);
  const cropSize = halfW * 2;
  await sharp(post.buffer)
    .extract({ left: cropX, top: cropY, width: cropSize, height: cropSize })
    .resize(480, 480, { kernel: 'nearest' })
    .toFile(`${ROOT}/05-cluster-0-context-zoom.png`);
}

process.exit(0);
