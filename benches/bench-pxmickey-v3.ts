/**
 * Phase 204 — px/mickey data-collection bench, v3 — uses production
 * cursor detection.
 *
 * Phase 203 iterations failed because they reinvented cursor detection.
 * This version uses the production stack:
 *   - seedCursorTemplate at startup → clean template
 *   - findCursorByTemplateSet on each frame → reliable single-frame
 *     cursor location
 *
 * Per measurement:
 *   1. setup: anchor cursor at known position via slam + small move
 *   2. capture pre frame (cursor visible via keepalive)
 *   3. detect pre cursor position via template match
 *   4. emit ONE single-call mouseMoveRelative move
 *   5. wait pace
 *   6. capture post frame
 *   7. detect post cursor position
 *   8. record (axis, magnitude, pace, prev_pos, new_pos, displacement,
 *      px_per_mickey)
 *
 * Output:
 *   - JSONL at ./data/pxmickey-v3/samples.jsonl
 *   - Frame pairs at ./data/pxmickey-v3/<trial>/{pre,post}.jpg
 *   - Template at ./data/cursor-templates/ (production location)
 *
 * Usage: npx tsx bench-pxmickey-v3.ts [reps_per_cell=2]
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  decodeScreenshot,
  findCursorByTemplateSet,
  CursorTemplate,
} from '../src/pikvm/cursor-detect.js';
import { seedCursorTemplate } from '../src/pikvm/seed-template.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const REPS = Number(process.argv[2] ?? 2);
const ROOT = './data/pxmickey-v3';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });
const LOG = path.join(ROOT, 'samples.jsonl');

const MAGNITUDES = [3, 5, 8, 10, 15, 20, 30, 50, 80, 127];
const PACES_MS = [10, 30, 60];
const AXES: Array<'x' | 'y'> = ['x', 'y'];

interface Sample {
  trial: number;
  axis: 'x' | 'y';
  magnitude: number;
  pace_ms: number;
  pre: { x: number; y: number; score: number } | null;
  post: { x: number; y: number; score: number } | null;
  dx_actual: number | null;
  dy_actual: number | null;
  px_per_mickey: number | null;
  notes: string;
}

let trialCount = 0;
let templates: CursorTemplate[] = [];

async function appendSample(s: Sample): Promise<void> {
  await fs.appendFile(LOG, JSON.stringify(s) + '\n');
}

async function captureFrame() {
  const shot = await client.screenshotKeepingCursorAlive({ quality: 80 });
  return { buffer: shot.buffer, decoded: await decodeScreenshot(shot.buffer) };
}

function findCursor(frame: any, expectedNear?: { x: number; y: number }): { x: number; y: number; score: number } | null {
  if (templates.length === 0) return null;
  const result = findCursorByTemplateSet(frame, templates, {
    minScore: 0.6,
    expectedNear,
    expectedNearRadius: expectedNear ? 300 : undefined,
  });
  if (!result) return null;
  return { x: result.position.x, y: result.position.y, score: result.score };
}

async function setupCursorAtAnchor(): Promise<{ x: number; y: number } | null> {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 400));
  // Slam toward bottom-left corner (safe area on iPad — Phase 32)
  for (let i = 0; i < 6; i++) {
    await client.mouseMoveRelative(-127, 127);
  }
  await new Promise(r => setTimeout(r, 200));
  // Move into a known-mid-screen area for predictable measurement
  await client.mouseMoveRelative(50, -100);
  await new Promise(r => setTimeout(r, 300));

  // Confirm cursor location
  const frame = await captureFrame();
  const pos = findCursor(frame.decoded);
  return pos;
}

async function runOneSample(
  axis: 'x' | 'y',
  magnitude: number,
  paceMs: number,
  rep: number,
): Promise<void> {
  trialCount++;
  const trial = trialCount;
  const slug = `t${trial.toString().padStart(4, '0')}-${axis}-m${magnitude}-p${paceMs}-r${rep}`;
  const trialDir = path.join(ROOT, slug);
  await fs.mkdir(trialDir, { recursive: true });

  const anchor = await setupCursorAtAnchor();
  if (!anchor) {
    await appendSample({
      trial, axis, magnitude, pace_ms: paceMs,
      pre: null, post: null, dx_actual: null, dy_actual: null, px_per_mickey: null,
      notes: 'anchor failed: cursor not detected after setup',
    });
    console.error(`t${trial} ${axis}:m=${magnitude} p=${paceMs} → anchor failed`);
    return;
  }

  // Capture pre frame and detect cursor
  const pre = await captureFrame();
  await fs.writeFile(path.join(trialDir, 'pre.jpg'), pre.buffer);
  const prePos = findCursor(pre.decoded, anchor);

  if (!prePos) {
    await appendSample({
      trial, axis, magnitude, pace_ms: paceMs,
      pre: null, post: null, dx_actual: null, dy_actual: null, px_per_mickey: null,
      notes: 'pre cursor not detected',
    });
    console.error(`t${trial} ${axis}:m=${magnitude} p=${paceMs} → pre detection failed`);
    return;
  }

  // Single-call emit
  const dx = axis === 'x' ? magnitude : 0;
  const dy = axis === 'y' ? magnitude : 0;
  await client.mouseMoveRelative(dx, dy);
  await new Promise(r => setTimeout(r, paceMs));

  // Capture post frame and detect cursor (expect near pre + emit)
  const post = await captureFrame();
  await fs.writeFile(path.join(trialDir, 'post.jpg'), post.buffer);
  const expected = { x: prePos.x + dx * 5, y: prePos.y + dy * 5 };  // wide hint
  const postPos = findCursor(post.decoded, expected);

  if (!postPos) {
    await appendSample({
      trial, axis, magnitude, pace_ms: paceMs,
      pre: prePos, post: null, dx_actual: null, dy_actual: null, px_per_mickey: null,
      notes: 'post cursor not detected',
    });
    console.error(`t${trial} ${axis}:m=${magnitude} p=${paceMs} → post detection failed (pre at ${prePos.x},${prePos.y})`);
    return;
  }

  const dxActual = postPos.x - prePos.x;
  const dyActual = postPos.y - prePos.y;
  const pxAlongAxis = axis === 'x' ? dxActual : dyActual;
  const sample: Sample = {
    trial, axis, magnitude, pace_ms: paceMs,
    pre: prePos, post: postPos,
    dx_actual: dxActual, dy_actual: dyActual,
    px_per_mickey: pxAlongAxis / magnitude,
    notes: `rep-${rep}`,
  };
  await appendSample(sample);
  console.error(
    `t${trial} ${axis}:m=${magnitude} p=${paceMs} r=${rep} → ` +
    `px/mickey=${sample.px_per_mickey?.toFixed(2)} (Δ=${pxAlongAxis.toFixed(0)}) ` +
    `pre(${prePos.x},${prePos.y}) post(${postPos.x},${postPos.y}) score=${prePos.score.toFixed(2)}/${postPos.score.toFixed(2)}`,
  );
}

async function main(): Promise<void> {
  const total = MAGNITUDES.length * PACES_MS.length * AXES.length * REPS;
  console.error(`Phase 204 px/mickey v3: ${MAGNITUDES.length}m × ${PACES_MS.length}p × ${AXES.length}ax × ${REPS}rep = ${total} samples`);

  // Wipe and re-seed templates so we start clean
  console.error('Wiping cursor templates and seeding fresh...');
  await fs.rm(DEFAULT_TEMPLATE_DIR, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(DEFAULT_TEMPLATE_DIR, { recursive: true });

  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
  // Pre-wake the cursor with a small move so the seed function's
  // before-frame has a visible cursor to diff against. settleMs=50
  // (vs default 500) keeps the cursor visible in the after frame.
  await client.mouseMoveRelative(20, 0);
  await new Promise(r => setTimeout(r, 100));
  const seedResult = await seedCursorTemplate(client, { settleMs: 50, emitDx: 80 });
  if (!seedResult.ok) {
    console.error(`Failed to seed cursor template: ${seedResult.reason}`);
    process.exit(1);
  }
  console.error(`Seeded template at cursor position (${seedResult.cursorPosition?.x}, ${seedResult.cursorPosition?.y})`);

  // Load templates the same way production does
  templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
  console.error(`Loaded ${templates.length} template(s) from ${DEFAULT_TEMPLATE_DIR}`);
  if (templates.length === 0) {
    console.error('No templates loaded after seed — aborting');
    process.exit(1);
  }

  for (const axis of AXES) {
    for (const magnitude of MAGNITUDES) {
      for (const paceMs of PACES_MS) {
        for (let rep = 0; rep < REPS; rep++) {
          await runOneSample(axis, magnitude, paceMs, rep);
        }
      }
    }
  }

  console.error(`\nDone. ${trialCount} samples written to ${LOG}`);
}

await main();
process.exit(0);
