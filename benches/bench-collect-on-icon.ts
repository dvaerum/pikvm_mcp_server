/**
 * 4.1' Targeted Books-icon collection mode.
 *
 * Collects training frames of the cursor sitting on or near iPad home-
 * screen icons (Books, Settings, AppStore, Files), with small intra-icon
 * offsets. The 1.13b/4.1' audit identified detector hallucination at
 * cursor-on-orange-icon — the orange Books cursor on the orange Books
 * tile is low-contrast and confuses v9/v11/v12.
 *
 * Strategy (mirrors bench-ground-truth-clickflow):
 *   1. Take a PiKVM home-screen screenshot
 *   2. Crop to the iPad region and send it to iPadCollector as an
 *      `image` scene — visual surface is the real home screen
 *   3. Drive cursor to small offsets (±5–20 px) around each icon's
 *      HDMI center, using the moveToPixel pipeline so cursor placement
 *      matches production conditions
 *   4. For each landing: read cursor position via iPadCollector ground
 *      truth, take a PiKVM screenshot, save with the ground-truth label
 *
 * Per-icon coverage: TARGET frames split across the 4 icons. Offsets
 * sampled from a 2D Gaussian around each icon center (σ=10 HDMI px,
 * truncated to ±25 px) so the distribution emphasises on-icon and
 * near-icon positions, not random wandering.
 *
 * Usage:
 *   npx tsx benches/bench-collect-on-icon.ts --target 20
 *
 * Output: data/cursor-collect-on-icon-{TS}/ with verified.jsonl (same
 * schema as bench-collect-synthetic) so v13 trainer can load it
 * unchanged.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';
import { killOrphansOnPort, startIpadAppServer, type IpadSession } from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767;
const IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353';
const IPAD_BUNDLE_ID = 'com.bb.iPadCollector';
const TARGET = (() => {
  const i = process.argv.indexOf('--target');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 20;
})();

const TARGETS_HDMI = [
  { name: 'Settings',  x: 1027, y: 837 },
  { name: 'Books',     x: 757,  y: 837 },
  { name: 'AppStore',  x: 1027, y: 702 },
  { name: 'Files',     x: 1162, y: 435 },
];

const OFFSET_SIGMA_PX = 10;
const OFFSET_MAX_PX = 25;
const SETTLE_MS = 200;

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function relaunchIpadApp(): void {
  try {
    execSync(
      `xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`,
      { stdio: 'pipe' },
    );
  } catch { /* best effort */ }
}

async function waitForSession(): Promise<{ sess: IpadSession; closeServer: () => Promise<void> }> {
  return new Promise((resolve) => {
    const stop = startIpadAppServer({
      port: PORT,
      onSession: async (sess) => {
        const startedAt = Date.now();
        while (!sess.hello && Date.now() - startedAt < 5000) await sleep(20);
        resolve({ sess, closeServer: async () => { (await stop).close(); } });
      },
    });
  });
}

function gaussian(): number {
  // Box-Muller transform. Returns N(0,1).
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleOffset(): { dx: number; dy: number } {
  const dx = Math.max(-OFFSET_MAX_PX, Math.min(OFFSET_MAX_PX, gaussian() * OFFSET_SIGMA_PX));
  const dy = Math.max(-OFFSET_MAX_PX, Math.min(OFFSET_MAX_PX, gaussian() * OFFSET_SIGMA_PX));
  return { dx: Math.round(dx), dy: Math.round(dy) };
}

async function main(): Promise<void> {
  killOrphansOnPort(PORT);
  console.error(`[on-icon] target=${TARGET} frames across ${TARGETS_HDMI.length} icons`);

  // Step 1: home-screen capture from PiKVM while iPadCollector NOT
  // foreground (so the real home screen is visible).
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);
  await ipadGoHome(client);
  await sleep(1500);
  console.error('[on-icon] capturing home-screen screenshot…');
  const homeShot = await client.screenshot();
  const region = await detectIpadRegion(homeShot.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
  };
  console.error(`[on-icon] iPad tight region: ${JSON.stringify(tight)}`);

  const croppedJpeg = await sharp(homeShot.buffer)
    .extract({ left: tight.x, top: tight.y, width: tight.w, height: tight.h })
    .jpeg({ quality: 80 })
    .toBuffer();
  const croppedB64 = croppedJpeg.toString('base64');
  console.error(`[on-icon] cropped home jpeg q=80: ${croppedJpeg.byteLength} bytes`);

  // Step 2: launch iPadCollector.
  relaunchIpadApp();
  await sleep(3000);
  console.error('[on-icon] waiting for iPad app to connect…');
  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello payload');
  console.error(`[on-icon] connected: logicalW=${sess.hello.logicalW} logicalH=${sess.hello.logicalH}`);

  // HDMI <-> iPad-logical conversions.
  const ipadToHdmi = (x: number, y: number) => ({
    x: tight.x + (x / sess.hello!.logicalW) * tight.w,
    y: tight.y + (y / sess.hello!.logicalH) * tight.h,
  });
  const hdmiToIpad = (x: number, y: number) => ({
    x: ((x - tight.x) / tight.w) * sess.hello!.logicalW,
    y: ((y - tight.y) / tight.h) * sess.hello!.logicalH,
  });

  // Step 3: scene is the cropped home screenshot.
  await sess.showScene({ kind: 'image', image: croppedB64 });
  await sleep(800);
  await sess.syncClock(5);

  // Wake the iPad pointer system. Until .onContinuousHover fires at
  // least once, PointerTracker.last is nil and the app reports (0,0).
  // First slam cursor toward iPad center so it's definitely inside
  // iPadCollector's view, THEN wiggle to generate hover events.
  console.error('[on-icon] waking pointer…');
  await client.mouseMoveRelative(-2000, -2000);
  await sleep(150);
  await client.mouseMoveRelative(-2000, -2000);
  await sleep(150);
  // Now move toward iPad center (~410, 590 logical)
  await client.mouseMoveRelative(800, 1000);
  await sleep(300);
  for (let attempt = 0; attempt < 8; attempt++) {
    await client.mouseMoveRelative(50, 50);
    await sleep(80);
    await client.mouseMoveRelative(-50, -50);
    await sleep(200);
    try {
      const probe = await sess.getCursor();
      if (probe.x !== 0 || probe.y !== 0) {
        console.error(`[on-icon] pointer alive at (${probe.x.toFixed(1)}, ${probe.y.toFixed(1)})`);
        break;
      }
    } catch {}
    if (attempt === 7) console.error('[on-icon] WARNING: pointer never woke; frames may be skipped');
  }

  // Output dir + jsonl.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outDir = path.join('data', `cursor-collect-on-icon-${ts}`);
  await fs.mkdir(path.join(outDir, 'on-icon'), { recursive: true });
  const jsonlPath = path.join(outDir, 'verified.jsonl');
  const manifestPath = path.join(outDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    ts,
    target: TARGET,
    icons: TARGETS_HDMI,
    offsetSigmaPx: OFFSET_SIGMA_PX,
    offsetMaxPx: OFFSET_MAX_PX,
    tight,
    logicalW: sess.hello.logicalW,
    logicalH: sess.hello.logicalH,
  }, null, 2));
  await fs.writeFile(path.join(outDir, 'scene.jpg'), croppedJpeg);
  console.error(`[on-icon] output: ${outDir}`);

  // Step 4: collection loop. Round-robin across icons so each gets
  // roughly TARGET/4 frames.
  let saved = 0;
  let skipped = 0;
  const t0 = Date.now();

  for (let i = 0; i < TARGET; i++) {
    const icon = TARGETS_HDMI[i % TARGETS_HDMI.length];
    const { dx, dy } = sampleOffset();
    const aimHdmi = { x: icon.x + dx, y: icon.y + dy };

    // Convert aim to iPad logical, then absolute-position the cursor
    // by SLAM + relative-emit. We don't use moveToPixel because that
    // runs the detect-then-move probe (which is the very mechanism
    // 1.13b warns about). We want CLEAN cursor placement here.
    //
    // Approach: slam top-left, then emit a single chunk toward the
    // aim. Cursor lands somewhere near aim; iPadCollector tells us
    // the actual landing. The exact-on-icon vs near-icon split happens
    // naturally from emit-saturation variance, which is fine — we
    // care about cursor-on-icon *frames*, not exact placement.
    const aimIpad = hdmiToIpad(aimHdmi.x, aimHdmi.y);

    // Slam to top-left to clear cursor state.
    await client.mouseMoveRelative(-2000, -2000);
    await sleep(150);
    await client.mouseMoveRelative(-2000, -2000);
    await sleep(150);

    // Emit toward aim. iPad logical coords are roughly 1:1 with HDMI
    // for our region size, but use a multiplier of ~1.5 mickeys/px to
    // account for pointer acceleration.
    const emitDx = Math.round(aimIpad.x * 1.5);
    const emitDy = Math.round(aimIpad.y * 1.5);
    await client.mouseMoveRelative(emitDx, emitDy);
    await sleep(SETTLE_MS);

    let cur;
    try { cur = await sess.getCursor(); }
    catch (e) {
      console.error(`[on-icon] frame ${i + 1}: getCursor failed: ${(e as Error).message}`);
      skipped++;
      continue;
    }

    if (cur.x === 0 && cur.y === 0) {
      console.error(`[on-icon] frame ${i + 1}: cursor at (0,0) — pointer not awake, skipping`);
      skipped++;
      continue;
    }

    // Convert ground-truth cursor position to HDMI px (= screenshot
    // pixel coords; that's the label schema v12/v13 trainer expects).
    const hdmi = ipadToHdmi(cur.x, cur.y);
    const shot = await client.screenshot();
    const seq = String(saved + 1).padStart(5, '0');
    const relPath = `on-icon/frame-${seq}.jpg`;
    await fs.writeFile(path.join(outDir, relPath), shot.buffer);

    const row = {
      frame: relPath,
      cursor: { visible: true, x: Math.round(hdmi.x), y: Math.round(hdmi.y) },
      decision: 'on-icon-synthetic',
      scene: `home:${icon.name}`,
      cursor_shape: 'arrow' as const,
      logical: { x: Math.round(cur.x * 10) / 10, y: Math.round(cur.y * 10) / 10 },
      icon: icon.name,
      aim_hdmi: { x: aimHdmi.x, y: aimHdmi.y },
      offset_from_icon: { dx, dy },
      landing_offset_from_aim_hdmi: {
        dx: Math.round(hdmi.x - aimHdmi.x),
        dy: Math.round(hdmi.y - aimHdmi.y),
      },
      decided_at: new Date().toISOString(),
    };
    await fs.appendFile(jsonlPath, JSON.stringify(row) + '\n');
    saved++;

    if (saved % 5 === 0 || saved === TARGET) {
      const dt = (Date.now() - t0) / 1000;
      const rate = saved / dt;
      const eta = (TARGET - saved) / rate;
      console.error(
        `[on-icon] ${saved}/${TARGET}  (${rate.toFixed(2)}/s, ETA ${eta.toFixed(0)}s, skipped=${skipped})  icon=${icon.name} aim=(${aimHdmi.x},${aimHdmi.y}) landed=(${row.cursor.x},${row.cursor.y})`,
      );
    }
  }

  console.error(`\n[on-icon] DONE: saved=${saved}, skipped=${skipped}`);
  console.error(`Output: ${outDir}`);
  closeServer().catch(() => undefined);
  process.exit(0);
}

main().catch((e) => { console.error(`FATAL: ${e}`); process.exit(2); });
