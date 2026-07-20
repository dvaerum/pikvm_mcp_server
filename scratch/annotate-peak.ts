/** Annotate a frame with labeled markers at given native-px points, to verify
 * by eye what the detector is firing on. Usage: tsx annotate-peak.ts <frame.jpg> */
import sharp from 'sharp';
const src = process.argv[2] ?? 'scratch/hc13.jpg';
const pts: { x: number; y: number; c: string; label: string }[] = [
  { x: 760, y: 819, c: 'red', label: 'v14 peak 0.993 (no cursor here)' },
  { x: 1110, y: 297, c: 'yellow', label: 'old v13 Maps-widget FP' },
  { x: 620, y: 432, c: 'lime', label: 'clean-cursor location' },
];
const { width, height } = await sharp(src).metadata();
const circles = pts.map((p) =>
  `<circle cx="${p.x}" cy="${p.y}" r="34" fill="none" stroke="${p.c}" stroke-width="5"/>` +
  `<line x1="${p.x - 50}" y1="${p.y}" x2="${p.x + 50}" y2="${p.y}" stroke="${p.c}" stroke-width="2"/>` +
  `<line x1="${p.x}" y1="${p.y - 50}" x2="${p.x}" y2="${p.y + 50}" stroke="${p.c}" stroke-width="2"/>` +
  `<text x="${p.x + 40}" y="${p.y - 40}" font-size="22" fill="${p.c}" font-family="monospace">${p.label}</text>`
).join('');
const svg = `<svg width="${width}" height="${height}">${circles}</svg>`;
await sharp(src).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg().toFile('scratch/peak-annotated.jpg');
console.log('wrote scratch/peak-annotated.jpg');
