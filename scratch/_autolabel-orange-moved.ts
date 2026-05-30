/**
 * Auto-label by combining "is orange" AND "moved between consecutive frames".
 *
 * For frame N in a scene:
 *   1. Compute pixel-level diff with frame N-1 (and N+1 if N==0, to handle
 *      first-frame case).
 *   2. Build orange mask on frame N.
 *   3. AND the two: keep orange pixels that ALSO changed vs neighbour.
 *   4. Find largest connected component → cursor centroid.
 *
 * This rejects stationary orange UI elements (Airplane Mode icon, Books
 * welcome modal icon, Notes yellow tab) because they don't change between
 * frames. Only the orange cursor itself moves.
 *
 * Edge case: if the cursor BARELY moves between two frames (or didn't
 * wiggle this frame), we may miss it. Fall back to the largest CHANGED
 * orange cluster across the WHOLE scene as a stale-cursor predictor.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.argv[2] ?? 'data/cursor-collect-2026-05-27T19-00-08';

interface Cand {
  cx: number;
  cy: number;
  pixels: number;
}

function isOrange(r: number, g: number, b: number): boolean {
  if (r < 200) return false;
  if (g < 100 || g > 200) return false;
  if (b > 100) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return false;
  return (max - min) / max > 0.5;
}

async function decode(p: string): Promise<{ rgb: Buffer; w: number; h: number }> {
  const { data, info } = await sharp(await fs.readFile(p)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, w: info.width, h: info.height };
}

function diffMask(a: Buffer, b: Buffer, threshold: number): Uint8Array {
  const out = new Uint8Array(a.length / 3);
  for (let i = 0; i < out.length; i++) {
    const o = i * 3;
    const dr = Math.abs(a[o] - b[o]);
    const dg = Math.abs(a[o + 1] - b[o + 1]);
    const db = Math.abs(a[o + 2] - b[o + 2]);
    if (dr + dg + db >= threshold * 3) out[i] = 1;
  }
  return out;
}

function findLargestOrangeMovedCluster(rgb: Buffer, w: number, h: number, motion: Uint8Array): Cand | null {
  // Combined mask: orange AND moved
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!motion[i]) continue;
    const o = i * 3;
    if (isOrange(rgb[o], rgb[o + 1], rgb[o + 2])) mask[i] = 1;
  }

  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const candidates: Cand[] = [];

  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || visited[i]) continue;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    let sumX = 0, sumY = 0, pixels = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const py = Math.floor(p / w);
      const px = p - py * w;
      sumX += px; sumY += py; pixels++;
      const neigh = [
        py > 0 ? p - w : -1,
        py < h - 1 ? p + w : -1,
        px > 0 ? p - 1 : -1,
        px < w - 1 ? p + 1 : -1,
      ];
      for (const n of neigh) {
        if (n < 0 || visited[n] || !mask[n]) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (pixels >= 20 && pixels < 5000) {
      candidates.push({ cx: sumX / pixels, cy: sumY / pixels, pixels });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.pixels - a.pixels);
  return candidates[0];
}

async function main() {
  const scenes = (await fs.readdir(ROOT, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const out: string[] = [];
  let okCount = 0, nullCount = 0;
  const pxStats: number[] = [];

  for (const scene of scenes) {
    const dir = path.join(ROOT, scene);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.jpg')).sort();
    const decoded: Array<{ rgb: Buffer; w: number; h: number }> = [];
    for (const f of files) decoded.push(await decode(path.join(dir, f)));

    for (let i = 0; i < files.length; i++) {
      // Pair with the OTHER frame: i==0 uses frame 1; otherwise uses i-1.
      // This way frame 0 still gets a motion signal.
      const otherIdx = i === 0 ? 1 : i - 1;
      const motion = diffMask(decoded[i].rgb, decoded[otherIdx].rgb, 30);
      const cand = findLargestOrangeMovedCluster(decoded[i].rgb, decoded[i].w, decoded[i].h, motion);
      if (cand) {
        okCount++;
        pxStats.push(cand.pixels);
        out.push(JSON.stringify({
          frame: `${scene}/${files[i]}`,
          cursor: { x: Math.round(cand.cx), y: Math.round(cand.cy) },
          decision: 'correct',
          pixels: cand.pixels,
        }));
      } else {
        nullCount++;
        out.push(JSON.stringify({
          frame: `${scene}/${files[i]}`,
          cursor: null,
          decision: 'absent',
        }));
      }
    }
  }

  const outPath = path.join(ROOT, 'cursor-orange-moved-autolabel.jsonl');
  await fs.writeFile(outPath, out.join('\n') + '\n');
  pxStats.sort((a, b) => a - b);
  const median = pxStats[Math.floor(pxStats.length / 2)] ?? 0;
  console.log(`Labeled ${okCount} frames, ${nullCount} no-cursor. Pixel median=${median} min=${pxStats[0] ?? '-'} max=${pxStats[pxStats.length - 1] ?? '-'} → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
