/**
 * Phase 258 — unit tests for the shape-based cursor detector.
 *
 * Pin BOTH the pure shape-score helper (numeric expectations on
 * stable inputs) and the integration `findCursorByShape` against
 * synthetic frames + the existing Phase 251 trial frames.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { findCursorByShape, shapeScoreFor } from '../cursor-shape-detect.js';

function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..');
}

describe('shapeScoreFor', () => {
  it('peaks for cursor-sized asymmetric off-centre clusters', () => {
    // Real iPad cursor: ~80 px, asymmetry ~2-3, centroid offset ~3-8 px,
    // aspect ratio ~0.8-1.2. Should score well above noise.
    const cursorScore = shapeScoreFor(80, 2.5, 5, 0.9);
    expect(cursorScore).toBeGreaterThan(0.8);
  });

  it('penalises clusters far from cursor size', () => {
    const tiny = shapeScoreFor(15, 2.5, 5, 0.9);
    const huge = shapeScoreFor(250, 2.5, 5, 0.9);
    const cursor = shapeScoreFor(80, 2.5, 5, 0.9);
    expect(tiny).toBeLessThan(cursor / 4);
    expect(huge).toBeLessThan(cursor / 4);
  });

  it('caps asymmetry contribution to prevent tiny-blob runaway', () => {
    // A 15-px noise blob with all mass in one quadrant has asymmetry → ∞.
    // Cap prevents that from beating a cursor-sized 80 px candidate.
    const noise = shapeScoreFor(15, 1000, 0, 1.0);
    const cursor = shapeScoreFor(80, 2.5, 5, 0.9);
    expect(noise).toBeLessThan(cursor);
  });

  it('penalises elongated bboxes (aspect ratio far from 1.0)', () => {
    const square = shapeScoreFor(80, 2.5, 5, 1.0);
    const elongated = shapeScoreFor(80, 2.5, 5, 3.0);
    expect(elongated).toBeLessThan(square / 2);
  });

  it('symmetric blob (zero asymmetry, zero offset) scores low even at perfect size', () => {
    const symmetric = shapeScoreFor(80, 1.0, 0, 1.0);
    const cursorlike = shapeScoreFor(80, 2.5, 5, 1.0);
    expect(symmetric).toBeLessThan(cursorlike);
  });
});

describe('findCursorByShape — synthetic frames', () => {
  /** Build a 200x200 white frame with a synthetic cursor blob at (cx, cy). */
  async function frameWithCursor(cx: number, cy: number, radius = 6): Promise<Buffer> {
    const w = 200, h = 200;
    const rgb = Buffer.alloc(w * h * 3, 240); // light gray background (not dark)
    // Asymmetric arrow-ish blob: filled triangle with tip at (cx, cy)
    for (let dy = 0; dy < radius * 2; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      const lineWidth = Math.max(1, radius * 2 - dy);
      for (let dx = 0; dx < lineWidth; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= w) continue;
        const o = (y * w + x) * 3;
        rgb[o] = 30;     // dark
        rgb[o + 1] = 30;
        rgb[o + 2] = 30;
      }
    }
    return rgb;
  }

  it('finds a synthetic dark blob', async () => {
    const rgb = await frameWithCursor(100, 100);
    const r = findCursorByShape(rgb, 200, 200);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.centroidX - 100)).toBeLessThan(15);
    expect(Math.abs(r!.centroidY - 100)).toBeLessThan(15);
  });

  it('returns null when no cluster passes the dark threshold', async () => {
    const w = 200, h = 200;
    const rgb = Buffer.alloc(w * h * 3, 240); // uniformly light
    const r = findCursorByShape(rgb, w, h);
    expect(r).toBeNull();
  });

  it('locality gate rejects when no candidate falls within radius', async () => {
    const rgb = await frameWithCursor(150, 150);
    const r = findCursorByShape(rgb, 200, 200, {
      expectedNear: { x: 30, y: 30 },
      expectedNearRadius: 50, // cursor at (150,150) is far outside this
    });
    expect(r).toBeNull();
  });

  it('locality gate accepts when candidate is within radius', async () => {
    const rgb = await frameWithCursor(150, 150);
    const r = findCursorByShape(rgb, 200, 200, {
      expectedNear: { x: 145, y: 145 },
      expectedNearRadius: 30,
    });
    expect(r).not.toBeNull();
    expect(Math.abs(r!.centroidX - 150)).toBeLessThan(15);
  });

  it('cluster-bbox-aware scoring penalises thin elongated strokes (clock-hand)', async () => {
    // Phase 290: builds a frame with two clusters of similar pixel count.
    // (A) compact cursor-like blob (~80 px, square-ish bbox)
    // (B) thin elongated stroke (~80 px, narrow 3×30 bbox — like a
    // clock hand)
    // With cluster-bbox-aware features the elongated stroke must score
    // lower than the compact blob. Before Phase 290 the fixed 25-px
    // rescan inflated the stroke's bbox to ~50×51 and gave it a square
    // aspect ratio, letting it match cursor scores.
    const w = 300, h = 300;
    const rgb = Buffer.alloc(w * h * 3, 240);
    // Compact arrow at (80, 80): asymmetric triangle ~12×12 bbox, ~78 px
    for (let dy = 0; dy < 12; dy++) {
      const ly = 80 + dy;
      const lineW = Math.max(1, 12 - dy);
      for (let dx = 0; dx < lineW; dx++) {
        const o = (ly * w + (80 + dx)) * 3;
        rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
      }
    }
    // Thin stroke at (220, 100): 3×27 vertical bar, ~81 px solid
    for (let dy = 0; dy < 27; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        const o = ((100 + dy) * w + (220 + dx)) * 3;
        rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
      }
    }
    const candsCompact = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 85, y: 85 }, expectedNearRadius: 30,
    });
    const candsStroke = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 221, y: 115 }, expectedNearRadius: 30,
    });
    expect(candsCompact).not.toBeNull();
    expect(candsStroke).not.toBeNull();
    expect(candsCompact!.shapeScore).toBeGreaterThan(candsStroke!.shapeScore * 2);
  });

  it('locality gate disambiguates when there are MULTIPLE dark blobs', async () => {
    // Two cursor-like blobs in the frame — locality gate picks the
    // one near the hint.
    const w = 200, h = 200;
    const rgb = Buffer.alloc(w * h * 3, 240);
    // Blob A at (50, 50)
    for (let dy = 0; dy < 12; dy++)
      for (let dx = 0; dx < 12; dx++) {
        const o = ((50 + dy) * w + (50 + dx)) * 3;
        rgb[o] = 30; rgb[o + 1] = 30; rgb[o + 2] = 30;
      }
    // Blob B at (150, 150)
    for (let dy = 0; dy < 12; dy++)
      for (let dx = 0; dx < 12; dx++) {
        const o = ((150 + dy) * w + (150 + dx)) * 3;
        rgb[o] = 30; rgb[o + 1] = 30; rgb[o + 2] = 30;
      }
    // Hint near A → expect candidate near A.
    const ra = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 55, y: 55 },
      expectedNearRadius: 30,
    });
    expect(ra).not.toBeNull();
    expect(ra!.centroidX).toBeLessThan(75);
    expect(ra!.centroidY).toBeLessThan(75);
    // Hint near B → expect candidate near B.
    const rb = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 155, y: 155 },
      expectedNearRadius: 30,
    });
    expect(rb).not.toBeNull();
    expect(rb!.centroidX).toBeGreaterThan(125);
    expect(rb!.centroidY).toBeGreaterThan(125);
  });
});

describe('findCursorByShape — Phase 251 saved frames', () => {
  // The Phase 251 frames are real iPad home-screen captures with the
  // cursor visually verified at (~1063, 778). NCC failed on every
  // template against these (max top-1 = 0.819 < 0.83 minScore).
  // Phase 258 acceptance: shape detector + locality gate must pick
  // a candidate within 30 px of (1063, 778) for ALL 5 trials.
  const FRAMES = [1, 2, 3, 4, 5];
  const EXPECTED = { x: 1063, y: 778 };

  for (const t of FRAMES) {
    it(`picks the cursor on trial${t}.jpg with hint`, async () => {
      const buf = await fs.readFile(
        path.join(repoRoot(), 'data', 'phase251-topk', `trial${t}.jpg`),
      );
      const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const r = findCursorByShape(data, info.width, info.height, {
        expectedNear: EXPECTED,
        expectedNearRadius: 200,
      });
      expect(r, `trial${t}.jpg should yield a candidate`).not.toBeNull();
      const dist = Math.hypot(r!.centroidX - EXPECTED.x, r!.centroidY - EXPECTED.y);
      expect(dist, `trial${t}.jpg dist ${dist.toFixed(0)} px`).toBeLessThan(30);
    });
  }

  it('returns null on bad hint far from real cursor', async () => {
    const buf = await fs.readFile(path.join(repoRoot(), 'data', 'phase251-topk', 'trial1.jpg'));
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const r = findCursorByShape(data, info.width, info.height, {
      expectedNear: { x: 200, y: 200 },
      expectedNearRadius: 100,
    });
    expect(r).toBeNull();
  });
});

describe('Phase 307 — co-linearity penalty for text-row siblings', () => {
  it('penalises a candidate with 3 co-linear similar-sized siblings', async () => {
    // Build a frame with FOUR cursor-sized asymmetric blobs all at the
    // same Y, spaced 60-80 px apart horizontally — a "word" of letters.
    // Each individual blob looks like a cursor on its own, but the
    // co-linearity context tells us it's text. Phase 307 should
    // downrank each.
    const w = 600, h = 200;
    const rgb = Buffer.alloc(w * h * 3, 240);
    function placeBlob(cx: number, cy: number) {
      for (let dy = 0; dy < 12; dy++) {
        const lineW = Math.max(1, 12 - dy);
        for (let dx = 0; dx < lineW; dx++) {
          const o = ((cy + dy) * w + (cx + dx)) * 3;
          rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
        }
      }
    }
    // Word "Text" — 4 blobs at the same Y
    placeBlob(100, 100);
    placeBlob(170, 100);
    placeBlob(240, 100);
    placeBlob(310, 100);
    // Isolated cursor at (500, 50) — same shape, no co-linear siblings
    placeBlob(500, 50);

    // Look at all candidates by querying both regions.
    const textCand = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 105, y: 105 },
      expectedNearRadius: 30,
    });
    const isoCand = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 505, y: 55 },
      expectedNearRadius: 30,
    });
    expect(textCand).not.toBeNull();
    expect(isoCand).not.toBeNull();
    // Isolated cursor must outscore the text-row member by at least 3x.
    // Pre-Phase-307: both scored identically (~same shape). Post-Phase-307:
    // text member has 3 co-linear siblings → exp(-3/1.5) = 0.135 penalty,
    // isolated has 0 siblings → 1.0.
    expect(isoCand!.shapeScore).toBeGreaterThan(textCand!.shapeScore * 3);
  });

  it('does not penalise isolated cursors', async () => {
    // A single asymmetric blob with no neighbors — full score retained.
    const w = 200, h = 200;
    const rgb = Buffer.alloc(w * h * 3, 240);
    for (let dy = 0; dy < 12; dy++) {
      const lineW = Math.max(1, 12 - dy);
      for (let dx = 0; dx < lineW; dx++) {
        const o = ((100 + dy) * w + (100 + dx)) * 3;
        rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
      }
    }
    const r = findCursorByShape(rgb, w, h);
    expect(r).not.toBeNull();
    // Isolated asymmetric blob should produce a high score.
    expect(r!.shapeScore).toBeGreaterThan(0.8);
  });

  it('does not penalise vertically-stacked candidates (only horizontal rows)', async () => {
    // 4 blobs in a VERTICAL column. Vertical stacking is NOT a text-row
    // pattern (text is horizontal). Penalty should not fire.
    const w = 200, h = 600;
    const rgb = Buffer.alloc(w * h * 3, 240);
    function placeBlob(cx: number, cy: number) {
      for (let dy = 0; dy < 12; dy++) {
        const lineW = Math.max(1, 12 - dy);
        for (let dx = 0; dx < lineW; dx++) {
          const o = ((cy + dy) * w + (cx + dx)) * 3;
          rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
        }
      }
    }
    placeBlob(100, 100);
    placeBlob(100, 200);
    placeBlob(100, 300);
    placeBlob(100, 400);
    // Vertical stack — Y differs by 100 per blob, so dy>15 for every
    // pair. No co-linear neighbors. No penalty fired.
    const r = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 100, y: 100 },
      expectedNearRadius: 20,
    });
    expect(r).not.toBeNull();
    expect(r!.shapeScore).toBeGreaterThan(0.8);
  });

  it('does not penalise widely-spaced co-linear candidates (>300 px apart)', async () => {
    // Cursor + a single far-away cluster on the same Y, but 400 px apart
    // — out of letter-spacing range. No penalty.
    const w = 800, h = 200;
    const rgb = Buffer.alloc(w * h * 3, 240);
    function placeBlob(cx: number, cy: number) {
      for (let dy = 0; dy < 12; dy++) {
        const lineW = Math.max(1, 12 - dy);
        for (let dx = 0; dx < lineW; dx++) {
          const o = ((cy + dy) * w + (cx + dx)) * 3;
          rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
        }
      }
    }
    placeBlob(100, 100);
    placeBlob(600, 100); // 500 px away — out of range (max 300)
    const r = findCursorByShape(rgb, w, h, {
      expectedNear: { x: 105, y: 105 },
      expectedNearRadius: 20,
    });
    expect(r).not.toBeNull();
    expect(r!.shapeScore).toBeGreaterThan(0.8);
  });
});
