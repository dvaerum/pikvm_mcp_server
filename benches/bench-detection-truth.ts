/**
 * Phase 192-eval — detection ground-truth diagnostic.
 *
 * Goal: compare what the cursor-detection layer CLAIMS the cursor
 * position is vs where the cursor ACTUALLY is in the same frame.
 *
 * Procedure (repeat N times):
 *   1. Reset to home, wakeup nudge.
 *   2. Take frame A.
 *   3. Emit a known relative move.
 *   4. Take frame B.
 *   5. Run motion-diff (frame A → frame B) → claimed cursor pair.
 *   6. Run template-match against frame B → claimed cursor pos.
 *   7. Save frame B WITH MARKERS overlaid:
 *        - red circle at motion-diff "post" centroid
 *        - blue circle at template-match position
 *   8. Save frame A separately (cursor pre-emit position).
 *
 * Then I open the marked frame B and look:
 *   - Is the red circle on the cursor?
 *   - Is the blue circle on the cursor?
 *   - If neither, the detection layer is lying — exactly the
 *     hypothesis that motivated the diagnostic.
 *
 * Output: ./data/detection-truth/NN-{frameA,frameB-marked}.jpg + log.
 */

import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import {
  decodeScreenshot,
  diffScreenshotsDecoded,
  findCursorByTemplateSet,
  DEFAULT_DETECTION_CONFIG,
} from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/detection-truth';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR).catch(() => []);
console.error(`Loaded ${templates.length} cursor templates from ${DEFAULT_TEMPLATE_DIR}.`);

interface Mark {
  x: number;
  y: number;
  color: string;
  label: string;
}

async function drawMarkers(buf: Buffer, marks: Mark[]): Promise<Buffer> {
  // Use sharp to composite SVG circles + labels onto the JPEG frame.
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 1680;
  const h = meta.height ?? 1050;
  const svg = `
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      ${marks.map(m => `
        <circle cx="${m.x}" cy="${m.y}" r="20" stroke="${m.color}" stroke-width="4" fill="none" />
        <line x1="${m.x - 30}" y1="${m.y}" x2="${m.x + 30}" y2="${m.y}" stroke="${m.color}" stroke-width="2" />
        <line x1="${m.x}" y1="${m.y - 30}" x2="${m.x}" y2="${m.y + 30}" stroke="${m.color}" stroke-width="2" />
        <text x="${m.x + 25}" y="${m.y - 25}" fill="${m.color}" font-size="22" font-family="Arial" font-weight="bold">${m.label}</text>
      `).join('\n')}
    </svg>
  `;
  return sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

const TRIALS = 5;
const EMITS: Array<{ dx: number; dy: number; label: string }> = [
  { dx: 60, dy: 0, label: 'east-60' },
  { dx: 0, dy: 60, label: 'south-60' },
  { dx: -60, dy: -60, label: 'nw-60-60' },
  { dx: 30, dy: 30, label: 'se-30-30' },
  { dx: 80, dy: -40, label: 'ne-80-40' },
];

interface LogEntry {
  trial: number;
  emit: { dx: number; dy: number; label: string };
  motionPair: { pre?: { x: number; y: number }; post?: { x: number; y: number }; reason?: string } | null;
  templateMatch: { x: number; y: number; score: number } | null;
}

const log: LogEntry[] = [];

console.error(`\nRunning ${TRIALS} detection-truth trials with varied emits.\n`);

for (let i = 0; i < TRIALS; i++) {
  const emit = EMITS[i];
  console.error(`--- Trial ${i + 1}/${TRIALS}: emit (${emit.dx}, ${emit.dy}) ${emit.label} ---`);

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
  // Wakeup nudge so cursor is rendered
  await client.mouseMoveRelative(30, 0);
  await new Promise(r => setTimeout(r, 80));
  await client.mouseMoveRelative(-30, 0);
  await new Promise(r => setTimeout(r, 250));

  // Frame A
  const shotA = await client.screenshot({ quality: 80 });
  await fs.writeFile(path.join(ROOT, `${(i + 1).toString().padStart(2, '0')}-A-pre-${emit.label}.jpg`), shotA.buffer);
  const decodedA = await decodeScreenshot(shotA.buffer);

  // Emit
  await client.mouseMoveRelative(emit.dx, emit.dy);
  await new Promise(r => setTimeout(r, 300));

  // Frame B
  const shotB = await client.screenshot({ quality: 80 });
  const decodedB = await decodeScreenshot(shotB.buffer);

  // Motion-diff returns Cluster[] (NOT a {pair, reason} object — that's
  // detectMotion's contract in move-to.ts). For this diagnostic we want
  // the raw cluster output so we can see which clusters survive the
  // brightness/cluster filters.
  const motionClusters = diffScreenshotsDecoded(decodedA, decodedB, DEFAULT_DETECTION_CONFIG);

  // Template-match
  const tm = templates.length > 0
    ? findCursorByTemplateSet(decodedB, templates, { verbose: false })
    : null;

  // Filter clusters by typical cursor-cluster size (4-90 px per move-to.ts).
  const cursorSized = motionClusters
    .filter(c => c.pixels >= 4 && c.pixels <= 90)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 10);
  console.error(
    `  motion-diff: ${motionClusters.length} clusters total, ${cursorSized.length} in [4,90]:`,
  );
  for (const c of cursorSized) {
    console.error(`     (${c.centroidX.toFixed(0)}, ${c.centroidY.toFixed(0)}) ${c.pixels} px`);
  }
  console.error(
    `  template:    ${tm ? `(${tm.position.x.toFixed(0)}, ${tm.position.y.toFixed(0)}) score=${tm.score.toFixed(3)}` : 'null'}`,
  );

  // Mark frame B with cluster centroids in cursor size range.
  const marks: Mark[] = [];
  cursorSized.slice(0, 5).forEach((c, idx) => {
    marks.push({
      x: c.centroidX,
      y: c.centroidY,
      color: idx === 0 ? 'red' : 'orange',
      label: `cluster ${c.pixels}px`,
    });
  });
  if (tm) {
    marks.push({
      x: tm.position.x,
      y: tm.position.y,
      color: 'blue',
      label: `tmpl ${tm.score.toFixed(2)}`,
    });
  }

  const marked = await drawMarkers(shotB.buffer, marks);
  await fs.writeFile(path.join(ROOT, `${(i + 1).toString().padStart(2, '0')}-B-marked-${emit.label}.jpg`), marked);

  log.push({
    trial: i + 1,
    emit,
    motionPair: cursorSized.length > 0
      ? { post: { x: Math.round(cursorSized[0].centroidX), y: Math.round(cursorSized[0].centroidY) } }
      : { reason: 'no cursor-sized clusters' },
    templateMatch: tm ? { x: tm.position.x, y: tm.position.y, score: tm.score } : null,
  });
}

await fs.writeFile(path.join(ROOT, 'log.json'), JSON.stringify(log, null, 2));
console.error(`\nDone. ${TRIALS} trials → ${ROOT}`);
console.error(`Open ${ROOT}/NN-B-marked-*.jpg and check whether red/blue markers land on the actual cursor.`);
process.exit(0);
