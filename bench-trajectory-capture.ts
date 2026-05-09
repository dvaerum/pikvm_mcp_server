/**
 * Phase 192 — frame-by-frame cursor trajectory capture (v2).
 *
 * Three sub-trajectories, each ~6 chunks, fast screenshot cadence,
 * smaller per-chunk emits so the cursor stays visible across the
 * whole capture rather than vanishing at an edge after 2 chunks.
 *
 * Outputs to ./data/trajectory-frames/{T1,T2,T3}/NN-label.jpg.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/trajectory-frames';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

async function snap(dir: string, idx: number, label: string): Promise<void> {
  // Tighter wait: 80 ms is enough for the streamer to push the next
  // frame to /api/streamer/snapshot in most cases. Phase 13 measured
  // 150-235 ms upper bound; we accept the chance of catching a frame
  // mid-render in exchange for tighter trajectory sampling.
  await new Promise(r => setTimeout(r, 80));
  const shot = await client.screenshot({ quality: 75 });
  const file = path.join(ROOT, dir, `${idx.toString().padStart(2, '0')}-${label}.jpg`);
  await fs.writeFile(file, shot.buffer);
}

async function wakeup(): Promise<void> {
  // Single +30/-30 round-trip nudge so cursor is rendered for the
  // baseline frame.
  await client.mouseMoveRelative(30, 0);
  await new Promise(r => setTimeout(r, 80));
  await client.mouseMoveRelative(-30, 0);
  await new Promise(r => setTimeout(r, 250));
}

async function trajectory(
  name: string,
  dx: number,
  dy: number,
  chunks: number,
  paceMs: number,
): Promise<void> {
  const dir = name;
  await fs.mkdir(path.join(ROOT, dir), { recursive: true });
  console.error(`\n=== ${name}: ${chunks} chunks of (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy}) @ ${paceMs}ms ===`);

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 1000));
  await wakeup();
  await snap(dir, 0, 'start');
  console.error(`  saved 00-start.jpg`);

  for (let i = 1; i <= chunks; i++) {
    await client.mouseMoveRelative(dx, dy);
    await new Promise(r => setTimeout(r, paceMs - 80)); // -80 because snap waits 80
    await snap(dir, i, `c${i}`);
    console.error(`  saved ${i.toString().padStart(2, '0')}-c${i}.jpg`);
  }

  // Final settle frame to show post-acceleration resting position.
  await new Promise(r => setTimeout(r, 400));
  await snap(dir, chunks + 1, 'settle');
  console.error(`  saved ${(chunks + 1).toString().padStart(2, '0')}-settle.jpg`);
}

async function main(): Promise<void> {
  // T1: pure horizontal eastward, small chunks. Tests linearity along X.
  await trajectory('T1-eastward', 15, 0, 6, 120);

  // T2: pure vertical southward, small chunks. Tests linearity along Y.
  await trajectory('T2-southward', 0, 15, 6, 120);

  // T3: edge-approach northwest. Cursor is somewhere mid-screen after T2;
  // emit large negative chunks deliberately to push toward top-left and
  // map the clamp behavior. 8 chunks × 50 mickeys ≈ enough to hit corner.
  await trajectory('T3-edge-nw', -50, -50, 8, 120);

  console.error(`\nAll frames saved under ${ROOT}`);
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
