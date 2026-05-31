/**
 * Diagnostic: does iPadOS fade the cursor faster on a synthetic
 * iPadCollector-rendered scene than on a real iPad app?
 *
 * The click-isolation bench reported only 2/20 cursor-within-35-px
 * trials despite 20/20 taps round-trip. The cursor positions reported
 * by iPadCollector's .onContinuousHover and the tap events agreed
 * (so it's not an iPadCollector reporting bug). moveToPixel was
 * driving the cursor far off-target.
 *
 * Hypothesis: iPadOS draws the system pointer with reduced
 * persistence on a static rendered image (no pointer-effect hints,
 * no interactive UI), so the cursor fades between emits and
 * moveToPixel's screenshot-based detector can't find it →
 * correction loop fails → open-loop guess lands far from target.
 *
 * This script:
 *   1. Connects to iPadCollector via WS.
 *   2. Sets a known-cursor-free synthetic scene (home-page-1 reference).
 *   3. Emits a small mouse move to wake the cursor.
 *   4. Captures PiKVM screenshots at delays 100, 300, 800, 1500, 3000,
 *      6000, 10000 ms — saves each.
 *   5. Also subscribes to cursor-event stream so we can compare
 *      "iPad-reported cursor position" vs "what we see in the
 *      screenshot" at each timestamp.
 *
 * Visually inspect the resulting frames: at what delay does the
 * cursor stop being visible? If it fades within a single bench
 * trial's window (~5 s), that's the root cause.
 *
 * Run:
 *   npx tsx scripts/diag-cursor-fade-on-synth.ts
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
  type CursorEvent,
} from '../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../src/pikvm/ipad-region-detect.js';

const PORT = 8767;
const BG = 'data/cursor-collect-presence-2026-05-30T07-28-52/home/frame-0000.jpg';
const DELAYS_MS = [100, 300, 800, 1500, 3000, 6000, 10000, 15000];

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
  const outDir = path.join('data', `cursor-fade-diag-${ts}`);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`[diag] output dir: ${outDir}`);

  // Prep background image: crop to iPad region + resize to logical dims,
  // same as bench-click-isolation does.
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
  console.log(`[diag] connected; logical=${sess.hello.logicalW}×${sess.hello.logicalH}`);

  const bg = await sharp(bgFull)
    .extract(crop)
    .resize(sess.hello.logicalW, sess.hello.logicalH, { fit: 'fill' })
    .jpeg({ quality: 90 })
    .toBuffer();
  await sess.showScene({ kind: 'image', image: bg.toString('base64') });
  await sleep(500);

  // Subscribe to cursor events so we can correlate iPad-reported
  // cursor presence (".onContinuousHover firing") with the
  // screenshot-visible cursor.
  const cursorEvents: CursorEvent[] = [];
  sess.onCursorEvent = (ev) => {
    cursorEvents.push(ev);
  };
  await sess.subscribeCursor();

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Wake the cursor by a small wiggle so iPadOS draws it.
  console.log('[diag] waking cursor (5x +1/-1 wiggle)…');
  for (let i = 0; i < 5; i++) {
    await client.mouseMoveRelative(2, 2);
    await client.mouseMoveRelative(-2, -2);
    await sleep(60);
  }
  await sleep(200);

  const wakeT = Date.now();
  console.log(`[diag] wake done at t0; capturing at offsets ${DELAYS_MS.join(', ')} ms`);

  const captures: Array<{ delayMs: number; tabs_t: number; cursorEventCount: number; lastEventAgeMs: number | null; file: string }> = [];

  for (const delayMs of DELAYS_MS) {
    const targetT = wakeT + delayMs;
    const wait = Math.max(0, targetT - Date.now());
    if (wait > 0) await sleep(wait);
    const beforeShot = Date.now();
    const shot = await client.screenshot();
    const fname = `cursor-at-${String(delayMs).padStart(5, '0')}ms.jpg`;
    await fs.writeFile(path.join(outDir, fname), shot.buffer);
    const lastEv = cursorEvents.length > 0 ? cursorEvents[cursorEvents.length - 1] : null;
    const lastEventAgeMs = lastEv ? beforeShot - sess.ipadToCollectorMs(lastEv.t_ipad) : null;
    captures.push({
      delayMs,
      tabs_t: beforeShot - wakeT,
      cursorEventCount: cursorEvents.length,
      lastEventAgeMs,
      file: fname,
    });
    console.log(
      `[diag] +${delayMs.toString().padStart(5, ' ')} ms → saved ${fname}; ` +
      `cursorEvents=${cursorEvents.length}, lastEventAgeMs=${lastEventAgeMs?.toFixed(0) ?? 'n/a'}`,
    );
  }

  await sess.unsubscribeCursor();
  await fs.writeFile(path.join(outDir, 'captures.json'), JSON.stringify(captures, null, 2));
  console.log(`[diag] done; inspect ${outDir} — at which delay does the cursor stop being visible?`);

  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
