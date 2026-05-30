import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import sharp from 'sharp';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const out = `data/v9-fresh-test-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
await fs.mkdir(out, { recursive: true });

async function moveAndShot(dx: number, dy: number, label: string) {
  if (dx !== 0 || dy !== 0) {
    await client.mouseMoveRelative(dx, dy);
    await new Promise(r => setTimeout(r, 400));
  }
  await client.mouseMoveRelative(1, 0);
  await client.mouseMoveRelative(-1, 0);
  await new Promise(r => setTimeout(r, 200));
  const jpg = await takeRawScreenshot(client);
  await fs.writeFile(`${out}/${label}.jpg`, jpg);
  const meta = await sharp(jpg).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const r = await findCursorByV8FullFrame(jpg, w, h, { minPresence: 0.3 });
  console.log(`${label}: ${r ? `(${r.x}, ${r.y}) p=${r.presence.toFixed(3)} peak=${r.heatmapPeak.toFixed(3)}` : 'NULL'}`);
}

await moveAndShot(0, 0, 'pos1');
await moveAndShot(-300, -200, 'pos2');
await moveAndShot(400, 100, 'pos3');
await moveAndShot(-100, 300, 'pos4');
await moveAndShot(200, -300, 'pos5');
console.log(`\nFrames in ${out}`);
