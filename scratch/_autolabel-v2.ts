/**
 * Auto-labeller v2 — fixes for the failure modes the PA26 verification
 * found in v1 (37% agreement with human labels on benchmark frames):
 *
 * 1. Tighter "orange" definition. The iOS pointer-orange is a distinctive
 *    bright saturated orange that differs from icon-edge orange in
 *    saturation and red-channel dominance.
 * 2. Stronger motion threshold (50 vs 30) to reject JPEG artifacts and
 *    widget refresh noise.
 * 3. Tighter size band (25-200 px). The orange-bordered cursor on this
 *    iPad measures ~30-150 px; an icon edge of 500+ px is never cursor.
 * 4. Cursor-shape gate: bounding-box aspect ratio must be 0.4-2.5
 *    (cursor is roughly square/triangular; icon edges are long thin
 *    rectangles) AND density (pixels / bbox-area) > 0.35 (icon edges
 *    are sparse rasters along a line; the cursor is a packed blob).
 * 5. White-border discriminator: the user's iPad has the white border
 *    enabled. Count white pixels in a 5-px ring around the cluster
 *    bounding box; real cursor has many, icon-orange has few.
 * 6. Rank by white-border score, not by pixel count, so the largest
 *    orange thing on screen isn't automatically chosen.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

interface Cand {
  cx: number;
  cy: number;
  pixels: number;
  bboxW: number;
  bboxH: number;
  whiteRing: number; // count of white pixels in the 5-px ring around bbox
}

function isCursorOrange(r: number, g: number, b: number): boolean {
  // The iPad pointer orange this user has configured is a saturated
  // bright orange. Empirically the icons that fail v1 (Books spine,
  // Files cover) have orange in the 180-240 R / 90-140 G / 30-80 B
  // band; the cursor sits at the saturated edge.
  if (r < 220) return false;
  if (g < 110 || g > 175) return false;
  if (b > 80) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return false;
  return (max - min) / max > 0.6;  // higher than v1's 0.5
}

function isWhite(r: number, g: number, b: number): boolean {
  // White border on the iOS cursor renders as near-white with low
  // saturation. Be tolerant — JPEG compression knocks the pure 255s
  // around.
  return r >= 220 && g >= 220 && b >= 220;
}

async function decode(p: string): Promise<{ rgb: Buffer; w: number; h: number }> {
  const { data, info } = await sharp(await fs.readFile(p))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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

function findCursorV2(
  rgb: Buffer,
  w: number,
  h: number,
  motion: Uint8Array | null,
): Cand | null {
  // Orange mask, optionally AND'd with motion.
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (motion && !motion[i]) continue;
    const o = i * 3;
    if (isCursorOrange(rgb[o], rgb[o + 1], rgb[o + 2])) mask[i] = 1;
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
        if (n < 0 || visited[n] || !mask[n]) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (pixels < 25 || pixels > 200) continue;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const aspect = bboxW / bboxH;
    if (aspect < 0.4 || aspect > 2.5) continue;
    const density = pixels / (bboxW * bboxH);
    if (density < 0.35) continue;

    // White-ring score: count white pixels in a 5-px ring around bbox.
    const ringSize = 5;
    const rMinX = Math.max(0, minX - ringSize);
    const rMaxX = Math.min(w - 1, maxX + ringSize);
    const rMinY = Math.max(0, minY - ringSize);
    const rMaxY = Math.min(h - 1, maxY + ringSize);
    let whiteRing = 0;
    for (let y = rMinY; y <= rMaxY; y++) {
      for (let x = rMinX; x <= rMaxX; x++) {
        // Skip interior (bbox itself)
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
        const o = (y * w + x) * 3;
        if (isWhite(rgb[o], rgb[o + 1], rgb[o + 2])) whiteRing++;
      }
    }

    candidates.push({
      cx: sumX / pixels,
      cy: sumY / pixels,
      pixels,
      bboxW,
      bboxH,
      whiteRing,
    });
  }

  if (candidates.length === 0) return null;
  // Rank by white-ring (the cursor's white halo is distinctive); tie-break by pixels.
  candidates.sort((a, b) => (b.whiteRing - a.whiteRing) || (b.pixels - a.pixels));
  return candidates[0];
}

// ===== Test against the 60 PA26 human labels =====
async function main() {
  // Load PA26 ground truth
  const humLines = (await fs.readFile('data/verify-pa26/human-verified.jsonl', 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  const humByPath = new Map<string, { x: number; y: number } | null>();
  for (const h of humLines) {
    const key = h.frame.split('/').slice(-2).join('/');
    if (h.cursor?.visible === false || h.decision === 'absent') {
      humByPath.set(key, null);
    } else if (h.cursor?.x != null) {
      humByPath.set(key, { x: h.cursor.x, y: h.cursor.y });
    }
  }

  // For each frame, run v2 (no motion mask since we have isolated frames)
  const benchDir = 'data/click-bench-prod';
  const targets = ['settings', 'books', 'appstore', 'files'];
  let total = 0, correct35 = 0, falsePositive = 0, missedCursor = 0;
  const perScene: Record<string, { n: number; correct: number; fp: number; miss: number }> = {};

  for (const t of targets) {
    const dir = path.join(benchDir, t);
    const files = (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.jpg'));
    for (const f of files) {
      const fullPath = path.join(dir, f);
      const dec = await decode(fullPath);
      const cand = findCursorV2(dec.rgb, dec.w, dec.h, null);
      const truth = humByPath.get(`${t}/${f}`);
      if (truth === undefined) continue;
      total++;
      const sceneCls = `${t}:${f.split('-')[1]?.replace('.jpg', '').toUpperCase()}`;
      perScene[sceneCls] ??= { n: 0, correct: 0, fp: 0, miss: 0 };
      perScene[sceneCls].n++;
      if (truth === null) {
        if (cand) { falsePositive++; perScene[sceneCls].fp++; }
        continue;
      }
      if (!cand) { missedCursor++; perScene[sceneCls].miss++; continue; }
      const d = Math.hypot(cand.cx - truth.x, cand.cy - truth.y);
      if (d <= 35) { correct35++; perScene[sceneCls].correct++; }
    }
  }

  console.log(`Total frames vs human labels: ${total}`);
  console.log(`v2 correct (≤35 px): ${correct35}/${total} = ${(100 * correct35 / total).toFixed(0)}%`);
  console.log(`v2 missed cursor:    ${missedCursor}/${total}`);
  console.log(`v2 FP on absent:     ${falsePositive}/${total}`);
  console.log();
  console.log('Per scene:');
  for (const [k, v] of Object.entries(perScene).sort()) {
    console.log(`  ${k.padEnd(20)} n=${v.n.toString().padStart(2)} correct=${v.correct} miss=${v.miss} fp=${v.fp}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
