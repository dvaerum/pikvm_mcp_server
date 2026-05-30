/**
 * Phase 214 — why is template-match failing?
 *
 * Open-loop trace: "template-match (1 cached) failed". One template
 * cached but it's not matching. Possibilities:
 *  A. Template extracted from a different backdrop and NCC < 0.88
 *     against the current cursor position
 *  B. Template is contaminated (looksLikeCursor passes but it's
 *     actually a UI feature — Phase 102+ dealt with this; could
 *     have regressed)
 *  C. Template hotspot offset mis-aligned
 *
 * Visual investigation: load the cached template, capture a
 * fresh screenshot with cursor visible, run findCursorByTemplateSet
 * with verbose, see what scores come out.
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { decodeScreenshot, findCursorByTemplateSet } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/template-investigation';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 214: template-match diagnostic ===\n');

// 1. Load the cached templates
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Templates loaded: ${templates.length}`);
for (let i = 0; i < templates.length; i++) {
  const t = templates[i] as any;
  console.error(`  [${i}] ${t.width}×${t.height} hotspot=(${t.hotspotX},${t.hotspotY})`);
  if (t.rgb) {
    await sharp(t.rgb, { raw: { width: t.width, height: t.height, channels: 3 } })
      .png()
      .toFile(`${ROOT}/template-${i}.png`);
  }
}

if (templates.length === 0) {
  console.error('No templates — exit. Seeding via wake-and-capture would need fresh cursor.');
  process.exit(0);
}

// 2. Wake the cursor and capture a screenshot
await ipadGoHome(client);
await new Promise(r => setTimeout(r, 500));
// Wiggle the cursor to make it visible
await client.mouseMoveRelative(20, 0);
await new Promise(r => setTimeout(r, 50));
await client.mouseMoveRelative(-20, 0);
await new Promise(r => setTimeout(r, 50));

const shot = await client.screenshotKeepingCursorAlive({ quality: 90 });
await fs.writeFile(`${ROOT}/screenshot.jpg`, shot.buffer);
const decoded = await decodeScreenshot(shot.buffer);
console.error(`Screenshot ${decoded.width}×${decoded.height}`);

// 3. Run template-match with verbose, multiple thresholds
console.error('\n--- Whole-frame template search (minScore=0.0) ---');
const top = findCursorByTemplateSet(decoded, templates, {
  minScore: 0,
  step: 4,
  verbose: true,
});
if (top) {
  console.error(`Best match: (${top.position.x}, ${top.position.y}) score=${top.score.toFixed(3)} tpl#${top.templateIndex}`);
} else {
  console.error('No match at all');
}

// 4. Annotate: target zone + cluster locations + best template match
const svg: string[] = [];
const TARGET = { x: 905, y: 800 };
svg.push(`<circle cx="${TARGET.x}" cy="${TARGET.y}" r="35" stroke="cyan" stroke-width="2" fill="none" stroke-dasharray="6,4"/>`);
svg.push(`<text x="${TARGET.x + 40}" y="${TARGET.y}" font-size="20" fill="cyan" stroke="black" stroke-width="0.5">TARGET</text>`);

const clusters = [
  { x: 949, y: 795, name: 'A' },
  { x: 970, y: 771, name: 'B' },
  { x: 972, y: 772, name: 'C' },
];
for (const c of clusters) {
  svg.push(`<circle cx="${c.x}" cy="${c.y}" r="8" stroke="orange" stroke-width="2" fill="none"/>`);
  svg.push(`<text x="${c.x + 12}" y="${c.y - 8}" font-size="14" fill="orange" stroke="black" stroke-width="0.4">${c.name}</text>`);
}

if (top) {
  svg.push(`<circle cx="${top.position.x}" cy="${top.position.y}" r="20" stroke="lime" stroke-width="3" fill="none"/>`);
  svg.push(`<text x="${top.position.x + 25}" y="${top.position.y + 5}" font-size="18" fill="lime" stroke="black" stroke-width="0.5">TPL ${top.score.toFixed(3)}</text>`);
}

const svgStr = `<svg width="${decoded.width}" height="${decoded.height}" xmlns="http://www.w3.org/2000/svg">${svg.join('')}</svg>`;
const annotated = await sharp(shot.buffer)
  .composite([{ input: Buffer.from(svgStr), top: 0, left: 0 }])
  .toBuffer();
await fs.writeFile(`${ROOT}/annotated.jpg`, annotated);
console.error(`\nAnnotated screenshot at ${ROOT}/annotated.jpg`);
console.error('  cyan dashed = target (905, 800)');
console.error('  orange = Phase 211 false-positive clusters');
console.error('  green = best template match (if any)');

process.exit(0);
