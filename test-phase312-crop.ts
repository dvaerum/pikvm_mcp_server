/**
 * Crop+zoom around the detector's top-1 pick in mid_left frame to
 * visually verify whether it's the cursor.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';

const FRAME = './data/phase312-acceptance/2026-05-13_04-58-34/mid_upleft.jpg';
const PICK = { x: 1026, y: 653 };
const HALF = 80;

const buf = await fs.readFile(FRAME);
const meta = await sharp(buf).metadata();
const cropL = Math.max(0, PICK.x - HALF);
const cropT = Math.max(0, PICK.y - HALF);
const cropW = Math.min((meta.width ?? 1680) - cropL, HALF * 2);
const cropH = Math.min((meta.height ?? 1050) - cropT, HALF * 2);

await sharp(buf)
  .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
  .resize(cropW * 4, cropH * 4, { kernel: 'nearest' })
  .png()
  .toFile('./data/phase312-acceptance/2026-05-13_04-58-34/mid_upleft-CROP.png');
console.error('Saved CROP.');
