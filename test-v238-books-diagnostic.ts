/**
 * v0.5.238 single-trial diagnostic for Books NULL.
 *
 * The 10-trial bench showed multi-hint did NOT help. This script
 * runs ONE trial with verbose logging to find why:
 *   - What is belief.position when the click starts?
 *   - What hints does multi-hint actually pass to ML?
 *   - Is the cursor visible in the pre-click screenshot?
 *   - What does ML return for each hint?
 */
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { findCursorByML, findCursorByMLMultiHint } from './src/pikvm/cursor-ml-detect.js';
import { findCursorByShape } from './src/pikvm/cursor-shape-detect.js';
import { decodeScreenshot } from './src/pikvm/cursor-detect.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/v238-books-diag/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });

console.error(`=== v0.5.238 Books NULL diagnostic at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);

console.error(`Belief after unlock+home:`);
console.error(`  position = ${JSON.stringify(client.belief?.position)}`);
console.error(`  velocity = ${JSON.stringify(client.belief?.velocity)}`);
console.error(`  variance = ${JSON.stringify(client.belief?.variance)}`);

// Take a screenshot in the home state
const shot1 = await client.screenshot();
const shot1Decoded = await decodeScreenshot(shot1.buffer);
await fs.writeFile(path.join(ROOT, '01-home-state.jpg'), shot1.buffer);
console.error(`\nSaved home-state screenshot: ${shot1Decoded.width}×${shot1Decoded.height}`);

// Now try a single emit toward Books (640, 800) from home
// Cursor starts wherever belief says it is
const target = { x: 640, y: 800 };
const beliefPos = client.belief?.position ?? { x: 1060, y: 778 };
const dx = target.x - beliefPos.x;
const dy = target.y - beliefPos.y;

console.error(`\nEmitting toward Books (${target.x}, ${target.y}) from belief (${beliefPos.x.toFixed(0)}, ${beliefPos.y.toFixed(0)}):`);
console.error(`  dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);

// Use raw mouseMoveRelative
await client.mouseMoveRelative(Math.round(dx / 1.3), Math.round(dy / 1.3));
await sleep(500);

console.error(`\nBelief after emit:`);
console.error(`  position = ${JSON.stringify(client.belief?.position)}`);

const shot2 = await client.screenshot();
const shot2Decoded = await decodeScreenshot(shot2.buffer);
await fs.writeFile(path.join(ROOT, '02-post-emit.jpg'), shot2.buffer);
console.error(`Saved post-emit screenshot: ${shot2Decoded.width}×${shot2Decoded.height}`);

// Test ML at multiple positions to find the cursor
console.error('\n--- ML probe (multi-position) ---');
const testPositions: Array<{ name: string; x: number; y: number }> = [
  { name: 'predicted (target)', x: target.x, y: target.y },
  { name: 'belief.position', x: Math.round((client.belief?.position.x ?? 0)), y: Math.round((client.belief?.position.y ?? 0)) },
  { name: 'home (1060, 778)', x: 1060, y: 778 },
  { name: 'screen-center (840, 525)', x: 840, y: 525 },
  { name: 'mid-screen (640, 525)', x: 640, y: 525 },
];

for (const p of testPositions) {
  const r = await findCursorByML(shot2.buffer, shot2Decoded.width, shot2Decoded.height, {
    hint: { x: p.x, y: p.y },
    minConfidence: 0.0,  // get raw result even if low
  });
  if (r) {
    console.error(
      `  hint=${p.name.padEnd(28)} → ML=(${r.x.toString().padStart(4)},${r.y.toString().padStart(4)}) ` +
      `conf=${r.confidence.toFixed(3)} crop=(${r.crop.left},${r.crop.top})`,
    );
  } else {
    console.error(`  hint=${p.name.padEnd(28)} → ML returned null`);
  }
}

// Test multi-hint directly
console.error('\n--- Multi-hint test ---');
const hints = [target, beliefPos];
const multiResult = await findCursorByMLMultiHint(shot2.buffer, shot2Decoded.width, shot2Decoded.height, hints, { minConfidence: 0.0 });
if (multiResult) {
  console.error(`  multi-hint result: (${multiResult.x},${multiResult.y}) conf=${multiResult.confidence.toFixed(3)}`);
} else {
  console.error(`  multi-hint returned null`);
}

// Try heuristic shape detect at home + at target
console.error('\n--- Shape detect (heuristic fallback) ---');
for (const p of [{ name: 'home', x: 1060, y: 778 }, { name: 'target', x: target.x, y: target.y }, { name: 'no-hint', x: -1, y: -1 }]) {
  const opts: any = p.x >= 0 ? { expectedNear: p, expectedNearRadius: 200 } : {};
  const r = findCursorByShape(shot2Decoded.rgb, shot2Decoded.width, shot2Decoded.height, opts);
  if (r) {
    console.error(`  ${p.name.padEnd(8)} → shape=(${Math.round(r.centroidX)},${Math.round(r.centroidY)}) score=${r.score?.toFixed(2)}`);
  } else {
    console.error(`  ${p.name.padEnd(8)} → shape returned null`);
  }
}

console.error(`\nInspect: open ${ROOT}/02-post-emit.jpg`);
process.exit(0);
