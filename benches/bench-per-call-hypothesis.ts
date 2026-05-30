/**
 * Phase 207 — direct test of the per-call displacement hypothesis.
 *
 * Phase 206 analysis of ballistics data suggested every
 * mouseMoveRelative call moves the cursor ~52 px (x) or ~135 px (y)
 * regardless of mickey count.
 *
 * This script tests the hypothesis directly:
 *   - Run A: 10 calls of mouseMoveRelative(5, 0) — predicted ~520 px
 *   - Run B: 10 calls of mouseMoveRelative(127, 0) — predicted ~520 px
 *     (same per-call cap)
 *
 * If the hypothesis is correct, both should produce ~same displacement.
 * If the lookup-table model is correct, Run B should produce ~25× more
 * displacement than Run A.
 *
 * Uses production seedCursorTemplate + findCursorByTemplateSet to
 * locate cursor before/after.
 */

import { promises as fs } from 'fs';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  decodeScreenshot,
  findCursorByTemplateSet,
} from '../src/pikvm/cursor-detect.js';
import { seedCursorTemplate } from '../src/pikvm/seed-template.js';
import { loadTemplateSet, DEFAULT_TEMPLATE_DIR } from '../src/pikvm/template-set.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const NUM_CALLS = 10;
const ROOT = './data/per-call-hypothesis';
await fs.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
await fs.mkdir(ROOT, { recursive: true });

async function captureFrame() {
  const shot = await client.screenshotKeepingCursorAlive({ quality: 80 });
  return { buffer: shot.buffer, decoded: await decodeScreenshot(shot.buffer) };
}

async function setupAtLeftSide(): Promise<void> {
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 600));
  // Slam toward bottom-left, then a small move into the visible area
  for (let i = 0; i < 8; i++) await client.mouseMoveRelative(-127, 0);
  for (let i = 0; i < 4; i++) await client.mouseMoveRelative(0, 80);
  await new Promise(r => setTimeout(r, 200));
  await client.mouseMoveRelative(20, 0); // wake
  await new Promise(r => setTimeout(r, 100));
}

async function runOne(label: string, dx: number, callCount: number): Promise<void> {
  await setupAtLeftSide();
  const pre = await captureFrame();
  await fs.writeFile(`${ROOT}/${label}-pre.jpg`, pre.buffer);

  const templates = await loadTemplateSet(DEFAULT_TEMPLATE_DIR);
  if (templates.length === 0) {
    console.error('No templates available; aborting');
    return;
  }
  const prePos = findCursorByTemplateSet(pre.decoded, templates, { minScore: 0.6 });

  // Emit the test calls
  for (let i = 0; i < callCount; i++) {
    await client.mouseMoveRelative(dx, 0);
  }

  await new Promise(r => setTimeout(r, 200));
  const post = await captureFrame();
  await fs.writeFile(`${ROOT}/${label}-post.jpg`, post.buffer);
  const postPos = findCursorByTemplateSet(post.decoded, templates, { minScore: 0.6 });

  if (!prePos || !postPos) {
    console.error(`${label}: pre=${prePos ? 'ok' : 'null'} post=${postPos ? 'ok' : 'null'} — detection failed`);
    return;
  }

  const dxActual = postPos.position.x - prePos.position.x;
  const totalMickeys = dx * callCount;
  const predictedFromOldModel = totalMickeys * 0.5;  // approx old prediction
  const predictedFromNewModel = callCount * 52;       // per-call hypothesis
  console.error(
    `${label}: ${callCount} calls × ${dx} mickeys (= ${totalMickeys} mickeys total)\n` +
    `  pre=(${prePos.position.x},${prePos.position.y}) post=(${postPos.position.x},${postPos.position.y})\n` +
    `  actual displacement = ${dxActual} px\n` +
    `  per-call avg = ${(dxActual / callCount).toFixed(1)} px\n` +
    `  old-model predicted ~${predictedFromOldModel.toFixed(0)} px\n` +
    `  per-call hypothesis predicted ~${predictedFromNewModel} px (${callCount} × 52)`,
  );
}

async function main(): Promise<void> {
  console.error(`Phase 207: per-call displacement hypothesis test`);

  // Seed template first
  console.error('Seeding cursor template...');
  await fs.rm(DEFAULT_TEMPLATE_DIR, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(DEFAULT_TEMPLATE_DIR, { recursive: true });
  await ipadGoHome(client);
  await new Promise(r => setTimeout(r, 800));
  await client.mouseMoveRelative(20, 0);
  await new Promise(r => setTimeout(r, 100));
  const seed = await seedCursorTemplate(client, { settleMs: 80, emitDx: 80 });
  if (!seed.ok) {
    console.error(`Seed failed: ${seed.reason}`);
    process.exit(1);
  }
  console.error(`Seeded at (${seed.cursorPosition?.x}, ${seed.cursorPosition?.y})`);

  // Test runs
  console.error('\n--- Run A: 10 calls × magnitude=5 ---');
  await runOne('A-mag5', 5, NUM_CALLS);

  console.error('\n--- Run B: 10 calls × magnitude=127 ---');
  await runOne('B-mag127', 127, NUM_CALLS);

  console.error('\n--- Run C: 10 calls × magnitude=20 ---');
  await runOne('C-mag20', 20, NUM_CALLS);

  console.error('\nIf per-call hypothesis: A, B, C all ≈ 520 px (10 × 52).');
  console.error('If old lookup model: B >> A (more mickeys = more pixels).');
}

await main();
process.exit(0);
