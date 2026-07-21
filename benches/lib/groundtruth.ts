/**
 * Unified iPadCollector ground-truth bench harness.
 *
 * Every ground-truth bench (5.1 retry-loop, 5.2 curve, clickflow, 1.13c
 * pointer-accel) re-implemented the SAME boilerplate: relaunch the iPad app,
 * wait for the WS session, render a scene, detect the iPad tight region,
 * compute the HDMI↔logical scale, define targets, slam to a corner, and map
 * getCursor() back to HDMI to measure residual. That duplication meant each
 * bench drifted (different scene greys, target sets, scale rounding) and every
 * NEW mover/strategy needed a fresh copy — the root cause of "no bench covers
 * this path" that recurred during the CursorLocator refactor.
 *
 * This module is the single source of truth for that plumbing so a new bench is
 * ~30 lines of "call moveToPixel(strategy) / clickAtWithRetry, then
 * measureResidual()". It touches NO production code — purely additive.
 */

import { execSync } from 'child_process';
import {
  killOrphansOnPort,
  startIpadAppServer,
  IpadSession,
} from '../../src/pikvm/ipad-app-ws.js';
import { detectIpadRegion, NATIVE_MARGIN } from '../../src/pikvm/ipad-region-detect.js';
import { PiKVMClient } from '../../src/pikvm/client.js';
import { detectIpadBounds } from '../../src/pikvm/orientation.js';

export const GT_PORT = 8767;
export const IPAD_DEVICE_ID = 'CF2B815D-7960-5B60-987B-FA2DC9A65353';
export const IPAD_BUNDLE_ID = 'com.bb.iPadCollector';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Relaunch the iPadCollector app on the iPad (terminates any existing instance). */
export function relaunchIpadApp(): void {
  try {
    execSync(
      `xcrun devicectl device process launch --terminate-existing --device ${IPAD_DEVICE_ID} ${IPAD_BUNDLE_ID}`,
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.error(`  [relaunch failed: ${(e as Error).message}]`);
  }
}

/**
 * Start the WS server and wait for the iPad app to connect + send `hello`.
 * When `relaunch` is true (default) the app is (re)launched first for a fresh
 * tracker — the degradation-mitigation the retry benches rely on.
 */
export async function connectIpadSession(
  opts: { relaunch?: boolean; port?: number } = {},
): Promise<IpadSession> {
  const port = opts.port ?? GT_PORT;
  killOrphansOnPort(port);
  if (opts.relaunch ?? true) {
    relaunchIpadApp();
    await sleep(3000);
  }
  return new Promise<IpadSession>((resolve) => {
    startIpadAppServer({
      port,
      onSession: async (sess) => {
        const startedAt = Date.now();
        // eslint-disable-next-line no-unmodified-loop-condition
        while (!sess.hello && Date.now() - startedAt < 5000) await sleep(20);
        resolve(sess);
      },
    });
  });
}

export interface Geometry {
  /** iPad tight region in HDMI px (letterbox-trimmed). */
  tight: { x: number; y: number; w: number; h: number };
  /** HDMI px per iPad logical px, per axis. */
  scaleHdmiPerLogical: { x: number; y: number };
  /** iPad logical coord → HDMI px. */
  ipadToHdmi: (x: number, y: number) => { x: number; y: number };
  /** HDMI px → iPad logical coord. */
  hdmiToIpad: (x: number, y: number) => { x: number; y: number };
}

function computeGeometry(
  sess: IpadSession,
  region: { x: number; y: number; w: number; h: number },
): Geometry {
  if (!sess.hello) throw new Error('gt-harness: no hello payload');
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
  };
  const logicalW = sess.hello.logicalW;
  const logicalH = sess.hello.logicalH;
  const scaleHdmiPerLogical = { x: tight.w / logicalW, y: tight.h / logicalH };
  return {
    tight,
    scaleHdmiPerLogical,
    ipadToHdmi: (x, y) => ({ x: tight.x + x * scaleHdmiPerLogical.x, y: tight.y + y * scaleHdmiPerLogical.y }),
    hdmiToIpad: (x, y) => ({ x: (x - tight.x) / scaleHdmiPerLogical.x, y: (y - tight.y) / scaleHdmiPerLogical.y }),
  };
}

/** Render the standard solid-grey detection scene, detect geometry, sync clock,
 *  populate the bounds cache moveToPixel reads. The clean-surface default used by
 *  the mover benches (grey 0.55 → orange cursor pops for the detectors). */
export async function setupGreyScene(sess: IpadSession, client: PiKVMClient): Promise<Geometry> {
  await sess.showScene({ kind: 'procedural', params: { proc_kind: 'solid', r: 0.55, g: 0.55, b: 0.55 } });
  await sleep(400);
  const shot = await client.screenshot();
  const region = await detectIpadRegion(shot.buffer);
  const geom = computeGeometry(sess, region);
  await sleep(200);
  await sess.syncClock(5);
  await detectIpadBounds(client);
  return geom;
}

/** Render a pre-cropped JPEG (base64) as an image scene — the production-realistic
 *  surface used by clickflow (real home screen under iPadCollector's view). The
 *  caller is responsible for capturing + cropping to the tight region first. */
export async function setupImageScene(
  sess: IpadSession,
  client: PiKVMClient,
  jpegBase64: string,
  region: { x: number; y: number; w: number; h: number },
): Promise<Geometry> {
  const geom = computeGeometry(sess, region);
  await sess.showScene({ kind: 'image', image: jpegBase64 });
  await sleep(800);
  await sess.syncClock(5);
  await detectIpadBounds(client);
  return geom;
}

export interface GtTarget { name: string; x: number; y: number }

/** The four canonical targets spanning the iPad area, in HDMI px. Shared so
 *  residual distributions are comparable across benches. */
export function standardTargets(tight: Geometry['tight']): GtTarget[] {
  return [
    { name: 'mid-center',  x: Math.round(tight.x + 0.50 * tight.w), y: Math.round(tight.y + 0.50 * tight.h) },
    { name: 'upper-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.25 * tight.h) },
    { name: 'lower-left',  x: Math.round(tight.x + 0.25 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
    { name: 'lower-right', x: Math.round(tight.x + 0.75 * tight.w), y: Math.round(tight.y + 0.75 * tight.h) },
  ];
}

/** Slam the relative-mouse cursor to the top-left corner as a known start. */
export async function slamToCorner(client: PiKVMClient): Promise<void> {
  await client.mouseMoveRelative(-2000, -2000);
  await sleep(200);
  await client.mouseMoveRelative(-2000, -2000);
  await sleep(400);
}

export interface Residual {
  cursorLogical: { x: number; y: number };
  /** UNROUNDED HDMI px — safe to feed back as assumeCursorAt (retry benches rely
   *  on full precision here; round only when writing output). */
  ipadHdmi: { x: number; y: number };
  residualHdmi: number;
}

/** Read the REAL cursor position from iPadCollector, map to HDMI, and compute the
 *  residual to `target` (HDMI px). The single ground-truth measurement used by all
 *  mover benches. Returns null if getCursor fails. */
export async function measureResidual(
  sess: IpadSession,
  geom: Geometry,
  target: { x: number; y: number },
): Promise<Residual | null> {
  let cursor;
  try {
    cursor = await sess.getCursor();
  } catch {
    return null;
  }
  const ipadHdmi = geom.ipadToHdmi(cursor.x, cursor.y);
  const residualHdmi = Math.hypot(ipadHdmi.x - target.x, ipadHdmi.y - target.y);
  return {
    cursorLogical: { x: cursor.x, y: cursor.y },
    ipadHdmi,
    residualHdmi: Number(residualHdmi.toFixed(1)),
  };
}
