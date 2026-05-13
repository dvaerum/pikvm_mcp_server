/**
 * Visually verify a labeled training frame: crop around the labeled
 * cursor position so we can see if the label is correct.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';

const FRAME = './data/cursor-training-v0/2026-05-13_05-33-56_0000_A.jpg';
const JSON_PATH = FRAME.replace(/\.jpg$/, '.json');
const label = JSON.parse(await fs.readFile(JSON_PATH, 'utf-8'));
console.error('Label:', JSON.stringify(label.cursor), 'confidence:', label.confidence);

const cropHalf = 60;
const cx = label.cursor.x;
const cy = label.cursor.y;
const buf = await fs.readFile(FRAME);
const meta = await sharp(buf).metadata();
const cropL = Math.max(0, cx - cropHalf);
const cropT = Math.max(0, cy - cropHalf);
const cropW = Math.min((meta.width ?? 1680) - cropL, cropHalf * 2);
const cropH = Math.min((meta.height ?? 1050) - cropT, cropHalf * 2);

// Annotate cursor center with crosshair
const lx = cx - cropL;
const ly = cy - cropT;
const svg = Buffer.from(`<svg width="${cropW}" height="${cropH}" xmlns="http://www.w3.org/2000/svg">
  <line x1="${lx - 20}" y1="${ly}" x2="${lx + 20}" y2="${ly}" stroke="red" stroke-width="2"/>
  <line x1="${lx}" y1="${ly - 20}" x2="${lx}" y2="${ly + 20}" stroke="red" stroke-width="2"/>
  <circle cx="${lx}" cy="${ly}" r="3" stroke="red" stroke-width="2" fill="none"/>
</svg>`);

const out = './data/cursor-training-v0/_VERIFY_0000_A.png';
await sharp(buf)
  .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
  .composite([{ input: svg, top: 0, left: 0 }])
  .resize(cropW * 4, cropH * 4, { kernel: 'nearest' })
  .png()
  .toFile(out);
console.error(`Saved: ${out}`);
