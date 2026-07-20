/**
 * Diagnose the Maps miss with getCursor GROUND TRUTH. Per attempt toward Maps:
 * log V8-start vs getCursor-start (is the START detection wrong?), then the emit,
 * then getCursor-final vs target (real miss distance) and V8-final. Correlate:
 * when the move misses, is it because V8-start disagreed with ground truth?
 */
import { execSync } from 'node:child_process';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { findCursorByV8FullFrame } from '../src/pikvm/cursor-ml-detect.js';
import { planAxisEmits, EMIT_CURVE_X, FULL_REPORT_PX, Y_SCALE } from '../src/pikvm/curve-mover.js';
import { killOrphansOnPort, startIpadAppServer, type IpadSession } from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767, IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353', IPAD_BUNDLE_ID = 'com.bb.iPadCollector';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGET = { x: 1162, y: 570 }; // Maps
const CURVE_Y = EMIT_CURVE_X.map(([m, p]) => [m, p * Y_SCALE] as const) as unknown as ReadonlyArray<readonly [number, number]>;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function relaunchIpadApp() { try { execSync(`xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`, { stdio: 'pipe' }); } catch { /* */ } }
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
  const sceneJpeg = await sharp(home.buffer).extract({ left: Math.round(region.x), top: Math.round(region.y), width: Math.round(region.w), height: Math.round(region.h) }).jpeg({ quality: 80 }).toBuffer();
  relaunchIpadApp(); await sleep(3000);
  const { sess, close } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  await sess.showScene({ kind: 'image', image: sceneJpeg.toString('base64') }); await sleep(800);
  const toHdmi = (x: number, y: number) => ({ x: tight.x + (x / sess.hello!.logicalW) * tight.w, y: tight.y + (y / sess.hello!.logicalH) * tight.h });
  await slamCenter(client);
  const alive = await sess.awaitPointerAlive(async () => { await client.mouseMoveRelative(50, 50); await sleep(80); await client.mouseMoveRelative(-50, -50); await sleep(200); });
  if (!alive) { await close().catch(() => undefined); throw new Error('pointer not alive'); }
  const gt = async () => { for (let i = 0; i < 5; i++) { const c = await sess.getTrackedCursor(); if (c) return toHdmi(c.x, c.y); await sleep(120); } return null; };
  const v8 = async () => { const s = await client.screenshot({ quality: 80 }); const r = await findCursorByV8FullFrame(s.buffer, s.screenshotWidth, s.screenshotHeight); return r ? { x: r.x, y: r.y } : null; };

  console.error(`\nMaps (${TARGET.x},${TARGET.y}) move diagnostic — V8-start vs getCursor GROUND TRUTH:`);
  console.error(`n\tGT_start\tV8_start\tstartGap\tGT_final→tgt\tV8_final→tgt\tMISS?`);
  for (let n = 0; n < 15; n++) {
    await slamCenter(client);
    const gt0 = await gt();
    const v8_0 = await v8();
    if (!v8_0 || !gt0) { console.error(`${n}\t(detect null, skip)`); continue; }
    // emit toward target from the V8 start (exactly as the mover does)
    for (const e of planAxisEmits(TARGET.x - v8_0.x, FULL_REPORT_PX, EMIT_CURVE_X)) { await client.mouseMoveRelative(e, 0); await sleep(110); }
    for (const e of planAxisEmits(TARGET.y - v8_0.y, FULL_REPORT_PX * Y_SCALE, CURVE_Y)) { await client.mouseMoveRelative(0, e); await sleep(110); }
    await sleep(300);
    const gt1 = await gt();
    const v8_1 = await v8();
    const startGap = dist(v8_0, gt0);
    const gtRes = gt1 ? dist(gt1, TARGET) : NaN;
    const v8Res = v8_1 ? dist(v8_1, TARGET) : NaN;
    const miss = gtRes > 40;
    console.error(`${n}\t(${gt0.x.toFixed(0)},${gt0.y.toFixed(0)})\t(${v8_0.x},${v8_0.y})\t${startGap.toFixed(0)}px\t${gtRes.toFixed(0)}px\t${v8Res.toFixed(0)}px\t${miss ? 'MISS' : ''}`);
  }
  await close().catch(() => undefined);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
