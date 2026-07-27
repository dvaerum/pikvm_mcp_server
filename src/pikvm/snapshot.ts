/**
 * Save a PiKVM video-frame JPEG to a file (M5). Backs `pikvm_snapshot` and the
 * `savePath` option on `pikvm_screenshot`. Kept out of index.ts so the crop +
 * write is unit-testable without a live PiKVM (ground truth: the file exists and
 * decodes as a JPEG).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** An axis-aligned crop region in screenshot pixels. */
export interface SnapshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Optionally crop `buffer` to `region`, then write it to `savePath` (creating
 * parent directories). Returns the resolved absolute path + byte count.
 *
 * The write target is whatever the caller passes — under the hardened systemd
 * service the process can only write within its StateDirectory / PrivateTmp, so
 * absolute paths outside those will EACCES; the local (tsx) path is unrestricted.
 */
export async function saveSnapshot(
  buffer: Buffer,
  savePath: string,
  region?: SnapshotRegion,
): Promise<{ path: string; bytes: number }> {
  if (!savePath || savePath.trim() === '') {
    throw new Error('saveSnapshot: savePath is required');
  }
  let out = buffer;
  if (region) {
    out = await sharp(buffer)
      .extract({
        left: Math.max(0, Math.round(region.x)),
        top: Math.max(0, Math.round(region.y)),
        width: Math.round(region.width),
        height: Math.round(region.height),
      })
      .jpeg()
      .toBuffer();
  }
  const resolved = path.resolve(savePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, out);
  return { path: resolved, bytes: out.length };
}
