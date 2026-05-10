/**
 * Phase 211: instrument the algorithm-reported vs actual cursor position
 * gap.
 *
 * My memory says "A/B trial showed click 360 px from algorithm-reported
 * cursor position" but I haven't seen direct evidence in this session.
 * Let me get it.
 *
 * Plan:
 *   1. Move cursor to near Settings (905, 800) via moveToPixel
 *   2. Capture pre-click screenshot via keepalive
 *   3. Algorithm's reported position is from finalDetectedPosition
 *   4. Visually mark BOTH positions on the screenshot for inspection
 *
 * If algorithm-reported and visual cursor differ significantly,
 * detection is the issue, not Pointer Animations.
 */

import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { moveToPixel } from './src/pikvm/move-to.js';
import { decodeScreenshot, findCursorByTemplateSet } from './src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from './src/pikvm/template-set.js';
import { loadProfile } from './src/pikvm/ballistics.js';
import { ipadGoHome } from './src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const TARGET = { x: 905, y: 800 };  // Settings icon
const ROOT = './data/cursor-truth';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

console.error('=== Phase 211: algorithm-reported vs actual cursor position ===\n');

await ipadGoHome(client);
await new Promise(r => setTimeout(r, 800));

// Seed a fresh template if none available
const existing = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
if (existing.length === 0) {
  console.error('No cursor templates — seeding one...');
  const { seedCursorTemplate } = await import('./src/pikvm/seed-template.js');
  await client.mouseMoveRelative(20, 0);
  await new Promise(r => setTimeout(r, 100));
  const seed = await seedCursorTemplate(client, { settleMs: 80, emitDx: 80 });
  console.error(`Seed result: ok=${seed.ok}, reason=${seed.reason ?? 'success'}`);
  // Continue regardless — visual-inspect mode is still useful
}

console.error(`Target: (${TARGET.x}, ${TARGET.y}) — Settings icon`);

const moveResult = await moveToPixel(client, TARGET, {
  profile: profile ?? undefined,
  forbidSlamFallback: true,
  strategy: 'detect-then-move',
});

const algReported = moveResult.finalDetectedPosition;
console.error(`\nAlgorithm reports cursor at: ${algReported ? `(${algReported.x}, ${algReported.y})` : 'null'}`);

// Capture a fresh screenshot RIGHT NOW with cursor visible
const shot = await client.screenshotKeepingCursorAlive({ quality: 90 });
await fs.writeFile(`${ROOT}/post-move.jpg`, shot.buffer);
const decoded = await decodeScreenshot(shot.buffer);

// Find ACTUAL cursor in the screenshot via template match (if templates exist)
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Template count: ${templates.length}`);
let visualPos: { x: number; y: number } | null = null;
if (templates.length > 0) {
  const visualResult = findCursorByTemplateSet(decoded, templates, { minScore: 0.5 });
  visualPos = visualResult ? visualResult.position : null;
  console.error(`Visual scan finds best match at: ${visualPos ? `(${visualPos.x}, ${visualPos.y}) score=${visualResult!.score.toFixed(3)}` : 'null'}`);

  if (algReported && visualPos) {
    const gap = Math.hypot(algReported.x - visualPos.x, algReported.y - visualPos.y);
    console.error(`\n*** ALGORITHM vs VISUAL gap: ${gap.toFixed(1)} px ***`);
  }
} else {
  console.error('No templates — annotated screenshot only shows algorithm-reported position; user must visually inspect.');
}

// Annotate the screenshot with both positions for visual verification
if (algReported || visualPos) {
  const svg: string[] = [];
  if (algReported) {
    svg.push(
      `<circle cx="${algReported.x}" cy="${algReported.y}" r="20" stroke="red" stroke-width="3" fill="none"/>`,
      `<text x="${algReported.x + 25}" y="${algReported.y - 10}" font-size="20" fill="red" stroke="white" stroke-width="0.5">ALG (${algReported.x},${algReported.y})</text>`,
    );
  }
  if (visualPos) {
    svg.push(
      `<circle cx="${visualPos.x}" cy="${visualPos.y}" r="20" stroke="lime" stroke-width="3" fill="none"/>`,
      `<text x="${visualPos.x + 25}" y="${visualPos.y + 30}" font-size="20" fill="lime" stroke="black" stroke-width="0.5">VISUAL (${visualPos.x},${visualPos.y})</text>`,
    );
  }
  // Also mark target
  svg.push(
    `<circle cx="${TARGET.x}" cy="${TARGET.y}" r="25" stroke="cyan" stroke-width="2" fill="none" stroke-dasharray="5,5"/>`,
    `<text x="${TARGET.x + 30}" y="${TARGET.y}" font-size="20" fill="cyan" stroke="black" stroke-width="0.5">TARGET (${TARGET.x},${TARGET.y})</text>`,
  );
  const svgOverlay = `<svg width="1680" height="1050" xmlns="http://www.w3.org/2000/svg">${svg.join('')}</svg>`;
  const annotated = await sharp(shot.buffer)
    .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
    .toBuffer();
  await fs.writeFile(`${ROOT}/post-move-annotated.jpg`, annotated);
  console.error(`\nAnnotated screenshot at ${ROOT}/post-move-annotated.jpg`);
  console.error('  red circle  = algorithm-reported cursor');
  console.error('  green circle = visually-detected cursor (whole-frame search)');
  console.error('  cyan dashed = target');
}

process.exit(0);
