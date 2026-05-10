import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/locate-settings';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 214: locate Settings icon on home screen ===\n');

const r = await ipadGoHome(client, { forceHomeViaSwipe: true, verbose: true });
await fs.writeFile(`${ROOT}/home-screen.jpg`, r.screenshot);

// Annotate where we EXPECTED Settings (905, 800) and where it actually appears
// based on the screenshot from earlier (around (905, 800) too actually).
// Take a fresh capture and annotate with crosshair grid every 50px.
await new Promise(res => setTimeout(res, 500));
const fresh = await client.screenshot();
const overlay: string[] = [];
// Crosshair grid every 100 px
for (let x = 0; x < 1680; x += 100) overlay.push(`<line x1="${x}" y1="0" x2="${x}" y2="1050" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`);
for (let y = 0; y < 1050; y += 100) overlay.push(`<line x1="0" y1="${y}" x2="1680" y2="${y}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`);
// Target marker
const TARGET = { x: 905, y: 800 };
overlay.push(`<circle cx="${TARGET.x}" cy="${TARGET.y}" r="40" stroke="cyan" stroke-width="3" fill="none"/>`);
overlay.push(`<text x="${TARGET.x + 50}" y="${TARGET.y}" font-size="20" fill="cyan" stroke="black" stroke-width="0.5">TARGET (${TARGET.x},${TARGET.y})</text>`);
// Coordinate labels at every 200px
for (let x = 0; x < 1680; x += 200) overlay.push(`<text x="${x + 5}" y="20" font-size="14" fill="rgba(255,255,255,0.6)">${x}</text>`);
for (let y = 100; y < 1050; y += 200) overlay.push(`<text x="5" y="${y}" font-size="14" fill="rgba(255,255,255,0.6)">${y}</text>`);

const svg = `<svg width="1680" height="1050" xmlns="http://www.w3.org/2000/svg">${overlay.join('')}</svg>`;
const annotated = await sharp(fresh.buffer)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .toBuffer();
await fs.writeFile(`${ROOT}/home-with-grid.jpg`, annotated);

console.error('Saved home-screen.jpg and home-with-grid.jpg');
console.error(r.message);
process.exit(0);
