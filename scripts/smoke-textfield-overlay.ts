/**
 * Smoke test for the text-field overlay protocol addition.
 *
 * Sequence:
 *   1. start WS server, wait for iPad app to connect
 *   2. show a light-grey background (so the overlay + cursor stand out)
 *   3. send set-overlay with a 300×40 text-field rect centered on screen
 *   4. move cursor into the rect
 *   5. screenshot via PiKVM, save to data/_smoke-textfield/
 *   6. clear overlay, screenshot again for the no-overlay baseline
 *
 * Inspect the two resulting JPEGs by eye — the overlay frame should show
 * a thin-bordered rect with an I-beam cursor inside, the baseline frame
 * should show the same screen with a system arrow somewhere.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  killOrphansOnPort,
  startIpadAppServer,
  type IpadSession,
} from '../src/pikvm/ipad-app-ws.js';
import {
  buildTransform,
  detectIpadRegion,
  NATIVE_MARGIN,
} from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSession(): Promise<{
  sess: IpadSession;
  closeServer: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = startIpadAppServer({
      port: PORT,
      async onSession(sess) {
        resolve({ sess, closeServer: () => server.close() });
      },
    });
    setTimeout(() => reject(new Error('iPad app did not connect in 60 s')), 60_000);
  });
}

async function main() {
  killOrphansOnPort(PORT);
  console.log(`[smoke] WS server on :${PORT}, waiting for iPad app…`);
  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  console.log(`[smoke] connected: ${JSON.stringify(sess.hello)}`);

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Light grey background so cursor + overlay border are visible.
  await sess.showScene({
    kind: 'procedural',
    proc_kind: 'solid',
    params: { r: 0.85, g: 0.85, b: 0.85 },
  });
  await sleep(400);

  // Calibrate iPad region.
  const cal = await client.screenshot();
  const region = await detectIpadRegion(cal.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
    frameW: region.frameW,
    frameH: region.frameH,
  };
  void buildTransform(tight, sess.hello.logicalW, sess.hello.logicalH);
  console.log(
    `[smoke] iPad region: x=${tight.x} y=${tight.y} w=${tight.w} h=${tight.h}`,
  );

  // Wake pointer.
  for (let i = 0; i < 3; i++) {
    await client.mouseMoveRelative(30, 30);
    await client.mouseMoveRelative(-30, -30);
    await sleep(150);
  }
  const probe = await sess.getCursor();
  console.log(`[smoke] cursor woke at (${probe.x.toFixed(1)}, ${probe.y.toFixed(1)})`);

  const outDir = path.join('data', '_smoke-textfield');
  await fs.mkdir(outDir, { recursive: true });

  // ---- Frame 1: overlay ON, cursor centered on it ----
  const overlayW = 300;
  const overlayH = 40;
  const overlayX = sess.hello.logicalW / 2 - overlayW / 2;
  const overlayY = sess.hello.logicalH / 2 - overlayH / 2;
  await sess.setOverlay({
    kind: 'text-field',
    x: overlayX,
    y: overlayY,
    w: overlayW,
    h: overlayH,
  });
  await sleep(300);

  // Iteratively move cursor inside the overlay rect. Single mickey
  // emit is capped at 127 (~178 logical px), so for a center-screen
  // target from a top-left wake we need multiple emits.
  const desiredX = overlayX + overlayW / 2;
  const desiredY = overlayY + overlayH / 2;
  const mickeyPerLogical = 1 / 1.4;
  for (let i = 0; i < 12; i++) {
    const cur = await sess.getCursor();
    const dxL = desiredX - cur.x;
    const dyL = desiredY - cur.y;
    if (Math.abs(dxL) < 8 && Math.abs(dyL) < 8) break;
    const dxM = Math.max(-110, Math.min(110, Math.round(dxL * mickeyPerLogical)));
    const dyM = Math.max(-110, Math.min(110, Math.round(dyL * mickeyPerLogical)));
    await client.mouseMoveRelative(dxM, dyM);
    await sleep(120);
  }
  await sleep(400);
  const after = await sess.getCursor();
  console.log(
    `[smoke] cursor after move = (${after.x.toFixed(1)}, ${after.y.toFixed(1)}), target = (${desiredX}, ${desiredY})`,
  );

  const shot1 = await client.screenshot();
  const p1 = path.join(outDir, 'frame-1-overlay-on.jpg');
  await fs.writeFile(p1, shot1.buffer);
  console.log(`[smoke] saved ${p1}`);

  // ---- Frame 2: overlay OFF, baseline ----
  await sess.setOverlay({ kind: 'none' });
  await sleep(400);
  const shot2 = await client.screenshot();
  const p2 = path.join(outDir, 'frame-2-overlay-off.jpg');
  await fs.writeFile(p2, shot2.buffer);
  console.log(`[smoke] saved ${p2}`);

  await closeServer();
  console.log('[smoke] done — inspect the two JPEGs by eye');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
