/**
 * Phase 194-F — single-axis rightward sweep diagnostic.
 *
 * Phase 194-E (Files-target undershoot) identified that the iPad
 * cursor consistently lands at ~(832, 404) when targeting Files
 * (1035, 420). Three hypotheses:
 *   1. iPad bounds detection mis-reports right edge.
 *   2. X-axis ratio under-estimate (more mickeys needed).
 *   3. iPadOS rate-limits emits in right-edge region.
 *
 * This bench:
 *   - Slam-emits cursor toward top-left corner (10 × -127,-127)
 *   - Then loops: emit 60 mickeys right, screenshot, locate
 *     cursor via template-match, record (cumulative_mickeys, cursor_x)
 *   - Continues until cumulative emits = 1500 mickeys (more than
 *     enough to traverse 1680-px-wide HDMI frame at any plausible
 *     ratio), or until cursor stops moving for 3 consecutive emits.
 *
 * If cursor X plateaus before ~1100, hypotheses 1 or 3.
 * If cursor X tracks linearly across the whole range, hypothesis 2.
 *
 * Saves all frames + a CSV log so we can analyse later.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { decodeScreenshot, findCursorByTemplateSet } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { looksLikeCursor } from '../src/pikvm/move-to.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const ROOT = './data/x-sweep';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

const STEP_MICKEYS = 60;
const MAX_TOTAL_MICKEYS = 1500;
const PLATEAU_DETECT_TRIES = 3;
const PLATEAU_THRESHOLD_PX = 5;

console.error(`Phase 194-F: X-axis rightward sweep`);
console.error(`Step=${STEP_MICKEYS} mickeys. Max=${MAX_TOTAL_MICKEYS}. Plateau detect after ${PLATEAU_DETECT_TRIES} stalls of < ${PLATEAU_THRESHOLD_PX} px.\n`);

await ipadGoHome(client);
await new Promise(r => setTimeout(r, 800));

// Slam to top-left via large negative emits
console.error('Slam to top-left...');
for (let i = 0; i < 10; i++) {
  await client.mouseMoveRelative(-127, -127);
  await new Promise(r => setTimeout(r, 30));
}
await new Promise(r => setTimeout(r, 500));

// Wakeup nudge to render the cursor
await client.mouseMoveRelative(20, 0);
await new Promise(r => setTimeout(r, 80));
await client.mouseMoveRelative(-20, 0);
await new Promise(r => setTimeout(r, 300));

const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR, looksLikeCursor).catch(() => []);
console.error(`Loaded ${templates.length} cursor templates.`);

interface Sample {
  step: number;
  totalMickeys: number;
  cursorX: number | null;
  cursorY: number | null;
  score: number | null;
}
const samples: Sample[] = [];

async function probeCursor(): Promise<{ x: number; y: number; score: number } | null> {
  const shot = await client.screenshot({ quality: 80 });
  const decoded = await decodeScreenshot(shot.buffer);
  if (templates.length === 0) return null;
  const r = findCursorByTemplateSet(decoded, templates);
  if (!r) return null;
  return { x: r.position.x, y: r.position.y, score: r.score };
}

// Initial probe (post-slam, post-wake)
const initial = await probeCursor();
console.error(`Initial post-slam cursor: ${initial ? `(${initial.x}, ${initial.y}) score=${initial.score.toFixed(2)}` : 'null'}`);
samples.push({ step: 0, totalMickeys: 0, cursorX: initial?.x ?? null, cursorY: initial?.y ?? null, score: initial?.score ?? null });
await fs.writeFile(path.join(ROOT, `00-initial.jpg`), (await client.screenshot({ quality: 80 })).buffer);

let stallCount = 0;
let prevX: number | null = initial?.x ?? null;

for (let step = 1; step * STEP_MICKEYS <= MAX_TOTAL_MICKEYS; step++) {
  await client.mouseMoveRelative(STEP_MICKEYS, 0);
  await new Promise(r => setTimeout(r, 200));
  const probe = await probeCursor();
  const totalMickeys = step * STEP_MICKEYS;
  samples.push({
    step, totalMickeys,
    cursorX: probe?.x ?? null, cursorY: probe?.y ?? null,
    score: probe?.score ?? null,
  });
  await fs.writeFile(path.join(ROOT, `${step.toString().padStart(2, '0')}.jpg`), (await client.screenshot({ quality: 80 })).buffer);
  console.error(
    `step ${step.toString().padStart(2)} | total=${totalMickeys.toString().padStart(4)} mickeys | ` +
    `cursor ${probe ? `(${probe.x.toString().padStart(4)}, ${probe.y.toString().padStart(4)}) s=${probe.score.toFixed(2)}` : 'null'.padEnd(22)}`
  );

  // Plateau detection
  if (probe && prevX !== null) {
    const dx = probe.x - prevX;
    if (Math.abs(dx) < PLATEAU_THRESHOLD_PX) {
      stallCount++;
      if (stallCount >= PLATEAU_DETECT_TRIES) {
        console.error(`\nPlateau: cursor stalled at x≈${probe.x} after ${totalMickeys} mickeys total.`);
        break;
      }
    } else {
      stallCount = 0;
    }
    prevX = probe.x;
  } else if (probe) {
    prevX = probe.x;
  }
}

// Write CSV
const csv = ['step,totalMickeys,cursorX,cursorY,score'];
for (const s of samples) {
  csv.push(`${s.step},${s.totalMickeys},${s.cursorX ?? ''},${s.cursorY ?? ''},${s.score?.toFixed(3) ?? ''}`);
}
await fs.writeFile(path.join(ROOT, 'sweep.csv'), csv.join('\n'));
await fs.writeFile(path.join(ROOT, 'sweep.json'), JSON.stringify(samples, null, 2));

// Summary
const validSamples = samples.filter(s => s.cursorX !== null);
if (validSamples.length >= 2) {
  const first = validSamples[0]!;
  const last = validSamples[validSamples.length - 1]!;
  const totalDx = (last.cursorX! - first.cursorX!);
  const totalMickeys = last.totalMickeys - first.totalMickeys;
  const avgRatio = totalMickeys > 0 ? totalDx / totalMickeys : 0;
  console.error(`\n=== SUMMARY ===`);
  console.error(`Initial cursor X: ${first.cursorX}`);
  console.error(`Final cursor X:   ${last.cursorX}`);
  console.error(`Total emit:       ${totalMickeys} mickeys`);
  console.error(`Total px moved:   ${totalDx.toFixed(0)} px`);
  console.error(`Average ratio:    ${avgRatio.toFixed(3)} px/mickey`);
  if (last.cursorX! < 1100 && totalMickeys > 800) {
    console.error(`\n⚠ CURSOR DID NOT REACH x=1100 even with ${totalMickeys} mickeys.`);
    console.error(`  Likely hypotheses 1 or 3 (bounds clamp / rate-limit).`);
  } else if (last.cursorX! >= 1100) {
    console.error(`\n✓ Cursor reached x=${last.cursorX} (>= 1100).`);
    console.error(`  Hypothesis 2 (ratio mismatch) most likely; cursor IS movable past 832.`);
  }
}
console.error(`\nFrames + CSV → ${ROOT}`);
process.exit(0);
