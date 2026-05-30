/**
 * Auto-label the bordered-cursor frames by detecting the distinctive
 * white-halo-around-dark-body signature.
 *
 * Strategy:
 *   1. Build a binary mask of "bright" pixels (R+G+B >= 600 ≈ white).
 *   2. Find connected components in the bright mask.
 *   3. For each component sized 20-300 px (the white border), check
 *      whether its bounding box contains a DARK center (≤ 80 mean brightness).
 *   4. Pick the highest-scoring candidate. Score = darkCenterFraction × (1 / |area − 80|+1)
 *      penalising both no-dark-center and atypical sizes.
 *
 * Output: cursor-bordered-autolabel.jsonl with one line per frame:
 *   { frame: "scene/frame-XXX.jpg", cursor: { x, y } | null, score, reason }
 *
 * Followed by a human spot-check — write _verify-autolabel-overlay.ts to
 * draw the predicted position so we can eyeball whether the labeler is
 * good enough to train on.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const FRAMES_ROOT = process.argv[2] ?? 'data/cursor-collect-2026-05-27T18-18-56';

interface Candidate {
  cx: number;
  cy: number;
  pixels: number;
  darkCenterFraction: number;
  score: number;
}

async function processFrame(jpegPath: string): Promise<Candidate | null> {
  const jpg = await fs.readFile(jpegPath);
  const { data: rgb, info } = await sharp(jpg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // Bright mask.
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    const sum = rgb[o] + rgb[o + 1] + rgb[o + 2];
    if (sum >= 600) bright[i] = 1;
  }

  // Connected components on bright mask via simple flood fill.
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const candidates: Candidate[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!bright[idx] || visited[idx]) continue;
      // BFS
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;
      let sumX = 0, sumY = 0, pixels = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const py = Math.floor(p / w);
        const px = p - py * w;
        sumX += px; sumY += py; pixels++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        // 4-neighbours
        const neigh = [p - 1, p + 1, p - w, p + w];
        for (const n of neigh) {
          if (n < 0 || n >= w * h) continue;
          if (visited[n] || !bright[n]) continue;
          const ny = Math.floor(n / w);
          const nx = n - ny * w;
          if (Math.abs(nx - px) > 1 || Math.abs(ny - py) > 1) continue;
          visited[n] = 1;
          stack.push(n);
        }
      }
      // Size gate for white border component (NOT the full cursor — just
      // the bright pixels of the halo). Border is thin, so we expect
      // ~30-150 px of bright pixels per cursor.
      if (pixels < 20 || pixels > 300) continue;
      // Bounding-box must be small (cursor-sized: 8-30 px on each side)
      const bbW = maxX - minX + 1;
      const bbH = maxY - minY + 1;
      if (bbW > 40 || bbH > 40) continue;
      if (bbW < 6 || bbH < 6) continue;
      const cx = sumX / pixels;
      const cy = sumY / pixels;
      // Count dark pixels inside the bounding box
      let darkCount = 0;
      let totalInBox = 0;
      for (let by = minY; by <= maxY; by++) {
        for (let bx = minX; bx <= maxX; bx++) {
          const bi = (by * w + bx) * 3;
          const mean = (rgb[bi] + rgb[bi + 1] + rgb[bi + 2]) / 3;
          totalInBox++;
          if (mean <= 80) darkCount++;
        }
      }
      const darkCenterFraction = darkCount / Math.max(1, totalInBox);
      // Score: prefer cursors with significant dark center, ~80 px ideal halo size
      const sizeAffinity = 1 / (1 + Math.abs(pixels - 80) / 30);
      const score = darkCenterFraction * sizeAffinity;
      candidates.push({ cx, cy, pixels, darkCenterFraction, score });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

async function main() {
  const scenes = (await fs.readdir(FRAMES_ROOT, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const out: string[] = [];
  let okCount = 0, nullCount = 0;
  for (const scene of scenes) {
    const dir = path.join(FRAMES_ROOT, scene);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.jpg')).sort();
    for (const f of files) {
      const fp = path.join(dir, f);
      const c = await processFrame(fp);
      if (c) {
        okCount++;
        out.push(JSON.stringify({
          frame: `${scene}/${f}`,
          cursor: { x: Math.round(c.cx), y: Math.round(c.cy) },
          decision: 'correct',
          score: Number(c.score.toFixed(3)),
          pixels: c.pixels,
          darkCenterFraction: Number(c.darkCenterFraction.toFixed(2)),
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
  const outPath = path.join(FRAMES_ROOT, 'cursor-bordered-autolabel.jsonl');
  await fs.writeFile(outPath, out.join('\n') + '\n');
  console.log(`Labeled ${okCount} frames, ${nullCount} no-cursor. → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
