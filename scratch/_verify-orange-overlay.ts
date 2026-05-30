import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.argv[2] ?? 'data/cursor-collect-2026-05-27T19-00-08';
const LABELS_FILE = process.argv[3] ?? 'cursor-orange-moved-autolabel.jsonl';
const OUT = `${ROOT}-${LABELS_FILE.replace('.jsonl', '')}-overlay`;
const SAMPLES_PER_SCENE = 2;

interface Label { frame: string; cursor: { x: number; y: number } | null; pixels?: number; }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const text = await fs.readFile(path.join(ROOT, LABELS_FILE), 'utf8');
  const labels = text.trim().split('\n').map(s => JSON.parse(s) as Label);

  const byScene: Record<string, Label[]> = {};
  for (const l of labels) {
    const scene = l.frame.split('/')[0];
    byScene[scene] ??= [];
    byScene[scene].push(l);
  }

  for (const [scene, ls] of Object.entries(byScene)) {
    const shuffled = [...ls].sort(() => Math.random() - 0.5).slice(0, SAMPLES_PER_SCENE);
    for (const l of shuffled) {
      const src = path.join(ROOT, l.frame);
      const jpg = await fs.readFile(src);
      const meta = await sharp(jpg).metadata();
      const w = meta.width!;
      const h = meta.height!;
      let svgInner = '';
      if (l.cursor) {
        const { x, y } = l.cursor;
        svgInner = `
          <circle cx="${x}" cy="${y}" r="30" fill="none" stroke="magenta" stroke-width="4"/>
          <line x1="${x - 50}" y1="${y}" x2="${x + 50}" y2="${y}" stroke="magenta" stroke-width="2"/>
          <line x1="${x}" y1="${y - 50}" x2="${x}" y2="${y + 50}" stroke="magenta" stroke-width="2"/>
          <text x="${x + 35}" y="${y - 35}" font-size="32" fill="magenta" font-family="monospace">(${x},${y}) px=${l.pixels}</text>`;
      } else {
        svgInner = `<text x="50" y="100" font-size="48" fill="magenta" font-family="monospace">ABSENT</text>`;
      }
      const svg = Buffer.from(`<svg width="${w}" height="${h}">${svgInner}</svg>`);
      const safeName = l.frame.replace('/', '_');
      await sharp(jpg).composite([{ input: svg, top: 0, left: 0 }]).toFile(path.join(OUT, safeName));
    }
  }
  console.log(`Wrote samples → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
