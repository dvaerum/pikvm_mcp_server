/**
 * Reusable relative-mouse HID gestures.
 *
 * The "emit a total displacement as a train of ≤chunk-magnitude relative
 * deltas, optionally paced" pattern was hand-inlined in several places —
 * move-to's correction/open-loop emits and ipad-unlock's positioning + swipe
 * loops. This module is the single home for that primitive so the loop lives
 * once and every caller shares the same clamping/pacing/sign handling.
 */
import { PiKVMClient } from './client.js';
import { sleep } from './util.js';

/**
 * Emit `(totalX, totalY)` relative mickeys as a sequence of per-call deltas each
 * no larger than `chunkMag` in magnitude, sleeping `chunkPaceMs` between calls
 * (but not after the final call). Sign of the total is preserved per axis; a
 * zero axis emits nothing on that axis. Returns the number of emit calls made.
 */
export async function emitChunked(
  client: PiKVMClient,
  totalX: number,
  totalY: number,
  chunkMag: number,
  chunkPaceMs: number,
): Promise<number> {
  let remX = Math.abs(totalX);
  let remY = Math.abs(totalY);
  const sx = Math.sign(totalX);
  const sy = Math.sign(totalY);
  let chunks = 0;
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(chunkMag, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(chunkMag, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    chunks++;
    if (chunkPaceMs > 0 && (remX > 0 || remY > 0)) await sleep(chunkPaceMs);
  }
  return chunks;
}
