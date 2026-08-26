/**
 * M8 capture-phase unit tests. Ground truth: with a mock client + real temp
 * dir, the requested phases produce exactly the expected files, the "during"
 * phase goes through the cursor-alive path, un-requested phases cost zero
 * screenshots, and the shared parse/validate rejects malformed requests.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginCapture,
  capturePhase,
  capturePhaseAdvisory,
  cursorAliveGrab,
  parseCaptureConfig,
  type CaptureClient,
  type CaptureConfig,
} from '../capture.js';

// A 2×2 red JPEG is enough for saveSnapshot to write + (optionally) crop.
// Built once via sharp so the bytes are a real decodable JPEG.
import sharp from 'sharp';

let jpeg: Buffer;
beforeEach(async () => {
  jpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
});

function makeClient(): CaptureClient & {
  screenshot: ReturnType<typeof vi.fn>;
  screenshotKeepingCursorAlive: ReturnType<typeof vi.fn>;
} {
  return {
    screenshot: vi.fn(async () => ({ buffer: jpeg })),
    screenshotKeepingCursorAlive: vi.fn(async () => ({ buffer: jpeg })),
  };
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm8-capture-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('cursorAliveGrab', () => {
  it('prefers screenshotKeepingCursorAlive', async () => {
    const client = makeClient();
    await cursorAliveGrab(client);
    expect(client.screenshotKeepingCursorAlive).toHaveBeenCalledTimes(1);
    expect(client.screenshot).not.toHaveBeenCalled();
  });

  it('falls back to a plain screenshot when the client lacks the cursor-alive method', async () => {
    const plain = { screenshot: vi.fn(async () => ({ buffer: jpeg })) };
    await cursorAliveGrab(plain);
    expect(plain.screenshot).toHaveBeenCalledTimes(1);
  });
});

describe('capturePhase', () => {
  it('writes ${prefix}-${phase}.jpg for a requested phase', async () => {
    const client = makeClient();
    const prefix = path.join(tmpDir, 'shot');
    const config: CaptureConfig = { phases: ['before'], prefix };
    const saved = await capturePhase(client, config, 'before');
    expect(saved).not.toBeNull();
    expect(saved!.path).toBe(path.resolve(`${prefix}-before.jpg`));
    expect(saved!.bytes).toBeGreaterThan(0);
    // File actually exists on disk.
    await expect(fs.stat(saved!.path)).resolves.toBeTruthy();
  });

  it('returns null and takes ZERO screenshots for a phase not requested', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['before'], prefix: path.join(tmpDir, 's') };
    const saved = await capturePhase(client, config, 'after');
    expect(saved).toBeNull();
    expect(client.screenshot).not.toHaveBeenCalled();
    expect(client.screenshotKeepingCursorAlive).not.toHaveBeenCalled();
  });

  it('"during" goes through the cursor-alive path, NOT a plain screenshot', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['during'], prefix: path.join(tmpDir, 's') };
    await capturePhase(client, config, 'during');
    expect(client.screenshotKeepingCursorAlive).toHaveBeenCalledTimes(1);
    expect(client.screenshot).not.toHaveBeenCalled();
  });

  it('"before"/"after" use a plain screenshot, NOT the cursor-alive nudge', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['before', 'after'], prefix: path.join(tmpDir, 's') };
    await capturePhase(client, config, 'before');
    await capturePhase(client, config, 'after');
    expect(client.screenshot).toHaveBeenCalledTimes(2);
    expect(client.screenshotKeepingCursorAlive).not.toHaveBeenCalled();
  });

  it('reuses a providedBuffer instead of grabbing a new frame', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['after'], prefix: path.join(tmpDir, 's') };
    const saved = await capturePhase(client, config, 'after', jpeg);
    expect(saved).not.toBeNull();
    expect(client.screenshot).not.toHaveBeenCalled();
    expect(client.screenshotKeepingCursorAlive).not.toHaveBeenCalled();
  });

  it('applies captureRegion as a crop (smaller frame than full)', async () => {
    const client = makeClient();
    const config: CaptureConfig = {
      phases: ['before'],
      prefix: path.join(tmpDir, 's'),
      region: { x: 0, y: 0, width: 2, height: 2 },
    };
    const saved = await capturePhase(client, config, 'before');
    const meta = await sharp(saved!.path).metadata();
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
  });
});

describe('capturePhaseAdvisory', () => {
  it('swallows a capture failure and returns null (never breaks the op)', async () => {
    const boom: CaptureClient = {
      screenshot: vi.fn(async () => {
        throw new Error('streamer 503');
      }),
    };
    const config: CaptureConfig = { phases: ['before'], prefix: path.join(tmpDir, 's') };
    const saved = await capturePhaseAdvisory(boom, config, 'before');
    expect(saved).toBeNull();
  });
});

describe('parseCaptureConfig', () => {
  it('returns undefined when capture is absent (OFF)', () => {
    expect(parseCaptureConfig({})).toBeUndefined();
    expect(parseCaptureConfig({ capture: undefined })).toBeUndefined();
    expect(parseCaptureConfig({ capture: null })).toBeUndefined();
  });

  it('returns undefined for an empty array (OFF, zero behavior change)', () => {
    expect(parseCaptureConfig({ capture: [] })).toBeUndefined();
  });

  it('parses phases + prefix + region', () => {
    const cfg = parseCaptureConfig({
      capture: ['before', 'during', 'after'],
      capturePrefix: '/tmp/run',
      captureRegion: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(cfg).toEqual({
      phases: ['before', 'during', 'after'],
      prefix: '/tmp/run',
      region: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it('de-duplicates phases while preserving order', () => {
    const cfg = parseCaptureConfig({
      capture: ['after', 'before', 'after', 'before'],
      capturePrefix: '/tmp/run',
    });
    expect(cfg!.phases).toEqual(['after', 'before']);
  });

  it('THROWS when capturePrefix is missing but phases are requested', () => {
    expect(() => parseCaptureConfig({ capture: ['during'] })).toThrow(/capturePrefix is required/);
    expect(() => parseCaptureConfig({ capture: ['during'], capturePrefix: '   ' })).toThrow(
      /capturePrefix is required/,
    );
  });

  it('THROWS on an unknown phase name', () => {
    expect(() => parseCaptureConfig({ capture: ['midtap'], capturePrefix: '/t/x' })).toThrow(
      /before.*during.*after/,
    );
  });

  it('THROWS on a non-array capture', () => {
    expect(() => parseCaptureConfig({ capture: 'during', capturePrefix: '/t/x' })).toThrow(
      /must be an array/,
    );
  });

  it('THROWS on a non-numeric captureRegion field', () => {
    expect(() =>
      parseCaptureConfig({
        capture: ['before'],
        capturePrefix: '/t/x',
        captureRegion: { x: 0, y: 0, width: 'wide', height: 4 },
      }),
    ).toThrow(/captureRegion\.width/);
  });
});

describe('beginCapture / CaptureSession (F12, Round 2 Phase 5b)', () => {
  it('is a true no-op when config is undefined (capture off): zero screenshots, empty lines', async () => {
    const client = makeClient();
    const session = beginCapture(client, undefined);
    await session.before();
    await session.during();
    await session.after();
    expect(client.screenshot).not.toHaveBeenCalled();
    expect(client.screenshotKeepingCursorAlive).not.toHaveBeenCalled();
    expect(session.entries).toEqual([]);
    expect(session.lines()).toBe('');
  });

  it('accumulates before/during/after into entries and formats them via lines()', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['before', 'during', 'after'], prefix: path.join(tmpDir, 's') };
    const session = beginCapture(client, config);
    await session.before();
    await session.during();
    await session.after();
    expect(session.entries).toHaveLength(3);
    expect(session.entries.every((e) => e !== null)).toBe(true);
    expect(session.lines()).toContain('Capture:');
    expect(session.lines()).toContain('before:');
    expect(session.lines()).toContain('during:');
    expect(session.lines()).toContain('after:');
  });

  it('after(providedBuffer) reuses the given buffer instead of grabbing a new frame', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['after'], prefix: path.join(tmpDir, 's') };
    const session = beginCapture(client, config);
    await session.after(jpeg);
    expect(client.screenshot).not.toHaveBeenCalled();
    expect(client.screenshotKeepingCursorAlive).not.toHaveBeenCalled();
    expect(session.entries).toHaveLength(1);
  });

  it('a phase not in config.phases records a null entry (matches capturePhase\'s own contract)', async () => {
    const client = makeClient();
    const config: CaptureConfig = { phases: ['before'], prefix: path.join(tmpDir, 's') };
    const session = beginCapture(client, config);
    await session.after(); // 'after' not requested
    expect(session.entries).toEqual([null]);
    expect(session.lines()).toBe('');
  });
});
