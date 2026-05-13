/**
 * Phase 303: verify that chunked emits reach the target while a single
 * big emit gets clamped to -127.
 *
 * Test: drive cursor from home to Books (642, 810) using:
 *   A) Single emit of -348 mickeys (current Phase 302 test approach)
 *   B) Chunked emits of -50 mickeys × 7 with 50ms between
 *
 * Capture post-emit screenshot for each. Inspect visually.
 */
import { promises as fs } from 'fs';
import { loadConfig } from './src/config.js';
import { PiKVMClient } from './src/pikvm/client.js';
import { ipadGoHome, unlockIpad } from './src/pikvm/ipad-unlock.js';
import { VERSION } from './src/version.js';

const cfg = loadConfig();
const client = new PiKVMClient(cfg.pikvm);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ROOT = `./data/phase303-chunked/${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
await fs.mkdir(ROOT, { recursive: true });
console.error(`=== Phase 303 chunked-emit test at v${VERSION} ===`);
console.error(`Output: ${ROOT}\n`);

await unlockIpad(client, { dragPx: 1500 });
await sleep(800);

// === TEST A: single big emit ===
console.error(`\n--- TEST A: single emit of -348 mickeys ---`);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);
await client.mouseMoveRelative(5, 5);
await sleep(200);
await client.mouseMoveRelative(-5, -5);
await sleep(400);

console.error(`  emitting (-348, 32) in single call`);
await client.mouseMoveRelative(-348, 32);
await sleep(800);
const shotA = await client.screenshot();
await fs.writeFile(`${ROOT}/A_single_emit.jpg`, shotA.buffer);
console.error(`  saved A_single_emit.jpg`);

// === TEST B: chunked emit ===
console.error(`\n--- TEST B: chunked emit, 7×-50 mickeys with 50ms between ---`);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);
await client.mouseMoveRelative(5, 5);
await sleep(200);
await client.mouseMoveRelative(-5, -5);
await sleep(400);

console.error(`  emitting 7 chunks of (-50, 5)...`);
for (let i = 0; i < 7; i++) {
  await client.mouseMoveRelative(-50, 5);
  await sleep(50);
}
await sleep(800);
const shotB = await client.screenshot();
await fs.writeFile(`${ROOT}/B_chunked_emit.jpg`, shotB.buffer);
console.error(`  saved B_chunked_emit.jpg`);

// === TEST C: chunked even smaller ===
console.error(`\n--- TEST C: very fine chunks, 35×-10 mickeys with 30ms between ---`);
await ipadGoHome(client, { forceHomeViaSwipe: true });
await sleep(1500);
await client.mouseMoveRelative(5, 5);
await sleep(200);
await client.mouseMoveRelative(-5, -5);
await sleep(400);

console.error(`  emitting 35 chunks of (-10, 1)...`);
for (let i = 0; i < 35; i++) {
  await client.mouseMoveRelative(-10, 1);
  await sleep(30);
}
await sleep(800);
const shotC = await client.screenshot();
await fs.writeFile(`${ROOT}/C_fine_chunks.jpg`, shotC.buffer);
console.error(`  saved C_fine_chunks.jpg`);

console.error(`\n=== Done. Inspect ${ROOT}/A_single_emit.jpg, B_chunked_emit.jpg, C_fine_chunks.jpg`);
console.error(`Target: Books icon at (642, 810). Compare cursor positions.`);
process.exit(0);
