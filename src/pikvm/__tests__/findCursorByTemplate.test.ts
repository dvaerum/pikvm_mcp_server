/**
 * Direct unit tests for findCursorByTemplateDecoded. Previously
 * exercised only via findCursorByTemplateSet; the single-template
 * variant's own contracts — search window, minScore threshold,
 * step granularity — weren't directly pinned.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  decodeScreenshot,
  extractCursorTemplateDecoded,
  findCursorByTemplateDecoded,
} from '../cursor-detect.js';

async function frame(
  width: number,
  height: number,
  fill: (i: number) => [number, number, number],
): Promise<Buffer> {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = fill(i);
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('findCursorByTemplateDecoded', () => {
  it('finds the cursor when the template was captured from the same screen', async () => {
    // Build a screen with cursor at (100, 100) and capture a template there.
    const w = 200, h = 200;
    const cursor: [number, number, number] = [240, 240, 240];
    const wallpaper: [number, number, number] = [40, 40, 40];

    const screenshot = await decodeScreenshot(
      await frame(w, h, (i) => {
        const x = i % w, y = Math.floor(i / w);
        const inCursor = Math.abs(x - 100) <= 3 && Math.abs(y - 100) <= 3;
        return inCursor ? cursor : wallpaper;
      }),
    );
    const template = extractCursorTemplateDecoded(screenshot, { x: 100, y: 100 }, 24);

    // Search the same screenshot — should find at (100, 100) with high score.
    const r = findCursorByTemplateDecoded(screenshot, template, { minScore: 0.5, step: 1 });
    expect(r).not.toBeNull();
    expect(Math.abs(r!.position.x - 100)).toBeLessThan(4);
    expect(Math.abs(r!.position.y - 100)).toBeLessThan(4);
    expect(r!.score).toBeGreaterThan(0.95);
  });

  it('returns null when the score falls below minScore', async () => {
    // Template = pure red, screenshot = pure gray cursor on dark wallpaper.
    const w = 200, h = 200;
    const tplFrame = await decodeScreenshot(
      await frame(w, h, () => [220, 50, 50]),
    );
    const redTemplate = extractCursorTemplateDecoded(tplFrame, { x: 100, y: 100 }, 24);

    const screen = await decodeScreenshot(
      await frame(w, h, (i) => {
        const x = i % w, y = Math.floor(i / w);
        const inCursor = Math.abs(x - 60) <= 3 && Math.abs(y - 80) <= 3;
        return inCursor ? [240, 240, 240] : [40, 40, 40];
      }),
    );

    const r = findCursorByTemplateDecoded(screen, redTemplate, { minScore: 0.95 });
    expect(r).toBeNull();
  });

  it('honours searchCentre + searchWindow to constrain the search', async () => {
    // Two cursor-like blobs at (50, 50) and (150, 50). Search only around
    // (50, 50) → must find that one.
    const w = 200, h = 100;
    const cursor: [number, number, number] = [240, 240, 240];
    const wallpaper: [number, number, number] = [40, 40, 40];
    const screenshot = await decodeScreenshot(
      await frame(w, h, (i) => {
        const x = i % w, y = Math.floor(i / w);
        const inA = Math.abs(x - 50) <= 3 && Math.abs(y - 50) <= 3;
        const inB = Math.abs(x - 150) <= 3 && Math.abs(y - 50) <= 3;
        return inA || inB ? cursor : wallpaper;
      }),
    );
    const template = extractCursorTemplateDecoded(screenshot, { x: 50, y: 50 }, 24);

    const r = findCursorByTemplateDecoded(screenshot, template, {
      searchCentre: { x: 50, y: 50 },
      searchWindow: 20,
      minScore: 0.5,
      step: 1,
    });
    expect(r).not.toBeNull();
    expect(Math.abs(r!.position.x - 50)).toBeLessThan(8);
    // Confirm the search did NOT pick up the (150, 50) blob.
    expect(r!.position.x).toBeLessThan(100);
  });

  it('uses default step=4 when no step option is supplied', async () => {
    // step=4 and step=1 should both find a clear cursor; the test just
    // documents that the default works (and that finer step is more accurate).
    const w = 200, h = 200;
    const cursor: [number, number, number] = [240, 240, 240];
    const wallpaper: [number, number, number] = [40, 40, 40];
    const screenshot = await decodeScreenshot(
      await frame(w, h, (i) => {
        const x = i % w, y = Math.floor(i / w);
        const inCursor = Math.abs(x - 100) <= 3 && Math.abs(y - 100) <= 3;
        return inCursor ? cursor : wallpaper;
      }),
    );
    const template = extractCursorTemplateDecoded(screenshot, { x: 100, y: 100 }, 24);

    const rDefault = findCursorByTemplateDecoded(screenshot, template, { minScore: 0.5 });
    expect(rDefault).not.toBeNull();
    // With step=4 the centre-of-template alignment can be off by up to 4 px.
    expect(Math.abs(rDefault!.position.x - 100)).toBeLessThanOrEqual(8);
  });
});
