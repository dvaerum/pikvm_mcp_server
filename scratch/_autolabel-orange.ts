/**
 * Auto-label orange-cursor frames by finding the largest pure-orange
 * pixel cluster. Cursor renders in iOS system orange ≈ rgb(255, 159, 10);
 * iOS UI has near-zero saturated orange pixels (the orange Books and
 * App Store app icons are small, isolated, and contain mostly non-pure
 * orange — beige, brown, yellow).
 *
 * Algorithm:
 *   1. Mask pixels where R >= 200 AND G in [100, 200] AND B < 100
 *      AND saturation (max-min)/max > 0.5.
 *   2. Find connected components (4-neighbour flood fill).
 *   3. Return the largest cluster's centroid.
 *
 * Output: cursor-orange-autolabel.jsonl with one line per frame.
 *
 * Usage:  npx tsx _autolabel-orange.ts [collect_dir]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const FRAMES_ROOT = process.argv[2] ?? 'data/cursor-collect-orange-LATEST';

interface Candidate {
  cx: number;
  cy: number;
  pixels: number;
  bbW: number;
  bbH: number;
}

function isOrange(r: number, g: number, b: number): boolean {
  if (r < 200) return false;
  if (g < 100 || g > 200) return false;
  if (b > 100) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return false;
  const sat = (max - min) / max;
  return sat > 0.5;
}

async function processFrame(jpegPath: string): Promise<Candidate | null> {
  const jpg = await fs.readFile(jpegPath);
  const { data: rgb, info } = await sharp(jpg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // Orange mask.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    if (isOrange(rgb[o], rgb[o + 1], rgb[o + 2])) mask[i] = 1;
  }

  // Connected components via flood fill.
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const candidates: Candidate[] = [];

  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || visited[i]) continue;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    let sumX = 0, sumY = 0, pixels = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const py = Math.floor(p / w);
      const px = p - py * w;
      sumX += px; sumY += py; pixels++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      const neigh = [
        py > 0 ? p - w : -1,
        py < h - 1 ? p + w : -1,
        px > 0 ? p - 1 : -1,
        px < w - 1 ? p + 1 : -1,
      ];
      for (const n of neigh) {
        if (n < 0) continue;
        if (visited[n] || !mask[n]) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }
    candidates.push({
      cx: sumX / pixels,
      cy: sumY / pixels,
      pixels,
      bbW: maxX - minX + 1,
      bbH: maxY - minY + 1,
    });
  }

  if (candidates.length === 0) return null;
  // Prefer cursor-sized clusters: > 30 px and < 5000 px.
  const eligible = candidates.filter(c => c.pixels >= 30 && c.pixels < 5000);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.pixels - a.pixels);
  return eligible[0];
}

async function main() {
  // Resolve LATEST symlink-style: find the most recent cursor-collect-*.
  let root = FRAMES_ROOT;
  if (root === 'data/cursor-collect-orange-LATEST') {
    const entries = await fs.readdir('data');
    const matching = entries
      .filter(e => e.startsWith('cursor-collect-2026-05-27T'))
      .sort()
      .reverse();
    if (matching.length === 0) {
      console.error('no cursor-collect-2026-05-27T* dirs found');
      process.exit(1);
    }
    root = `data/${matching[0]}`;
    console.error(`using latest: ${root}`);
  }

  const scenes = (await fs.readdir(root, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const out: string[] = [];
  let okCount = 0, nullCount = 0;
  let totalPx = 0, maxPx = 0, minPx = Number.MAX_SAFE_INTEGER;
  for (const scene of scenes) {
    const dir = path.join(root, scene);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.jpg')).sort();
    for (const f of files) {
      const fp = path.join(dir, f);
      const c = await processFrame(fp);
      if (c) {
        okCount++;
        totalPx += c.pixels;
        if (c.pixels > maxPx) maxPx = c.pixels;
        if (c.pixels < minPx) minPx = c.pixels;
        out.push(JSON.stringify({
          frame: `${scene}/${f}`,
          cursor: { x: Math.round(c.cx), y: Math.round(c.cy) },
          decision: 'correct',
          pixels: c.pixels,
          bbW: c.bbW,
          bbH: c.bbH,
        }));
      } else {
        nullCount++;
        out.push(JSON.stringify({
          frame: `${scene}/${f}`,
          cursor: null,
          decision: 'absent',
        }));
      }
    }
  }
  const outPath = path.join(root, 'cursor-orange-autolabel.jsonl');
  await fs.writeFile(outPath, out.join('\n') + '\n');
  console.log(
    `Labeled ${okCount} frames, ${nullCount} no-cursor. ` +
    `Pixel stats: min=${minPx} max=${maxPx} mean=${Math.round(totalPx / Math.max(1, okCount))}. ` +
    `→ ${outPath}`,
  );
}

main().catch(e => { console.error(e); process.exit(1); });
