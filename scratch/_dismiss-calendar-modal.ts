/**
 * Move cursor to the X button at top-left of the Calendar "New Event"
 * modal (~1015, 237) and click. Detector says cursor is currently around
 * (990, 340) so we need to move up-left.
 *
 * Uses the new orange-cursor detector to find current position, computes
 * delta to target, emits via mouseMoveRelative, then clicks.
 */
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import sharp from 'sharp';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

async function wherrCursor(): Promise<{ x: number; y: number } | null> {
  await client.mouseMoveRelative(1, 0);
  await client.mouseMoveRelative(-1, 0);
  await new Promise(r => setTimeout(r, 250));
  const jpg = await takeRawScreenshot(client);
  const meta = await sharp(jpg).metadata();
  const r = await findCursorByV8FullFrame(jpg, meta.width!, meta.height!, { minPresence: 0.3 });
  return r ? { x: r.x, y: r.y } : null;
}

const target = { x: 1015, y: 237 };

let pos = await wherrCursor();
console.log(`start cursor: ${pos ? `(${pos.x}, ${pos.y})` : 'NULL'}`);

// Step 1: emit to target. Use ballistic ratio of ~1 mickey per pixel as rough guess.
if (pos) {
  const dx = Math.round(target.x - pos.x);
  const dy = Math.round(target.y - pos.y);
  console.log(`emit dx=${dx} dy=${dy}`);
  await client.mouseMoveRelative(dx, dy);
  await new Promise(r => setTimeout(r, 400));
}

pos = await wherrCursor();
console.log(`after move: ${pos ? `(${pos.x}, ${pos.y})` : 'NULL'}`);

// Step 2: if still far, do another correction
if (pos) {
  const dx2 = Math.round(target.x - pos.x);
  const dy2 = Math.round(target.y - pos.y);
  const dist = Math.hypot(dx2, dy2);
  if (dist > 20) {
    console.log(`correction dx=${dx2} dy=${dy2} (dist=${dist.toFixed(1)})`);
    await client.mouseMoveRelative(dx2, dy2);
    await new Promise(r => setTimeout(r, 300));
  }
}

pos = await wherrCursor();
console.log(`pre-click: ${pos ? `(${pos.x}, ${pos.y})` : 'NULL'}`);

// Step 3: click via HID button down/up
await client.mouseClick('left');
await new Promise(r => setTimeout(r, 500));
console.log('clicked');
