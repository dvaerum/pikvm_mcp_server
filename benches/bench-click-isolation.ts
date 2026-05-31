/**
 * Stage 3.5 / pixel-truth bench — verify the move-to + click chain
 * without involving real iPad UI state.
 *
 * Architecture: iPadCollector displays a screenshot of an iPad home page
 * as its `image` scene. The bench then "clicks" on what looks like an
 * icon — but it's actually just a pixel in our image. iPadCollector
 * reports the cursor's pre-click position (.onContinuousHover) AND the
 * tap location (DragGesture min=0) back over WebSocket, so we know
 * exactly where everything happened.
 *
 * Eliminates the false positive/negative classes that wrecked today's
 * earlier benches:
 *   - "wrong page" / iPad state drift (we render whatever page we want)
 *   - "snap-zone" / "app launch surprises" (no real app launches)
 *   - "verifyClickByDiff lies" (we get the tap coords directly)
 *
 * What it does NOT test: iPadOS's real app-launch tap path. 3.1 already
 * verified that's fine; this bench is for measuring positioning and
 * tap-registration accuracy in isolation.
 *
 * Usage:
 *   npx tsx benches/bench-click-isolation.ts                    # default 20 trials, default page-2 icon coords
 *   npx tsx benches/bench-click-isolation.ts --trials 40
 *   npx tsx benches/bench-click-isolation.ts --bg path/to/screenshot.jpg
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import {
  killOrphansOnPort,
  startIpadAppServer,
  type IpadSession,
  type TapEvent,
} from '../src/pikvm/ipad-app-ws.js';
import { moveToPixel } from '../src/pikvm/move-to.js';

const PORT = 8767;

const TRIALS = (() => {
  const i = process.argv.indexOf('--trials');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 20;
})();
const BG_PATH = (() => {
  const i = process.argv.indexOf('--bg');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  // Default: the home-page-2 reference we just captured. The bench
  // works with any iPad-sized image, but using a real iPad screenshot
  // makes the targets visually sensible (an "icon" is actually an icon).
  return 'data/tap-isolation-2026-05-31T07-01-22/00-home-reference.jpg';
})();
const CLICK_DOWN_MS = 150;
const TAP_WAIT_MS = 800;

/** Targets in iPad LOGICAL coordinates (820 × 1180 on this device).
 *  Picked from the home-page-2 reference: positions of a sampling of
 *  icons across the screen so we exercise different residual regimes. */
const TARGETS_LOGICAL: Array<{ label: string; x: number; y: number }> = [
  { label: 'top-left',     x: 105, y: 145 },
  { label: 'top-right',    x: 715, y: 145 },
  { label: 'middle',       x: 410, y: 590 },
  { label: 'bottom-left',  x: 105, y: 1010 },
  { label: 'bottom-right', x: 715, y: 1010 },
];

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

interface TrialResult {
  trial: number;
  targetLabel: string;
  targetLogical: { x: number; y: number };
  targetScreenshot: { x: number; y: number };
  cursorBeforeClick: { x: number; y: number } | null;
  tap: { x: number; y: number; t_ipad: number } | null;
  cursorResidualPx: number | null;  // |cursor - target| in screenshot px
  tapResidualPx: number | null;     // |tap - target| in logical px
  notes: string;
}

async function main(): Promise<void> {
  killOrphansOnPort(PORT);
  console.log(`[click-iso] WS server on :${PORT}, target list = ${TARGETS_LOGICAL.length} icons × ${TRIALS} trials`);
  console.log(`[click-iso] background: ${BG_PATH}`);

  // Pre-flight: make sure the background image exists.
  await fs.access(BG_PATH).catch(() => {
    throw new Error(`background image not found: ${BG_PATH}`);
  });
  const bgBytes = await fs.readFile(BG_PATH);
  const bgB64 = bgBytes.toString('base64');

  const { sess, closeServer } = await waitForSession();
  if (!sess.hello) throw new Error('no hello');
  console.log(`[click-iso] connected: logical=${sess.hello.logicalW}×${sess.hello.logicalH}`);
  const logicalW = sess.hello.logicalW;
  const logicalH = sess.hello.logicalH;

  // Push the home-page screenshot as the app's scene.
  await sess.showScene({ kind: 'image', image: bgB64 });
  await sleep(500);

  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  // Capture a calibration screenshot so we have HDMI-pixel iPad bounds.
  // moveToPixel needs these; the existing detectIpadRegion + cached
  // bounds path in PiKVMClient handles this transparently.
  await sleep(200);

  // Compute screenshot-px target for each logical target. We need the
  // iPad region in the HDMI screenshot — derive from moveToPixel's
  // first call's resolution, or take a screenshot and detect now. For
  // simplicity, we do one moveToPixel to ensure bounds are cached,
  // then compute the screenshot-coord targets ourselves so subsequent
  // trials skip re-detection.
  const firstScreenshot = await client.screenshot();
  const { detectIpadRegion, NATIVE_MARGIN } = await import('../src/pikvm/ipad-region-detect.js');
  const region = await detectIpadRegion(firstScreenshot.buffer);
  const tight = {
    x: region.x + NATIVE_MARGIN,
    y: region.y + NATIVE_MARGIN,
    w: region.w - 2 * NATIVE_MARGIN,
    h: region.h - 2 * NATIVE_MARGIN,
  };
  const scaleX = tight.w / logicalW;
  const scaleY = tight.h / logicalH;
  function logicalToScreenshot(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: Math.round(tight.x + p.x * scaleX),
      y: Math.round(tight.y + p.y * scaleY),
    };
  }
  console.log(`[click-iso] iPad region: x=${tight.x} y=${tight.y} w=${tight.w} h=${tight.h}; scale=(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`);

  // Tap event subscription: we collect every tap, but only consume the
  // one fired closest in time to our mouseClick per trial.
  let pendingTap: TapEvent | null = null;
  sess.onTapEvent = (ev) => {
    pendingTap = ev;
    console.log(`[click-iso] tap recorded at logical (${ev.x.toFixed(1)}, ${ev.y.toFixed(1)})`);
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outDir = path.join('data', `click-isolation-${ts}`);
  await fs.mkdir(outDir, { recursive: true });

  const results: TrialResult[] = [];

  for (let t = 1; t <= TRIALS; t++) {
    const target = TARGETS_LOGICAL[(t - 1) % TARGETS_LOGICAL.length];
    const targetScreenshot = logicalToScreenshot(target);
    console.log(`\n--- trial ${t}/${TRIALS}: target=${target.label} logical=(${target.x},${target.y}) screenshot=(${targetScreenshot.x},${targetScreenshot.y}) ---`);

    pendingTap = null;
    let cursorBeforeClick: { x: number; y: number } | null = null;
    let cursorResidualPx: number | null = null;
    let notes = '';

    try {
      const moveRes = await moveToPixel(client, targetScreenshot, {});
      cursorBeforeClick = moveRes.finalDetectedPosition ?? null;
      if (cursorBeforeClick) {
        const dx = targetScreenshot.x - cursorBeforeClick.x;
        const dy = targetScreenshot.y - cursorBeforeClick.y;
        cursorResidualPx = Math.sqrt(dx * dx + dy * dy);
      }
    } catch (e) {
      notes += `moveToPixel: ${(e as Error).message}; `;
    }

    // Issue the click.
    const clickStart = Date.now();
    try {
      await client.mouseClick('left', { downMs: CLICK_DOWN_MS });
    } catch (e) {
      notes += `mouseClick: ${(e as Error).message}; `;
    }

    // Wait for the tap event from the app.
    const tapDeadline = Date.now() + TAP_WAIT_MS;
    while (!pendingTap && Date.now() < tapDeadline) {
      await sleep(20);
    }

    let tapResidualPx: number | null = null;
    if (pendingTap) {
      const dx = target.x - pendingTap.x;
      const dy = target.y - pendingTap.y;
      tapResidualPx = Math.sqrt(dx * dx + dy * dy);
    } else {
      notes += 'no tap-event received within deadline; ';
    }

    console.log(
      `[trial ${t}] cursor=${cursorBeforeClick ? `(${cursorBeforeClick.x.toFixed(0)},${cursorBeforeClick.y.toFixed(0)})` : 'null'} ` +
      `cursorResid=${cursorResidualPx?.toFixed(1) ?? 'n/a'}px ` +
      `tap=${pendingTap ? `(${(pendingTap as TapEvent).x.toFixed(1)},${(pendingTap as TapEvent).y.toFixed(1)})` : 'NONE'} ` +
      `tapResid=${tapResidualPx?.toFixed(1) ?? 'n/a'}px ` +
      `clickDelay=${clickStart}ms ` +
      `${notes ? `notes: ${notes}` : ''}`,
    );
    results.push({
      trial: t,
      targetLabel: target.label,
      targetLogical: target,
      targetScreenshot,
      cursorBeforeClick,
      tap: pendingTap,
      cursorResidualPx,
      tapResidualPx,
      notes: notes.trim(),
    });
  }

  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));

  const tapReceived = results.filter((r) => r.tap !== null).length;
  const cursorClose = results.filter((r) => r.cursorResidualPx !== null && r.cursorResidualPx <= 35).length;
  const tapAccurate = results.filter((r) => r.tapResidualPx !== null && r.tapResidualPx <= 25).length;

  console.log('\n========== CLICK-ISOLATION SUMMARY ==========');
  console.log(`Trials:                                  ${TRIALS}`);
  console.log(`Tap event received:                      ${tapReceived}/${TRIALS}`);
  console.log(`Cursor at click within 35 px of target:  ${cursorClose}/${TRIALS}  (positioning)`);
  console.log(`Tap event within 25 px of target:        ${tapAccurate}/${TRIALS}  (positioning + tap together)`);
  console.log(`Output:                                  ${outDir}`);
  console.log(`Interpretation:`);
  console.log(`  Tap-received < TRIALS    → mouseClick → app-side gesture pipeline is dropping events`);
  console.log(`  cursorClose < tapAccurate → positioning lies (detection said close, click landed far)`);
  console.log(`  cursorClose ≈ tapAccurate → positioning is honest; both reflect the same per-trial accuracy`);

  await closeServer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
