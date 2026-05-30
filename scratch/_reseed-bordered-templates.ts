/**
 * Re-seed cursor templates for the new white-bordered cursor.
 *
 *   1. Back up existing templates to data/cursor-templates.pre-bordered-<ts>/
 *   2. Measure cluster size of the bordered cursor (loose bounds diff)
 *   3. Seed N templates by walking the cursor across home-screen positions
 *      using bumped maxClusterSize so big bordered clusters aren't rejected
 *   4. Report final template count
 */
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  decodeScreenshot,
  diffPixels,
  diffScreenshotsDecoded,
} from '../src/pikvm/cursor-detect.js';
import { extractMaskedTemplate } from '../src/pikvm/seed-template.js';
import {
  loadTemplateSet,
  persistTemplate,
  DEFAULT_TEMPLATE_DIR,
} from '../src/pikvm/template-set.js';
import { looksLikeCursor } from '../src/pikvm/move-to.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const TEMPLATE_DIR = DEFAULT_TEMPLATE_DIR;
const BACKUP_DIR = `${TEMPLATE_DIR}.pre-bordered-${Date.now()}`;

async function grab(): Promise<Buffer> {
  await client.mouseMoveRelative(1, 0);
  await client.mouseMoveRelative(-1, 0);
  await new Promise(r => setTimeout(r, 100));
  const shot = await client.screenshot();
  return shot.buffer;
}

async function measureClusterSize(): Promise<number[]> {
  console.log('Measuring cluster size of bordered cursor...');
  const before = await grab();
  await client.mouseMoveRelative(80, 0);
  await new Promise(r => setTimeout(r, 400));
  const after = await grab();
  const decBefore = await decodeScreenshot(before);
  const decAfter = await decodeScreenshot(after);
  const clusters = diffScreenshotsDecoded(decBefore, decAfter, {
    diffThreshold: 30,
    minClusterSize: 5,
    maxClusterSize: 5000,
    mergeRadius: 30,
    brightnessFloor: 100,
    maxChannelDelta: 0,
  });
  const sizes = clusters.map(c => c.pixels).sort((a, b) => b - a);
  console.log(`Found ${clusters.length} clusters. Sizes (top 10): [${sizes.slice(0, 10).join(', ')}]`);
  return sizes;
}

async function seedOne(maxClusterSize: number): Promise<{
  ok: boolean;
  clusterSize?: number;
  decision?: string;
  reason?: string;
}> {
  const before = await grab();
  await client.mouseMoveRelative(100, 0);
  await new Promise(r => setTimeout(r, 400));
  const after = await grab();
  const decBefore = await decodeScreenshot(before);
  const decAfter = await decodeScreenshot(after);
  const clusters = diffScreenshotsDecoded(decBefore, decAfter, {
    diffThreshold: 30,
    minClusterSize: 15,
    maxClusterSize,
    mergeRadius: 30,
    brightnessFloor: 100,
    maxChannelDelta: 0,
  });
  if (clusters.length === 0) return { ok: false, reason: 'no clusters' };
  const diffMask = diffPixels(
    decBefore.rgb, decAfter.rgb,
    decBefore.width, decBefore.height,
    30, 100, 0,
  );
  const sorted = [...clusters].sort((a, b) => b.pixels - a.pixels);
  for (const cluster of sorted) {
    const centre = {
      x: Math.round(cluster.centroidX),
      y: Math.round(cluster.centroidY),
    };
    const tpl = extractMaskedTemplate(decAfter, centre, 24, diffMask);
    if (!looksLikeCursor(tpl)) continue;
    const existing = await loadTemplateSet(TEMPLATE_DIR);
    const r = await persistTemplate(TEMPLATE_DIR, tpl, existing);
    return { ok: true, clusterSize: cluster.pixels, decision: r.decision };
  }
  return { ok: false, clusterSize: sorted[0].pixels, reason: 'all candidates rejected by looksLikeCursor' };
}

async function main() {
  console.log(`Backing up ${TEMPLATE_DIR} -> ${BACKUP_DIR}`);
  try { await fs.rename(TEMPLATE_DIR, BACKUP_DIR); } catch {}
  await fs.mkdir(TEMPLATE_DIR, { recursive: true });

  const sizes = await measureClusterSize();
  const top = sizes[0] ?? 0;
  const maxClusterSize = Math.max(150, Math.min(800, Math.ceil(top * 1.3)));
  console.log(`Using maxClusterSize=${maxClusterSize} for seeding\n`);

  const moves: Array<[number, number, string]> = [
    [0, 0, 'A'],
    [-300, -100, 'B'],
    [400, 50, 'C'],
    [0, 300, 'D'],
    [-200, -250, 'E'],
    [250, -200, 'F'],
    [-150, 250, 'G'],
    [300, 100, 'H'],
  ];

  let added = 0, failed = 0;
  for (const [dx, dy, label] of moves) {
    if (dx !== 0 || dy !== 0) {
      await client.mouseMoveRelative(dx, dy);
      await new Promise(r => setTimeout(r, 300));
    }
    const r = await seedOne(maxClusterSize);
    if (r.ok) {
      added++;
      console.log(`  [${label}] OK cluster=${r.clusterSize}px decision=${r.decision}`);
    } else {
      failed++;
      console.log(`  [${label}] FAIL cluster=${r.clusterSize ?? '-'} reason=${r.reason}`);
    }
  }

  const final = await loadTemplateSet(TEMPLATE_DIR);
  console.log(`\n${added} succeeded, ${failed} failed. ${final.length} templates in ${TEMPLATE_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
