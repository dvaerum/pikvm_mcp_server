/**
 * Diagnostic: why does pinned-cursor positioning fail?
 *
 * Steps:
 *   1. unlockIpad
 *   2. Take screenshot, run v8, report position
 *   3. Emit a known +50 px move via mouseMoveRelative
 *   4. Take screenshot, run v8, report position
 *   5. Repeat with -50 px (back to start)
 *
 * Expected: v8 reports cursor in step 2, cursor moves ~50 px between
 * step 2 and step 4, then back in step 5.
 *
 * If step 2 fails: cursor isn't visible / v8 is broken
 * If step 4 == step 2: cursor isn't moving
 * If step 4 differs from step 2 but by wildly wrong amount: ratio is off
 */
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { unlockIpad } from '../src/pikvm/ipad-unlock.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

async function pos(label: string) {
  const jpg = await takeRawScreenshot(client);
  const v8 = await findCursorByV8FullFrame(jpg, 1680, 1050, { minPresence: 0 });
  if (!v8) {
    console.log(`  ${label}: v8 returned null`);
    return null;
  }
  console.log(`  ${label}: v8=(${v8.x}, ${v8.y}) presence=${v8.presence.toFixed(3)} peak=${v8.heatmapPeak.toFixed(3)}`);
  return { x: v8.x, y: v8.y };
}

async function main() {
  console.log('Step 1: unlock');
  await unlockIpad(client, {});
  await new Promise((r) => setTimeout(r, 500));

  console.log('Step 2: where does v8 see the cursor?');
  const p1 = await pos('  before any move');

  console.log('Step 3: emit +50, 0 (move right 50 mickeys)');
  await client.mouseMoveRelative(50, 0);
  await new Promise((r) => setTimeout(r, 400));

  console.log('Step 4: where now?');
  const p2 = await pos('  after +50');
  if (p1 && p2) {
    console.log(`  delta: (${p2.x - p1.x}, ${p2.y - p1.y}) px from +50 mickey emit`);
  }

  console.log('Step 5: emit -50, 0 (move back)');
  await client.mouseMoveRelative(-50, 0);
  await new Promise((r) => setTimeout(r, 400));
  const p3 = await pos('  after -50');
  if (p2 && p3) {
    console.log(`  delta: (${p3.x - p2.x}, ${p3.y - p2.y}) px from -50 mickey emit`);
  }

  console.log('Step 6: try emitting toward Settings target (1027, 825) from current position');
  if (p3) {
    const dx = 1027 - p3.x;
    const dy = 825 - p3.y;
    const mx = Math.round(dx / 1.3);
    const my = Math.round(dy / 1.3);
    const cmx = Math.max(-127, Math.min(127, mx));
    const cmy = Math.max(-127, Math.min(127, my));
    console.log(`  delta needed: (${dx}, ${dy}) px → (${mx}, ${my}) mickeys → clamped (${cmx}, ${cmy})`);
    await client.mouseMoveRelative(cmx, cmy);
    await new Promise((r) => setTimeout(r, 400));
    const p4 = await pos('  after emit toward target');
    if (p4) {
      console.log(`  result: (${p4.x - p3.x}, ${p4.y - p3.y}) px change for (${cmx}, ${cmy}) mickey emit`);
      console.log(`  distance to target (1027, 825): ${Math.hypot(p4.x - 1027, p4.y - 825).toFixed(0)} px`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
