/**
 * Navigate Settings → Accessibility → Pointer Control → Colour using
 * v9-bordered ML detector (the 90% click rate path) and screenshot each
 * settings panel for the README/docs.
 *
 * Approach: use moveToPixel from move-to.ts with PIKVM_V8_CALIBRATE=1
 * + cursor-v9-bordered.onnx for the calibration step, then click via
 * the client's HID click endpoint. Avoids the deployed-MCP path which
 * lacks v9-bordered.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { takeRawScreenshot } from '../src/pikvm/cursor-detect.js';
import { moveToPixel } from '../src/pikvm/move-to.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);

const OUT = path.resolve(process.cwd(), 'docs/screenshots/ipad-settings');
await fs.mkdir(OUT, { recursive: true });

async function shot(name: string): Promise<void> {
  await new Promise(r => setTimeout(r, 600));
  const jpg = await takeRawScreenshot(client);
  await fs.writeFile(path.join(OUT, `${name}.jpg`), jpg);
  console.log(`  → ${name}.jpg`);
}

async function clickAt(x: number, y: number, label: string): Promise<void> {
  console.log(`click ${label} at (${x}, ${y})`);
  await moveToPixel(client, { x, y }, { strategy: 'detect-then-move', forbidSlamFallback: true });
  await new Promise(r => setTimeout(r, 200));
  await client.mouseClick('left');
}

// Currently on Accessibility pane after unlock. Pointer Control row is
// at ~(1090, 847) on the right pane. Click it.
await shot('00-accessibility-pane');
await clickAt(1090, 847, 'Pointer Control row');
await shot('01-pointer-control');

// On Pointer Control screen, the Colour row is at ~(1090, 280).
await clickAt(1090, 280, 'Colour row');
await shot('02-colour-picker');

// Back to Pointer Control (just for completeness)
console.log('back via top-left back arrow at ~(930, 100)');
await clickAt(930, 100, 'back arrow');
await shot('03-pointer-control-final');

console.log(`\nAll screens saved to ${OUT}`);
