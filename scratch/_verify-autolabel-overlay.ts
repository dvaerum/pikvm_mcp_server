/**
 * Draw a magenta crosshair on each frame at the auto-label position
 * so we can eyeball whether the auto-labeler is accurate.
 *
 * Samples 6 random frames per scene.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.argv[2] ?? 'data/cursor-collect-2026-05-27T18-18-56';
const OUT = `${ROOT}-autolabel-overlay`;
const SAMPLES_PER_SCENE = 2;

interface Label {
  frame: string;
  cursor: { x: number; y: number } | null;
  score?: number;
  pixels?: number;
  darkCenterFraction?: number;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const labelsText = await fs.readFile(path.join(ROOT, 'cursor-bordered-autolabel.jsonl'), 'utf8');
  const labels = labelsText.trim().split('\n').map(s => JSON.parse(s) as Label);

  // Group by scene
  const byScene: Record<string, Label[]> = {};
  for (const l of labels) {
    const scene = l.frame.split('/')[0];
    byScene[scene] ??= [];
    byScene[scene].push(l);
  }

  // Sample N per scene
  const rng = () => Math.floor(Math.random() * 1e9);
  for (const [scene, ls] of Object.entries(byScene)) {
    const shuffled = [...ls].sort(() => rng() - rng()).slice(0, SAMPLES_PER_SCENE);
    for (const l of shuffled) {
      const src = path.join(ROOT, l.frame);
      const jpg = await fs.readFile(src);
      const meta = await sharp(jpg).metadata();
      const w = meta.width!;
      const h = meta.height!;
      let svgInner = '';
      if (l.cursor) {
        svgInner = `
          <circle cx="${l.cursor.x}" cy="${l.cursor.y}" r="30" fill="none" stroke="magenta" stroke-width="4"/>
          <line x1="${l.cursor.x - 50}" y1="${l.cursor.y}" x2="${l.cursor.x + 50}" y2="${l.cursor.y}" stroke="magenta" stroke-width="2"/>
          <line x1="${l.cursor.x}" y1="${l.cursor.y - 50}" x2="${l.cursor.x}" y2="${l.cursor.y + 50}" stroke="magenta" stroke-width="2"/>
          <text x="${l.cursor.x + 35}" y="${l.cursor.y - 35}" font-size="32" fill="magenta" font-family="monospace">(${l.cursor.x},${l.cursor.y}) px=${l.pixels} d=${l.darkCenterFraction}</text>`;
      } else {
        svgInner = `<text x="50" y="100" font-size="48" fill="magenta" font-family="monospace">ABSENT</text>`;
      }
      const svg = Buffer.from(`<svg width="${w}" height="${h}">${svgInner}</svg>`);
      const safeName = l.frame.replace('/', '_');
      await sharp(jpg)
        .composite([{ input: svg, top: 0, left: 0 }])
        .toFile(path.join(OUT, safeName));
    }
  }
  console.log(`Wrote samples → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
