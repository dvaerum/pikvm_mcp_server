/**
 * Direct round-trip tests for saveProfile / loadProfile. The legacy
 * data/ballistics.json file is what `moveToPixel` reads at startup
 * (via test-client.ts at minimum) — silently misreading or
 * misformatting it would route every call through the wrong default
 * ratios with no obvious symptom.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { saveProfile, loadProfile } from '../ballistics.js';
import type { BallisticsProfile } from '../ballistics.js';

function sampleProfile(): BallisticsProfile {
  return {
    version: 1,
    createdAt: '2026-04-26T00:00:00.000Z',
    resolution: { width: 1920, height: 1080 },
    samples: [
      {
        axis: 'x',
        magnitude: 20,
        pace: 'slow',
        callCount: 5,
        mickeysEmitted: 100,
        pixelsMeasured: 300,
        pxPerMickey: 3.0,
        rep: 1,
      } as unknown as BallisticsProfile['samples'][number],
    ],
    medians: {
      'x:slow:20': 3.0,
      'y:slow:40': 3.7,
    },
  };
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'pikvm-prof-'));
}

describe('saveProfile / loadProfile round-trip', () => {
  it('writes JSON and reads it back identical', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'ballistics.json');
      const original = sampleProfile();
      await saveProfile(original, filePath);
      const loaded = await loadProfile(filePath);
      expect(loaded).toEqual(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('saveProfile auto-creates parent directory', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'sub', 'dir', 'ballistics.json');
      await saveProfile(sampleProfile(), filePath);
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadProfile returns null on ENOENT (missing file is the legitimate first-run case)', async () => {
    const dir = await tempDir();
    try {
      const loaded = await loadProfile(path.join(dir, 'never-written.json'));
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadProfile throws on unsupported version', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'bad-version.json');
      await fs.writeFile(filePath, JSON.stringify({ version: 99 }), 'utf8');
      await expect(loadProfile(filePath)).rejects.toThrow(/version: 99/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadProfile throws on non-JSON content', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'corrupt.json');
      await fs.writeFile(filePath, 'this is not JSON', 'utf8');
      await expect(loadProfile(filePath)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('saveProfile writes pretty-printed (multi-line) JSON for diffability', async () => {
    const dir = await tempDir();
    try {
      const filePath = path.join(dir, 'ballistics.json');
      await saveProfile(sampleProfile(), filePath);
      const raw = await fs.readFile(filePath, 'utf8');
      // Must contain newlines + indentation. A single-line minified JSON
      // would be a regression — diffs become impossible to read.
      expect(raw).toContain('\n');
      expect(raw.split('\n').length).toBeGreaterThan(5);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
