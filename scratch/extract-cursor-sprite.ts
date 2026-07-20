/**
 * Extract the EXACT iPad cursor sprite (RGBA, true alpha) via two-background
 * alpha matting: capture the cursor on solid BLACK and solid WHITE (same
 * position) → per pixel: alpha = 1 - (white-black)/255, color = black/alpha.
 * This is the foundational asset for the diverse-background compositing pipeline.
 * Saves ml/cursor-sprite.png. Uses iPadCollector showScene(procedural solid) +
 * getCursor ground truth for the cursor position.
 */
import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { killOrphansOnPort, startIpadAppServer, type IpadSession } from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767, IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', IPAD_BUNDLE_ID = 'com.bb.iPadCollector';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIN = 90; // crop half-size around cursor

function relaunch() { try { execSync(`xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`, { stdio: 'pipe' }); } catch { /* */ } }
function waitForSession(timeoutMs = 30_000): Promise<{ sess: IpadSession; close: () => Promise<void> }> {
  let first: IpadSession | null = null;
  return new Promise((resolve, reject) => {
    const stop = startIpadAppServer({ port: PORT, onSession: async (sess) => { if (first) return; first = sess; const t0 = Date.now(); while (!sess.hello && Date.now() - t0 < 5000) await sleep(20); resolve({ sess, close: async () => { (await stop).close(); } }); } });
    setTimeout(() => { if (!first) { stop.then((s) => s.close()).catch(() => undefined); reject(new Error('no connect')); } }, timeoutMs);
  });
}
async function slamCenter(c: PiKVMClient) { for (let s = 0; s < 6; s++) await c.mouseMoveRelative(-127, -127); await sleep(200); await c.mouseMoveRelative(127, 127); await c.mouseMoveRelative(127, 127); await sleep(300); }

async function main() {
  killOrphansOnPort(PORT);
  const client = new PiKVMClient(loadConfig().pikvm);
  await ipadGoHome(client); await sleep(1500);
  const home = await client.screenshot();
  const region = await detectIpadRegion(home.buffer);
  const tight = { x: region.x + NATIVE_MARGIN, y: region.y + NATIVE_MARGIN, w: region.w - 2 * NATIVE_MARGIN, h: region.h - 2 * NATIVE_MARGIN };
  relaunch(); await sleep(3000);
  const { sess, close } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  const toHdmi = (x: number, y: number) => ({ x: tight.x + (x / sess.hello!.logicalW) * tight.w, y: tight.y + (y / sess.hello!.logicalH) * tight.h });
  await slamCenter(client);
  const alive = await sess.awaitPointerAlive(async () => { await client.mouseMoveRelative(50, 50); await sleep(80); await client.mouseMoveRelative(-50, -50); await sleep(200); });
  if (!alive) { await close().catch(() => undefined); throw new Error('pointer not alive'); }
  const gt = async () => { for (let i = 0; i < 5; i++) { const c = await sess.getTrackedCursor(); if (c) return toHdmi(c.x, c.y); await sleep(120); } return null; };

  // solid BLACK background
  await sess.showScene({ kind: 'procedural', proc_kind: 'solid', params: { r: 0, g: 0, b: 0 } }); await sleep(700);
  // move cursor to mid-screen (keep it awake + on the solid bg)
  await client.mouseMoveRelative(30, 30); await sleep(120); await client.mouseMoveRelative(-30, -30); await sleep(400);
  const pos = await gt();
  if (!pos) { await close().catch(() => undefined); throw new Error('no getCursor'); }
  console.error(`cursor at HDMI (${pos.x.toFixed(0)},${pos.y.toFixed(0)})`);
  const shotBlack = await client.screenshot();
  // solid WHITE background (cursor stays put)
  await sess.showScene({ kind: 'procedural', proc_kind: 'solid', params: { r: 1, g: 1, b: 1 } }); await sleep(700);
  const shotWhite = await client.screenshot();
  await close().catch(() => undefined);

  const box = { left: Math.round(pos.x - WIN), top: Math.round(pos.y - WIN), width: WIN * 2, height: WIN * 2 };
  const blk = await sharp(shotBlack.buffer).extract(box).raw().toBuffer();
  const wht = await sharp(shotWhite.buffer).extract(box).raw().toBuffer();
  await fs.writeFile('scratch/sprite-on-black.jpg', await sharp(shotBlack.buffer).extract(box).jpeg().toBuffer());
  await fs.writeFile('scratch/sprite-on-white.jpg', await sharp(shotWhite.buffer).extract(box).jpeg().toBuffer());
  const n = WIN * 2 * WIN * 2;
  const rgba = Buffer.alloc(n * 4);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    // per-channel alpha estimate, averaged
    let aSum = 0;
    for (let ch = 0; ch < 3; ch++) { const b = blk[i * 3 + ch], w = wht[i * 3 + ch]; aSum += 1 - Math.max(0, Math.min(255, w - b)) / 255; }
    let a = aSum / 3; a = Math.max(0, Math.min(1, a));
    for (let ch = 0; ch < 3; ch++) { const b = blk[i * 3 + ch]; rgba[i * 4 + ch] = a > 0.02 ? Math.max(0, Math.min(255, Math.round(b / a))) : 0; }
    rgba[i * 4 + 3] = Math.round(a * 255);
    if (a > 0.5) opaque++;
  }
  await sharp(rgba, { raw: { width: WIN * 2, height: WIN * 2, channels: 4 } }).png().toFile('ml/cursor-sprite.png');
  console.error(`saved ml/cursor-sprite.png (${WIN * 2}x${WIN * 2}, ${opaque} opaque px). Also sprite-on-black/white.jpg for inspection.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
