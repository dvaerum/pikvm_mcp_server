/**
 * Unit tests for saveSnapshot (src/pikvm/snapshot.ts, M5). Ground truth per the
 * field spec: the written file EXISTS and DECODES as a JPEG. Uses real JPEG
 * buffers via sharp + a temp dir — no PiKVM needed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { saveSnapshot } from '../snapshot.js';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => {})));
  made.length = 0;
});

async function jpeg(w: number, h: number, v = 128): Promise<Buffer> {
  return sharp(Buffer.alloc(w * h * 3, v), { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .toBuffer();
}

describe('saveSnapshot', () => {
  it('writes the frame to savePath and it decodes as a JPEG', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-'));
    made.push(dir);
    const buf = await jpeg(64, 48);
    const target = path.join(dir, 'nested', 'frame.jpg'); // parent dir doesn't exist yet

    const res = await saveSnapshot(buf, target);

    expect(res.path).toBe(path.resolve(target));
    expect(res.bytes).toBe(buf.length);
    const written = await fs.readFile(target);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
  });

  it('crops to region before writing (output dimensions == region)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-'));
    made.push(dir);
    const buf = await jpeg(100, 100);
    const target = path.join(dir, 'crop.jpg');

    await saveSnapshot(buf, target, { x: 10, y: 20, width: 30, height: 40 });

    const meta = await sharp(await fs.readFile(target)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(40);
  });

  it('rejects an empty savePath', async () => {
    await expect(saveSnapshot(await jpeg(8, 8), '')).rejects.toThrow(/savePath is required/);
  });
});
