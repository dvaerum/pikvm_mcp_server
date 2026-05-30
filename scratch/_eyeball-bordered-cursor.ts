/**
 * Quick eyeball test: move cursor to several positions and capture
 * the frame. We're checking whether the new white-bordered cursor is
 * obviously more visible than the prior borderless cursor — i.e.
 * could a human pick it out in a quick glance.
 *
 * Wakes the cursor with a small wiggle before each capture so the
 * "Automatically Hide Pointer" fade doesn't mask the result.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(process.cwd(), `data/eyeball-bordered-cursor-${ts}`);

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

let step = 0;
async function shot(label: string): Promise<void> {
  const jpg = await takeRawScreenshot(client);
  const fname = `${String(step).padStart(2, '0')}-${label}.jpg`;
  await fs.writeFile(path.join(OUT, fname), jpg);
  console.log(`  [${fname}]`);
  step++;
}

async function wiggle(): Promise<void> {
  await client.mouseMoveRelative(20, 0);
  await client.mouseMoveRelative(-20, 0);
  await new Promise(r => setTimeout(r, 200));
}

async function moveBy(dx: number, dy: number): Promise<void> {
  await client.mouseMoveRelative(dx, dy);
  await new Promise(r => setTimeout(r, 300));
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log(`Output: ${OUT}\n`);

  // We're already on Pointer Control > Colour screen.
  // 6 different positions across the iPad bounds.
  const moves: Array<[number, number, string]> = [
    [0, 0, 'pos1-initial'],
    [-200, -150, 'pos2-upleft'],
    [400, 0, 'pos3-right'],
    [0, 300, 'pos4-down'],
    [-300, -200, 'pos5-back'],
    [200, -300, 'pos6-topright'],
  ];

  for (const [dx, dy, label] of moves) {
    if (dx !== 0 || dy !== 0) await moveBy(dx, dy);
    await wiggle();
    await shot(label);
  }

  console.log(`\nDone. ${step} frames in ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
