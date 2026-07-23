/**
 * shape-detector vs cascade across BACKGROUNDS (offline characterization).
 *
 * Follow-up to the openLoopShape pinpoint: the wiggle-guard fix took locate
 * 46%->100%, but the real-pixel analysis showed findCursorByShape returned NULL
 * on ALL 12 real grey frames — the cascade (findCursorByV8FullFrame) carried
 * openLoopShape entirely. This harness answers the fix-vs-RETIRE question for the
 * shape fallback: across a range of backgrounds (solid grey + 15 real iPad
 * home-screen backgrounds), composite the real cursor sprite at a grid of
 * positions and, per position, ask each detector independently:
 *   - cascade      findCursorByV8FullFrame (full-frame, hint-independent) — THE tracker
 *   - shape-dark   findCursorByShape(expectedNear=truth, r=100)
 *   - shape-bright findCursorByShape(expectedNear=truth, r=100, brightThreshold=120)
 *
 * The decisive metric is the CROSS-TAB: how often does the cascade MISS while
 * shape HITS (shape's unique rescue value) vs cascade HIT while shape misses
 * (shape redundant), and how often does shape fire FAR from truth on a busy
 * background (shape actively harmful = a false candidate the wiggle-gate must
 * reject). If shape never rescues a cascade miss and mostly mis-fires on busy
 * backgrounds, it is a dead/harmful fallback and should be retired.
 *
 * Usage: npx tsx benches/bench-shape-vs-cascade-backgrounds.ts [--w 1920] [--h 1080]
 *        [--cols 5] [--rows 4] [--hit 35] [--grey 140]
 * Output: data/bench-shape-vs-cascade/results.json + a per-background table.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { decodeScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
const W = arg('w', 1920);
const H = arg('h', 1080);
const COLS = arg('cols', 5);
const ROWS = arg('rows', 4);
const HIT = arg('hit', 35);
const GREY = arg('grey', 140); // 0.55*255 (setupGreyScene default)
const SPRITE = 180;
const CENTER = 90; // sprite label point (getCursor position)

/** Build the base frame RGB for a background id ('grey' or a bg-real filename). */
async function baseFor(bg: string): Promise<Buffer> {
  if (bg === 'grey') {
    return sharp({ create: { width: W, height: H, channels: 3, background: { r: GREY, g: GREY, b: GREY } } })
      .png().toBuffer();
  }
  return sharp(path.resolve('data/bg-real', bg))
    .resize(W, H, { fit: 'cover' })
    .removeAlpha()
    .png().toBuffer();
}

async function frameWithCursor(baseRgbPng: Buffer, tipX: number, tipY: number): Promise<Buffer> {
  const spriteLeft = tipX - CENTER, spriteTop = tipY - CENTER;
  const cropLeft = Math.max(0, -spriteLeft), cropTop = Math.max(0, -spriteTop);
  const destLeft = Math.max(0, spriteLeft), destTop = Math.max(0, spriteTop);
  const cropW = Math.min(SPRITE - cropLeft, W - destLeft), cropH = Math.min(SPRITE - cropTop, H - destTop);
  if (cropW <= 0 || cropH <= 0) return sharp(baseRgbPng).jpeg({ quality: 80 }).toBuffer();
  const spriteCrop = await sharp(path.resolve('ml/cursor-sprite.png'))
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH }).png().toBuffer();
  return sharp(baseRgbPng)
    .composite([{ input: spriteCrop, left: destLeft, top: destTop }])
    .jpeg({ quality: 80 }).toBuffer();
}

interface BgResult {
  bg: string; n: number;
  cascadeHit: number; darkHit: number; brightHit: number; shapeAnyHit: number;
  shapeRescue: number;      // cascade MISS & (dark|bright) HIT  -> shape's unique value
  shapeRedundant: number;   // cascade HIT & shapeAny HIT
  shapeMisfire: number;     // shape returned a candidate but >HIT from truth (harmful FP surface)
}

async function main() {
  const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
  const bgReal = (await fs.readdir(path.resolve('data/bg-real'))).filter((f) => f.endsWith('.jpg')).sort();
  const backgrounds = ['grey', ...bgReal];

  const results: BgResult[] = [];
  const perCell: Array<Record<string, unknown>> = [];

  for (const bg of backgrounds) {
    const base = await baseFor(bg);
    const r: BgResult = { bg, n: 0, cascadeHit: 0, darkHit: 0, brightHit: 0, shapeAnyHit: 0, shapeRescue: 0, shapeRedundant: 0, shapeMisfire: 0 };
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const tipX = Math.round(W * (0.10 + 0.80 * (col / (COLS - 1))));
        const tipY = Math.round(H * (0.10 + 0.80 * (row / (ROWS - 1))));
        const truth = { x: tipX, y: tipY };
        const jpeg = await frameWithCursor(base, tipX, tipY);
        const shot = await decodeScreenshot(jpeg);

        let cascade = false;
        try {
          const v8 = await findCursorByV8FullFrame(shot.buffer, shot.width, shot.height);
          cascade = !!v8 && dist(v8.x, v8.y, truth.x, truth.y) <= HIT;
        } catch { /* miss */ }

        const shapeEval = (bright: boolean): { hit: boolean; misfire: boolean } => {
          const c = findCursorByShape(shot.rgb, shot.width, shot.height,
            bright ? { expectedNear: truth, expectedNearRadius: 100, brightThreshold: 120 }
                   : { expectedNear: truth, expectedNearRadius: 100 });
          if (!c) return { hit: false, misfire: false };
          const d = dist(c.centroidX, c.centroidY, truth.x, truth.y);
          return { hit: d <= HIT, misfire: d > HIT };
        };
        const dark = shapeEval(false), bright = shapeEval(true);
        const shapeAny = dark.hit || bright.hit;
        const shapeMisfired = (dark.misfire || bright.misfire) && !shapeAny;

        r.n++;
        if (cascade) r.cascadeHit++;
        if (dark.hit) r.darkHit++;
        if (bright.hit) r.brightHit++;
        if (shapeAny) r.shapeAnyHit++;
        if (!cascade && shapeAny) r.shapeRescue++;
        if (cascade && shapeAny) r.shapeRedundant++;
        if (shapeMisfired) r.shapeMisfire++;
        perCell.push({ bg, tip: truth, cascade, darkHit: dark.hit, brightHit: bright.hit, shapeMisfired });
      }
    }
    results.push(r);
    const pct = (x: number) => `${Math.round((100 * x) / r.n)}%`;
    console.log(`${bg.padEnd(14)} n=${r.n}  cascade ${pct(r.cascadeHit).padStart(4)}  shape-dark ${pct(r.darkHit).padStart(4)}  shape-bright ${pct(r.brightHit).padStart(4)}  shapeANY ${pct(r.shapeAnyHit).padStart(4)}  RESCUE ${pct(r.shapeRescue).padStart(4)}  redundant ${pct(r.shapeRedundant).padStart(4)}  misfire ${pct(r.shapeMisfire).padStart(4)}`);
  }

  const tot = (k: keyof BgResult) => results.reduce((s, r) => s + (r[k] as number), 0);
  const N = tot('n');
  console.log(`\n=== TOTALS over ${N} frames (${backgrounds.length} backgrounds) ===`);
  console.log(`cascade hit:        ${Math.round(100 * tot('cascadeHit') / N)}%`);
  console.log(`shape-ANY hit:      ${Math.round(100 * tot('shapeAnyHit') / N)}%`);
  console.log(`shape RESCUE (cascade miss & shape hit): ${tot('shapeRescue')} / ${N}  (${Math.round(100 * tot('shapeRescue') / N)}%)  <- shape's unique value`);
  console.log(`shape misfire (candidate >${HIT}px from truth, no hit): ${tot('shapeMisfire')} / ${N}  (${Math.round(100 * tot('shapeMisfire') / N)}%)  <- harmful FP surface`);
  console.log(`\nVERDICT: ${tot('shapeRescue') === 0 ? 'shape NEVER rescued a cascade miss -> RETIRE candidate' : 'shape rescued some cascade misses -> KEEP/tune'}`);

  const outDir = path.resolve('data/bench-shape-vs-cascade');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ params: { W, H, COLS, ROWS, HIT, GREY }, results, perCell }, null, 2));
  console.log(`\nWrote ${path.join(outDir, 'results.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
