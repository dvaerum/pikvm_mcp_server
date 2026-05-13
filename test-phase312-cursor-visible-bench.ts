/**
 * Phase 312: live acceptance test for cursor-shape-detect.
 *
 * The CURRENT FOCUS rule 3 acceptance: "≥4/5 live trials within 30 px
 * on diverse cursor positions".
 *
 * Setup that GUARANTEES cursor is visible (vs Phase 308 bench where
 * cursor was often absent):
 *   1. Position cursor at 5 diverse mid-screen spots via SMALL chunked
 *      emits (no slam, no app-icon targeting — those trigger gestures).
 *   2. Just before screenshot, emit a tiny wiggle (+5, -5, -5, +5) so
 *      the cursor is freshly rendered.
 *   3. Take pre-wiggle frame, wiggle frame, post-wiggle frame.
 *   4. Visually verify cursor is present (printed to terminal: please
 *      check the saved frames).
 *   5. Run findCursorByShape with no locality hint, top-K.
 *   6. Check if any top-K cluster is within 30 px of expected cursor
 *      position (manual ground truth via emit math + small variance).
 *
 * If detector finds cursor in ≥4/5 trials within 30 px → ACCEPTANCE
 * passes per CURRENT FOCUS rule 3.
 *
 * v0.5.235 has all three penalties (307+308+311) active.
 */
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { unlockIpad, ipadGoHome } from './src/pikvm/ipad-unlock.js';
import { findCursorShapeCandidates } from './src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from './src/pikvm/cursor-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase312-acceptance/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 312 acceptance test at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

// 5 diverse mid-screen spots, reached by small relative emits from
// the iPad's home cursor position (~ 1060, 778 after ipadGoHome).
// Mid-screen avoids hot-corner gestures and avoids app icons whose
// internal features pollute detection.
const HOME = { x: 1060, y: 778 };
const TARGETS = [
  { name: 'mid_above',   dx:    0, dy: -200, expected: { x: 1060, y: 578 } },
  { name: 'mid_left',    dx: -200, dy:    0, expected: { x:  860, y: 778 } },
  { name: 'mid_below',   dx:    0, dy: +120, expected: { x: 1060, y: 898 } },
  { name: 'mid_upleft',  dx: -150, dy: -150, expected: { x:  910, y: 628 } },
  { name: 'mid_upright', dx: +100, dy: -150, expected: { x: 1160, y: 628 } },
];

async function chunkEmit(dx: number, dy: number) {
  let remX = Math.abs(dx);
  let remY = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  while (remX > 0 || remY > 0) {
    const stepX = remX > 0 ? Math.min(20, remX) * sx : 0;
    const stepY = remY > 0 ? Math.min(20, remY) * sy : 0;
    await client.mouseMoveRelative(stepX, stepY);
    remX = Math.max(0, remX - Math.abs(stepX));
    remY = Math.max(0, remY - Math.abs(stepY));
    await sleep(30);
  }
}

interface Trial {
  name: string;
  expected: { x: number; y: number };
  top1: { x: number; y: number; pixels: number; score: number } | null;
  distFromExpected: number | null;
  status: 'OK' | 'WRONG' | 'NULL';
}

const trials: Trial[] = [];

for (const target of TARGETS) {
  console.error(`\n--- ${target.name}: drive (${target.dx}, ${target.dy}) → expect (${target.expected.x}, ${target.expected.y}) ---`);

  // Reset to home
  try {
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  } catch {
    await unlockIpad(client, { dragPx: 1500 });
    await sleep(800);
    await ipadGoHome(client, { forceHomeViaSwipe: true });
  }
  await sleep(1500);

  // Drive cursor to target
  await chunkEmit(target.dx, target.dy);
  await sleep(300);

  // Wiggle just before screenshot to ensure cursor is freshly rendered
  await client.mouseMoveRelative(5, 5);
  await sleep(30);
  await client.mouseMoveRelative(-5, -5);
  await sleep(80);

  const shot = await client.screenshot();
  await fs.writeFile(path.join(ROOT, `${target.name}.jpg`), shot.buffer);

  // Run detector with NO hint — global search
  const decoded = await decodeScreenshot(shot.buffer);
  const cands = findCursorShapeCandidates(decoded.rgb, decoded.width, decoded.height, 5);

  let top1 = null;
  let distFromExpected = null;
  let status: 'OK' | 'WRONG' | 'NULL' = 'NULL';

  if (cands.length > 0) {
    const c = cands[0];
    top1 = { x: Math.round(c.centroidX), y: Math.round(c.centroidY), pixels: c.pixels, score: c.shapeScore };
    distFromExpected = Math.hypot(c.centroidX - target.expected.x, c.centroidY - target.expected.y);
    status = distFromExpected <= 30 ? 'OK' : 'WRONG';
  }

  // Annotate
  const marks: Array<{ x: number; y: number; color: string; label: string }> = [];
  marks.push({ x: target.expected.x, y: target.expected.y, color: '0,255,255', label: 'EXP' });
  for (let k = 0; k < cands.length; k++) {
    const c = cands[k];
    const color = k === 0 ? '255,0,255' : '255,255,0';
    marks.push({ x: Math.round(c.centroidX), y: Math.round(c.centroidY), color, label: `${k + 1}` });
  }
  const svg = marks.map((m) =>
    `<circle cx="${m.x}" cy="${m.y}" r="16" stroke="rgb(${m.color})" stroke-width="3" fill="none"/>` +
    `<text x="${m.x + 20}" y="${m.y + 5}" fill="rgb(${m.color})" font-size="20" font-family="monospace" font-weight="bold">${m.label}</text>`
  ).join('');
  const svgBuf = Buffer.from(`<svg width="${decoded.width}" height="${decoded.height}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`);
  await sharp(shot.buffer).composite([{ input: svgBuf, top: 0, left: 0 }]).png().toFile(path.join(ROOT, `${target.name}-annotated.png`));

  trials.push({ name: target.name, expected: target.expected, top1, distFromExpected, status });
  console.error(`  ${target.name}: status=${status} top1=${top1 ? `(${top1.x},${top1.y}) px=${top1.pixels} score=${top1.score.toFixed(3)}` : 'none'} dist=${distFromExpected !== null ? distFromExpected.toFixed(0) + 'px' : 'n/a'}`);
}

const okCount = trials.filter(t => t.status === 'OK').length;
const wrongCount = trials.filter(t => t.status === 'WRONG').length;
const nullCount = trials.filter(t => t.status === 'NULL').length;

console.error(`\n=== Phase 312 acceptance ===`);
console.error(`OK (top-1 within 30 px of expected): ${okCount}/${TARGETS.length}`);
console.error(`WRONG: ${wrongCount}, NULL: ${nullCount}`);
console.error(`Acceptance gate (≥4/5): ${okCount >= 4 ? 'PASS' : 'FAIL'}`);
console.error(`\nNEXT: visually inspect ${ROOT}/*-annotated.png to confirm cursor is visible in each frame.`);

await fs.writeFile(path.join(ROOT, 'results.json'), JSON.stringify({ version: VERSION, trials, okCount, gate: okCount >= 4 ? 'PASS' : 'FAIL' }, null, 2));
process.exit(0);
