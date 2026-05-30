/**
 * Run v8 ML detector on the 6 frames captured with the white-bordered
 * cursor. Report:
 *   - did v8 detect (presence > 0.5)?
 *   - what (x, y) did it predict?
 *   - I'll visually compare against where the cursor visibly is
 *
 * Decision gate: if v8 finds the bordered cursor in ≥ 4/6 frames at
 * a position that matches the visible cursor (within ~30 px), v8
 * survives the cosmetic change and we don't need to retrain.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';

const FRAMES_DIR = 'data/eyeball-bordered-cursor-2026-05-27T17-33-59';

async function main() {
  const files = (await fs.readdir(FRAMES_DIR))
    .filter(f => f.endsWith('.jpg'))
    .sort();

  for (const file of files) {
    const fp = path.join(FRAMES_DIR, file);
    const jpg = await fs.readFile(fp);
    const meta = await sharp(jpg).metadata();
    const w = meta.width!;
    const h = meta.height!;
    const r = await findCursorByV8FullFrame(jpg, w, h, { minPresence: 0.3 });
    if (r === null) {
      console.log(`  ${file}: presence < 0.3 → NULL`);
    } else {
      console.log(`  ${file}: presence=${r.presence.toFixed(3)} peak=${r.heatmapPeak.toFixed(3)} at (${r.x}, ${r.y})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
