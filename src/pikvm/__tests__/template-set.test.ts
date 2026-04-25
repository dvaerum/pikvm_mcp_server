/**
 * Tests for the multi-template cursor matching pipeline (Phase 3).
 *
 * Single-template detection is brittle across backdrops — the cached
 * template was captured against one wallpaper/icon panel, and once the
 * cursor moves over a different backdrop the NCC score drops below
 * threshold. The set-aware matcher iterates a list of templates and
 * picks the highest-scoring match's position, so we recover detection
 * across the contexts the cursor actually visits.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  CursorTemplate,
  decodeScreenshot,
  extractCursorTemplateDecoded,
  findCursorByTemplateSet,
} from '../cursor-detect.js';
import {
  TEMPLATE_SET_CAP,
  loadTemplateSet,
  persistTemplate,
  planAddition,
  templateSimilarity,
} from '../template-set.js';

function gradientTemplate(seed: number): CursorTemplate {
  const w = 24, h = 24;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    // Distinct per-seed gradient — guarantees low NCC between seeds
    // (templates of fundamentally different content).
    buf[i * 3] = (x * 7 + seed * 53) & 0xff;
    buf[i * 3 + 1] = (y * 11 + seed * 91) & 0xff;
    buf[i * 3 + 2] = ((x + y) * 5 + seed * 31) & 0xff;
  }
  return { rgb: buf, width: w, height: h };
}

async function makeFrame(width: number, height: number, fill: [number, number, number]): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function stamp(
  base: Buffer,
  cx: number,
  cy: number,
  size: number,
  colour: [number, number, number],
): Promise<Buffer> {
  const decoded = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(decoded.data);
  const w = decoded.info.width;
  const h = decoded.info.height;
  const half = Math.floor(size / 2);
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 3;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('findCursorByTemplateSet', () => {
  it('returns null for empty template list', async () => {
    const w = 100, h = 100;
    const screen = await decodeScreenshot(
      await stamp(await makeFrame(w, h, [50, 50, 50]), 50, 50, 7, [240, 240, 240]),
    );
    const r = findCursorByTemplateSet(screen, [], { minScore: 0.5 });
    expect(r).toBeNull();
  });

  it('finds the cursor using the only template provided (single-element set)', async () => {
    const w = 200, h = 200;
    const cursor: [number, number, number] = [240, 240, 240];
    const wallpaper: [number, number, number] = [50, 50, 50];

    // Capture the template from a known cursor location.
    const baseFrame = await decodeScreenshot(
      await stamp(await makeFrame(w, h, wallpaper), 100, 100, 7, cursor),
    );
    const template = extractCursorTemplateDecoded(baseFrame, { x: 100, y: 100 }, 24);

    // New screenshot has the cursor at (60, 80).
    const screen = await decodeScreenshot(
      await stamp(await makeFrame(w, h, wallpaper), 60, 80, 7, cursor),
    );

    const r = findCursorByTemplateSet(screen, [template], { minScore: 0.5 });
    expect(r).not.toBeNull();
    expect(Math.abs(r!.position.x - 60)).toBeLessThan(8);
    expect(Math.abs(r!.position.y - 80)).toBeLessThan(8);
  });

  it('picks the highest-scoring template across a set', async () => {
    // Two templates over different backdrops. The screen frame matches
    // template B's backdrop; template B should win.
    const w = 200, h = 200;
    const cursor: [number, number, number] = [240, 240, 240];
    const backdropA: [number, number, number] = [200, 100, 50];   // orange
    const backdropB: [number, number, number] = [50, 100, 200];   // blue

    const tplFrameA = await decodeScreenshot(
      await stamp(await makeFrame(w, h, backdropA), 100, 100, 7, cursor),
    );
    const templateA = extractCursorTemplateDecoded(tplFrameA, { x: 100, y: 100 }, 24);

    const tplFrameB = await decodeScreenshot(
      await stamp(await makeFrame(w, h, backdropB), 100, 100, 7, cursor),
    );
    const templateB = extractCursorTemplateDecoded(tplFrameB, { x: 100, y: 100 }, 24);

    // Search frame: cursor at (60, 80) on the blue backdrop.
    const screen = await decodeScreenshot(
      await stamp(await makeFrame(w, h, backdropB), 60, 80, 7, cursor),
    );

    const r = findCursorByTemplateSet(screen, [templateA, templateB], {
      minScore: 0.5,
      verbose: false,
    });
    expect(r).not.toBeNull();
    // Both templates would correlate near the cursor position; we just
    // assert that some position is returned and the winning template
    // index is reported (B = index 1) so callers can tell which one
    // matched.
    expect(Math.abs(r!.position.x - 60)).toBeLessThan(8);
    expect(Math.abs(r!.position.y - 80)).toBeLessThan(8);
    expect(r!.templateIndex).toBe(1);
  });

  it('reports the winning templateIndex even when scores are close', async () => {
    // Both templates would score similarly on the search frame; this
    // pins down the contract that the index points at whichever
    // template's score was strictly highest.
    const w = 200, h = 200;
    const cursor: [number, number, number] = [240, 240, 240];
    const wallpaper: [number, number, number] = [50, 50, 50];

    const tplFrame1 = await decodeScreenshot(
      await stamp(await makeFrame(w, h, wallpaper), 100, 100, 7, cursor),
    );
    const t1 = extractCursorTemplateDecoded(tplFrame1, { x: 100, y: 100 }, 24);
    const t2 = extractCursorTemplateDecoded(tplFrame1, { x: 100, y: 100 }, 24);

    const screen = await decodeScreenshot(
      await stamp(await makeFrame(w, h, wallpaper), 50, 50, 7, cursor),
    );

    const r = findCursorByTemplateSet(screen, [t1, t2], { minScore: 0.5, step: 1 });
    expect(r).not.toBeNull();
    // With identical templates, t1 (index 0) wins on tie-break.
    expect(r!.templateIndex).toBe(0);
  });

  it('falls below minScore when no template fits', async () => {
    const w = 200, h = 200;
    // Build a "template" of pure red — won't match a gray cursor frame.
    const tplFrame = await decodeScreenshot(
      await stamp(await makeFrame(w, h, [220, 50, 50]), 100, 100, 7, [255, 0, 0]),
    );
    const redTemplate = extractCursorTemplateDecoded(tplFrame, { x: 100, y: 100 }, 24);

    // Search frame is gray cursor on dark — completely different.
    const screen = await decodeScreenshot(
      await stamp(await makeFrame(w, h, [50, 50, 50]), 60, 80, 7, [240, 240, 240]),
    );

    const r = findCursorByTemplateSet(screen, [redTemplate], { minScore: 0.95 });
    // 0.95 is high enough that an all-red template against a gray
    // cursor on a dark background should fall below.
    expect(r).toBeNull();
  });
});

describe('templateSimilarity', () => {
  it('returns ~1 for identical templates', () => {
    const t = gradientTemplate(7);
    expect(templateSimilarity(t, t)).toBeGreaterThan(0.99);
  });

  it('returns < dedup threshold for distinct gradient seeds', () => {
    const a = gradientTemplate(0);
    const b = gradientTemplate(13);
    const sim = templateSimilarity(a, b);
    expect(sim).toBeLessThan(0.92); // TEMPLATE_DEDUP_NCC
  });
});

describe('planAddition (dedup + cap policy)', () => {
  it('grows the set when candidate is perceptually distinct', () => {
    const a = gradientTemplate(0);
    const b = gradientTemplate(7);
    const r = planAddition(b, [a]);
    expect(r.decision).toBe('added');
    expect(r.kept).toHaveLength(2);
  });

  it('treats a perceptually-similar candidate as duplicate', () => {
    const a = gradientTemplate(3);
    const r = planAddition(a, [a]);
    expect(r.decision).toBe('duplicate');
    expect(r.kept).toHaveLength(1);
  });

  it(`replaces oldest entry when the set is at the cap (${TEMPLATE_SET_CAP})`, () => {
    const existing = Array.from({ length: TEMPLATE_SET_CAP }, (_, i) => gradientTemplate(i + 1));
    const candidate = gradientTemplate(99); // distinct
    const r = planAddition(candidate, existing);
    expect(r.decision).toBe('replaced');
    expect(r.kept).toHaveLength(TEMPLATE_SET_CAP);
    // First slot dropped — i.e. seed 1 no longer present.
    expect(r.kept[0]).toBe(existing[1]);
    expect(r.kept[r.kept.length - 1]).toBe(candidate);
  });
});

describe('persistTemplate (disk-backed)', () => {
  async function tempDir(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'pikvm-tplset-'));
  }

  it('writes a new file and grows the on-disk set', async () => {
    const dir = await tempDir();
    try {
      const t1 = gradientTemplate(11);
      const r1 = await persistTemplate(dir, t1, []);
      expect(r1.decision).toBe('added');
      const loaded = await loadTemplateSet(dir);
      expect(loaded).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips writing when candidate is a duplicate', async () => {
    const dir = await tempDir();
    try {
      const t = gradientTemplate(11);
      await persistTemplate(dir, t, []);
      const before = await fs.readdir(dir);
      const r = await persistTemplate(dir, t, [t]);
      expect(r.decision).toBe('duplicate');
      const after = await fs.readdir(dir);
      expect(after.length).toBe(before.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
