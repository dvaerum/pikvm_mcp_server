/**
 * Draw a magenta circle at v8's predicted cursor position so we can
 * visually confirm whether v8 actually finds the bordered cursor or
 * is hallucinating onto some other UI element.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';

const FRAMES_DIR = process.argv[2] ?? 'data/eyeball-bordered-cursor-2026-05-27T17-33-59';
const MODEL_TAG = process.argv[3] ?? 'v8';
const OUT_DIR = `${FRAMES_DIR}-${MODEL_TAG}-overlay`;

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
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
    if (!r) {
      console.log(`  ${file}: NULL`);
      continue;
    }
    // Draw magenta crosshair + circle at predicted position
    const svg = `<svg width="${w}" height="${h}">
      <circle cx="${r.x}" cy="${r.y}" r="40" fill="none" stroke="magenta" stroke-width="6"/>
      <line x1="${r.x - 60}" y1="${r.y}" x2="${r.x + 60}" y2="${r.y}" stroke="magenta" stroke-width="3"/>
      <line x1="${r.x}" y1="${r.y - 60}" x2="${r.x}" y2="${r.y + 60}" stroke="magenta" stroke-width="3"/>
      <text x="${r.x + 50}" y="${r.y - 50}" font-size="36" fill="magenta" font-family="monospace">v8: (${r.x},${r.y}) p=${r.presence.toFixed(2)}</text>
    </svg>`;
    const overlay = Buffer.from(svg);
    const out = path.join(OUT_DIR, file);
    await sharp(jpg)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .toFile(out);
    console.log(`  ${file}: v8 predicts (${r.x}, ${r.y}) p=${r.presence.toFixed(3)} → ${out}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
