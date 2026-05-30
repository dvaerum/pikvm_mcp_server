/**
 * Phase 269: per-trial NCC vs shape-detect disagreement telemetry.
 *
 * Phase 268's cross-check trended -10 pp on N=40. Hypothesis: shape
 * and NCC have correlated failures on wallpaper-gradient FPs. Need
 * data to disambiguate:
 *   - Mode A: both detectors right → cross-check no-op (good)
 *   - Mode B: NCC right, shape wrong → cross-check overrides correctly
 *             (bad — hurts click rate)
 *   - Mode C: NCC wrong, shape right → cross-check overrides correctly
 *             (good — helps click rate)
 *   - Mode D: both wrong, different places → cross-check overrides one
 *             wrong with another wrong (neutral)
 *   - Mode E: both wrong, same place → cross-check doesn't fire (bad)
 *
 * Procedure: 10 trials of moveToPixel against target (905, 800).
 * For each, capture the post-move frame and run BOTH detectors with
 * locality hint at the EXPECTED cursor position (905, 800 ± 100).
 * Log each detector's output. Save the frame for manual visual
 * inspection.
 *
 * Then VISUALLY inspect each frame:
 *   - Where is the cursor actually?
 *   - Which detector got it right?
 *   - Which mode (A-E) does this trial fall into?
 *
 * Mode distribution tells us whether Phase 268's premise was sound:
 *   - Lots of Mode C → cross-check helps; need to figure out why
 *     bench showed -10 pp (maybe variance after all)
 *   - Lots of Mode B → cross-check hurts; revert was correct
 *   - Lots of Mode E → both detectors share blind spots; cross-check
 *     can't help here, need a different signal entirely
 */
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { loadProfile } from '../src/pikvm/ballistics.js';
import { ipadGoHome, unlockIpad } from '../src/pikvm/ipad-unlock.js';
import { decodeScreenshot, findCursorByTemplateSet } from '../src/pikvm/cursor-detect.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { findCursorByShape } from '../src/pikvm/cursor-shape-detect.js';
import { VERSION } from '../src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const profile = await loadProfile('./data/ballistics.json').catch(() => null);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const ROOT = `./data/phase269-disagreement/${RUN_ID}`;
await fs.mkdir(ROOT, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

console.error(`=== Phase 269 detector-disagreement at v${VERSION} ===\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

const TARGET = { x: 905, y: 800 };
const N = 10;
const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
console.error(`Loaded ${templates.length} templates for NCC`);

interface Trial {
  i: number;
  moveResidual: number | null;
  moveDetected: { x: number; y: number } | null;
  nccDetected: { x: number; y: number } | null;
  nccScore: number;
  shapeDetected: { x: number; y: number } | null;
  shapeScore: number;
  disagreementPx: number | null;
}

const trials: Trial[] = [];

for (let i = 1; i <= N; i++) {
  console.error(`\n--- Trial ${i}/${N} ---`);
  await ipadGoHome(client, { forceHomeViaSwipe: true });
  await sleep(1200);

  // Run moveToPixel as production does
  let moveResidual: number | null = null;
  let moveDetected: { x: number; y: number } | null = null;
  try {
    const r = await moveToPixel(client, TARGET, {
      profile: profile ?? undefined,
      forbidSlamFallback: true,
      strategy: 'detect-then-move',
    });
    if (r.finalDetectedPosition) {
      moveDetected = { x: r.finalDetectedPosition.x, y: r.finalDetectedPosition.y };
      moveResidual = Math.hypot(moveDetected.x - TARGET.x, moveDetected.y - TARGET.y);
    }
  } catch {/* ignore */}

  // Capture frame; run both detectors with hint at TARGET
  const shot = await client.screenshotKeepingCursorAlive();
  await fs.writeFile(`${ROOT}/t${i.toString().padStart(2, '0')}.jpg`, shot.buffer);
  const dec = await decodeScreenshot(shot.buffer);
  const decRaw = await sharp(shot.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const ncc = findCursorByTemplateSet(dec, templates, {
    expectedNear: TARGET,
    expectedNearRadius: 150,
    requireWithinRadius: true,
    minScore: 0.83,
  });

  const shape = findCursorByShape(decRaw.data, decRaw.info.width, decRaw.info.height, {
    expectedNear: TARGET,
    expectedNearRadius: 100,
  });

  let disagreementPx: number | null = null;
  if (ncc && shape) {
    disagreementPx = Math.hypot(ncc.position.x - shape.centroidX, ncc.position.y - shape.centroidY);
  }

  trials.push({
    i,
    moveResidual,
    moveDetected,
    nccDetected: ncc ? { x: ncc.position.x, y: ncc.position.y } : null,
    nccScore: ncc?.score ?? 0,
    shapeDetected: shape ? { x: Math.round(shape.centroidX), y: Math.round(shape.centroidY) } : null,
    shapeScore: shape?.shapeScore ?? 0,
    disagreementPx,
  });

  console.error(`  moveToPixel: ${moveDetected ? `(${moveDetected.x},${moveDetected.y}) residual=${moveResidual?.toFixed(0)}px` : 'null'}`);
  console.error(`  NCC:    ${ncc ? `(${ncc.position.x},${ncc.position.y}) score=${ncc.score.toFixed(3)}` : 'null'}`);
  console.error(`  shape:  ${shape ? `(${Math.round(shape.centroidX)},${Math.round(shape.centroidY)}) score=${shape.shapeScore.toFixed(3)}` : 'null'}`);
  console.error(`  disagreement: ${disagreementPx !== null ? disagreementPx.toFixed(0) + ' px' : 'n/a (one or both null)'}`);
}

console.error(`\n\n=== SUMMARY (N=${N}) ===`);
console.error('trial | move      | NCC               | shape             | disagree');
console.error('------+-----------+-------------------+-------------------+---------');
for (const t of trials) {
  const fmtPos = (p: { x: number; y: number } | null, score?: number) =>
    p ? `(${p.x.toString().padStart(4)},${p.y.toString().padStart(4)})${score !== undefined ? ` s${score.toFixed(2)}` : ''}` : 'null            ';
  console.error(
    `  ${t.i.toString().padStart(2)}  | ` +
    `${t.moveResidual !== null ? t.moveResidual.toFixed(0).padStart(4) + ' px' : 'null   '} | ` +
    `${fmtPos(t.nccDetected, t.nccScore).padEnd(17)} | ` +
    `${fmtPos(t.shapeDetected, t.shapeScore).padEnd(17)} | ` +
    `${t.disagreementPx !== null ? t.disagreementPx.toFixed(0).padStart(4) + ' px' : 'n/a    '}`,
  );
}

// Aggregate mode stats
let bothNull = 0, oneNull = 0, agree = 0, disagree = 0;
for (const t of trials) {
  const nccNull = t.nccDetected === null;
  const shapeNull = t.shapeDetected === null;
  if (nccNull && shapeNull) bothNull++;
  else if (nccNull || shapeNull) oneNull++;
  else if (t.disagreementPx! <= 30) agree++;
  else disagree++;
}
console.error(`\nDetector agreement breakdown:`);
console.error(`  both null:           ${bothNull}/${N} (cross-check no-op, fallback fires)`);
console.error(`  one null:            ${oneNull}/${N} (cross-check no-op)`);
console.error(`  both report, agree:  ${agree}/${N} (cross-check no-op)`);
console.error(`  both report, disagree (>30 px): ${disagree}/${N} ← cross-check WOULD fire here`);

console.error(`\nVISUAL inspection needed: open data/phase269-disagreement/<run-id>/t*.jpg`);
console.error(`and check WHERE the cursor actually is in each frame.`);
console.error(`Then determine for the ${disagree} disagreement trials: was NCC right or was shape right?`);
process.exit(0);
