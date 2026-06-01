/**
 * Diagnostic: run a single moveToPixel call against the iPadCollector
 * synthetic scene with verbose logging, save full per-pass diagnostics.
 * Answers "why does positioning max out at ~80 px median?"
 *
 * Output:
 *   data/diag-move-to-{TS}/
 *     diagnostics.json        — moveToPixel.diagnostics array
 *     summary.json            — finalDetectedPosition, target, residual, etc.
 *     pre.jpg, post.jpg       — frames bracketing the move
 *     verbose.log             — raw move-to console output
 *
 * Run:
 *   npx tsx scripts/diag-move-to-on-synth.ts
 *   npx tsx scripts/diag-move-to-on-synth.ts --target 715,1010   # logical
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  killOrphansOnPort,
  startIpadAppServer,
  type IpadSession,
} from '../src/pikvm/ipad-app-ws.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';
import { unlockIpad } from '../src/pikvm/ipad-unlock.js';

const PORT = 8767;
const BG = 'data/cursor-collect-presence-2026-05-30T07-28-52/home/frame-0000.jpg';

function parseLogicalTarget(arg: string | undefined): { x: number; y: number } {
  if (!arg) return { x: 715, y: 1010 };  // bottom-right corner — typically 80 px short
  const [xs, ys] = arg.split(',');
  return { x: Number(xs), y: Number(ys) };
}

const TARGET_LOGICAL = (() => {
  const i = process.argv.indexOf('--target');
  return parseLogicalTarget(i >= 0 ? process.argv[i + 1] : undefined);
})();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSession(): Promise<{ sess: IpadSession; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = startIpadAppServer({
      port: PORT,
      async onSession(sess) {
        resolve({ sess, close: () => server.close() });
      },
    });
    setTimeout(() => reject(new Error('iPad app did not connect in 60 s')), 60_000);
  });
}

async function main(): Promise<void> {
  killOrphansOnPort(PORT);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outDir = path.join('data', `diag-move-to-${ts}`);
  await fs.mkdir(outDir, { recursive: true });

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  console.log('[diag] ensuring iPad is unlocked…');
  try { await unlockIpad(client, { verbose: false }); } catch {}

  const bgFull = await fs.readFile(BG);
  const reg = await detectIpadRegion(bgFull);
  const crop = {
    left: reg.x + NATIVE_MARGIN,
    top: reg.y + NATIVE_MARGIN,
    width: reg.w - 2 * NATIVE_MARGIN,
    height: reg.h - 2 * NATIVE_MARGIN,
  };

  console.log('[diag] waiting for iPad app…');
  const { sess, close } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  const logicalW = sess.hello.logicalW;
  const logicalH = sess.hello.logicalH;

  if (process.argv.includes('--solid')) {
    console.log('[diag] using solid-grey scene (no icons → no template false positives)');
    await sess.showScene({
      kind: 'procedural',
      proc_kind: 'solid',
      params: { r: 0.5, g: 0.5, b: 0.5 },
    });
  } else {
    const bg = await sharp(bgFull)
      .extract(crop)
      .resize(logicalW, logicalH, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();
    await sess.showScene({ kind: 'image', image: bg.toString('base64') });
  }
  await sleep(500);

  // Probe iPad region as it appears NOW (with the scene loaded) so the
  // logical→screenshot transform we feed moveToPixel matches the live
  // calibration moveToPixel itself would do.
  const liveShot = await client.screenshot();
  await fs.writeFile(path.join(outDir, 'pre.jpg'), liveShot.buffer);
  const liveReg = await detectIpadRegion(liveShot.buffer);
  const liveTight = {
    x: liveReg.x + NATIVE_MARGIN,
    y: liveReg.y + NATIVE_MARGIN,
    w: liveReg.w - 2 * NATIVE_MARGIN,
    h: liveReg.h - 2 * NATIVE_MARGIN,
  };
  const scaleX = liveTight.w / logicalW;
  const scaleY = liveTight.h / logicalH;
  const targetScreenshot = {
    x: Math.round(liveTight.x + TARGET_LOGICAL.x * scaleX),
    y: Math.round(liveTight.y + TARGET_LOGICAL.y * scaleY),
  };
  console.log(`[diag] target logical=(${TARGET_LOGICAL.x},${TARGET_LOGICAL.y}) → screenshot=(${targetScreenshot.x},${targetScreenshot.y})`);
  console.log(`[diag] iPad region: x=${liveTight.x} y=${liveTight.y} w=${liveTight.w} h=${liveTight.h}; scale=(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`);

  // Subscribe to cursor-events so we can see what the iPad app's own
  // hover gesture is reporting in parallel.
  const cursorTrail: Array<{ t: number; x: number; y: number }> = [];
  sess.onCursorEvent = (ev) => {
    cursorTrail.push({ t: sess.ipadToCollectorMs(ev.t_ipad), x: ev.x, y: ev.y });
  };
  await sess.subscribeCursor();

  console.log('[diag] running moveToPixel with verbose=true…');
  const t0 = Date.now();
  const moveRes = await moveToPixel(client, targetScreenshot, {
    verbose: true,
  });
  const elapsed = Date.now() - t0;
  await sess.unsubscribeCursor();

  const postShot = await client.screenshot();
  await fs.writeFile(path.join(outDir, 'post.jpg'), postShot.buffer);

  // Also probe the app for its current cursor reading.
  let appCursor: { x: number; y: number } | null = null;
  try {
    const c = await sess.getCursor();
    appCursor = { x: c.x, y: c.y };
  } catch {}

  const finalAppLogical = appCursor;
  const finalAppScreenshot = appCursor
    ? {
        x: Math.round(liveTight.x + appCursor.x * scaleX),
        y: Math.round(liveTight.y + appCursor.y * scaleY),
      }
    : null;
  const tapVsTargetScreenshotPx = finalAppScreenshot
    ? Math.hypot(
        targetScreenshot.x - finalAppScreenshot.x,
        targetScreenshot.y - finalAppScreenshot.y,
      )
    : null;
  const cvDetectVsTargetPx =
    moveRes.finalDetectedPosition
      ? Math.hypot(
          targetScreenshot.x - moveRes.finalDetectedPosition.x,
          targetScreenshot.y - moveRes.finalDetectedPosition.y,
        )
      : null;

  const summary = {
    targetLogical: TARGET_LOGICAL,
    targetScreenshot,
    region: liveTight,
    scale: { x: scaleX, y: scaleY },
    elapsedMs: elapsed,
    moveResult: {
      finalDetectedPosition: moveRes.finalDetectedPosition,
      finalResidualPx: moveRes.finalResidualPx,
      strategy: moveRes.strategy,
      emittedMickeys: moveRes.emittedMickeys,
      usedPxPerMickey: moveRes.usedPxPerMickey,
      chunkCount: moveRes.chunkCount,
      passesSinceLastVerification: moveRes.passesSinceLastVerification,
      bailedToBestPass: moveRes.bailedToBestPass,
      message: moveRes.message,
      diagnosticsCount: moveRes.diagnostics.length,
      correctionsCount: moveRes.corrections.length,
    },
    iPadAppReportedCursor: {
      logical: finalAppLogical,
      screenshot: finalAppScreenshot,
    },
    residualsToTarget: {
      cvDetectScreenshotPx: cvDetectVsTargetPx,
      iPadAppScreenshotPx: tapVsTargetScreenshotPx,
    },
    cursorTrailFromAppLength: cursorTrail.length,
  };

  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(outDir, 'diagnostics.json'), JSON.stringify(moveRes.diagnostics, null, 2));
  await fs.writeFile(path.join(outDir, 'corrections.json'), JSON.stringify(moveRes.corrections, null, 2));
  await fs.writeFile(path.join(outDir, 'cursor-trail.json'), JSON.stringify(cursorTrail, null, 2));

  console.log('\n========== DIAG SUMMARY ==========');
  console.log(`target_screenshot:           (${targetScreenshot.x}, ${targetScreenshot.y})`);
  console.log(`moveToPixel detected:        ${moveRes.finalDetectedPosition ? `(${moveRes.finalDetectedPosition.x}, ${moveRes.finalDetectedPosition.y})` : 'null'}`);
  console.log(`moveToPixel residual:        ${moveRes.finalResidualPx?.toFixed(1) ?? 'n/a'} px`);
  console.log(`iPad app reported (logical): ${finalAppLogical ? `(${finalAppLogical.x.toFixed(1)}, ${finalAppLogical.y.toFixed(1)})` : 'null'}`);
  console.log(`iPad app residual to target: ${tapVsTargetScreenshotPx?.toFixed(1) ?? 'n/a'} px (screenshot units)`);
  console.log(`passes:                      ${moveRes.diagnostics.length}`);
  console.log(`emittedMickeys:              (${moveRes.emittedMickeys.x}, ${moveRes.emittedMickeys.y})`);
  console.log(`usedPxPerMickey:             (${moveRes.usedPxPerMickey.x.toFixed(3)}, ${moveRes.usedPxPerMickey.y.toFixed(3)})`);
  console.log(`bailedToBestPass:            ${moveRes.bailedToBestPass}`);
  console.log(`cursor trail length:         ${cursorTrail.length}`);
  console.log(`message:                     ${moveRes.message}`);
  console.log(`output:                      ${outDir}`);

  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
