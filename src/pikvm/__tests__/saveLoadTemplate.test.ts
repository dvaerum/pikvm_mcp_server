/**
 * Direct unit tests for saveCursorTemplate / loadCursorTemplate
 * round-trip. Used by template-set.ts; the per-template persistence
 * is the foundation of the multi-template cache.
 *
 * Coverage gaps before:
 * - No direct round-trip assertion (save → load → compare)
 * - No assertion that loadCursorTemplate returns null for missing
 *   files vs throws for other errors
 * - No assertion that saveCursorTemplate auto-creates parent dirs
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  saveCursorTemplate,
  loadCursorTemplate,
  type CursorTemplate,
} from '../cursor-detect.js';

function gradientTemplate(): CursorTemplate {
  // 24×24 with predictable RGB so a round-trip can be verified by
  // sampling a few pixels (not pixel-exact because JPEG encoding is
  // lossy at q=95).
  const w = 24, h = 24;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    buf[i * 3] = (x * 10) & 0xff;
    buf[i * 3 + 1] = (y * 10) & 0xff;
    buf[i * 3 + 2] = 128;
  }
  return { rgb: buf, width: w, height: h };
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pikvm-tpl-'));
}

describe('saveCursorTemplate / loadCursorTemplate round-trip', () => {
  it('saves to a file and loads back to the same dimensions', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'cursor.jpg');
      const original = gradientTemplate();
      await saveCursorTemplate(original, filePath);

      const loaded = await loadCursorTemplate(filePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.width).toBe(original.width);
      expect(loaded!.height).toBe(original.height);
      expect(loaded!.rgb.length).toBe(original.rgb.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loaded RGB approximates the original (q=95 JPEG, allow ±20 per channel)', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'cursor.jpg');
      const original = gradientTemplate();
      await saveCursorTemplate(original, filePath);
      const loaded = await loadCursorTemplate(filePath);
      expect(loaded).not.toBeNull();
      // Sample the centre pixel (12, 12) — gradient says R=120, G=120, B=128.
      const o = (12 * 24 + 12) * 3;
      expect(Math.abs(loaded!.rgb[o] - 120)).toBeLessThanOrEqual(20);
      expect(Math.abs(loaded!.rgb[o + 1] - 120)).toBeLessThanOrEqual(20);
      expect(Math.abs(loaded!.rgb[o + 2] - 128)).toBeLessThanOrEqual(20);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('saveCursorTemplate auto-creates the parent directory', async () => {
    const dir = await tempDir();
    try {
      // Write to a path with a non-existent parent dir.
      const filePath = path.join(dir, 'sub', 'dir', 'cursor.jpg');
      await saveCursorTemplate(gradientTemplate(), filePath);
      // Confirm the file exists.
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadCursorTemplate returns null when the file does not exist (ENOENT)', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'never-written.jpg');
      const loaded = await loadCursorTemplate(filePath);
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadCursorTemplate throws on non-ENOENT errors (e.g., directory instead of file)', async () => {
    const dir = await tempDir();
    try {
      // Pass a directory path — read should fail with EISDIR, not ENOENT.
      await expect(loadCursorTemplate(dir)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
