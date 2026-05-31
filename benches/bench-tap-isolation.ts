/**
 * Stage 3.1 — does iPadOS register taps when the cursor is perfectly placed?
 *
 * The production bench reports 85 % NO-LAUNCH on Settings/Books: cursor lands
 * at the target pixel, click fires, but the app never launches. That could be:
 *
 *   - iPadOS rejecting the tap (snap-zone, dwell-too-short, gesture conflict)
 *   - `verifyClickByDiff` falsely reporting "screen unchanged" when it did launch
 *   - positioning logic placing the cursor near the icon but actually off it
 *
 * This bench isolates the tap-registration question by:
 *
 *   1. Using `moveToPixel` straight (no retry / verification layer) so any
 *      positioning issues surface as a single readable cursor position.
 *   2. Issuing one raw `client.mouseClick({ downMs: 150 })` per trial — the
 *      same primitive `clickAtWithRetry` calls, but stripped of the
 *      verification + retry-on-miss loop.
 *   3. Computing its own simple full-frame pixel-similarity classifier vs a
 *      fresh home reference. Independent of `verifyClickByDiff` so the result
 *      doesn't inherit any bias from that detector.
 *   4. Saving pre-click, cursor-positioned, and post-click frames for every
 *      trial so a human can settle ambiguous cases by eye.
 *
 * 10 trials, all targeting Settings (1027, 837) — the icon the production
 * bench scored 0/5 on. If even 0/10 launch here, tap-registration is the
 * bottleneck (Stage 3 has runway). If 8/10 launch, the production bench's
 * NO-LAUNCH is a verifyClickByDiff false-negative and the bug is elsewhere.
 *
 * Usage:
 *   npx tsx benches/bench-tap-isolation.ts                # 10 trials default
 *   npx tsx benches/bench-tap-isolation.ts --trials 20
 *   npx tsx benches/bench-tap-isolation.ts --target 757,837   # try Books
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { PiKVMClient } from '../src/pikvm/client.js';
import { moveToPixel } from '../src/pikvm/move-to.js';
import { ipadGoHome } from '../src/pikvm/ipad-unlock.js';

function parseTarget(arg: string | undefined): { x: number; y: number } {
  // Default: iPadCollector icon at HDMI (1067, 700) — visible on this iPad's
  // page 2 (the home page the iPad currently lands on after ipadGoHome).
  // The previous PA37/1.6 benches used (1027, 837) for "Settings" but that
  // coord is empty space on page 2; all "NO_LAUNCH" failures today are at
  // least partly explained by "no icon at that pixel" rather than
  // tap-registration. Override with --target if you've manually swiped to
  // page 1 (Settings is at (1027, 837) on page 1).
  if (!arg) return { x: 1067, y: 700 };
  const [xs, ys] = arg.split(',');
  return { x: Number(xs), y: Number(ys) };
}

const TRIALS = (() => {
  const i = process.argv.indexOf('--trials');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 10;
})();
const TARGET = (() => {
  const i = process.argv.indexOf('--target');
  return parseTarget(i >= 0 ? process.argv[i + 1] : undefined);
})();
const CLICK_DOWN_MS = (() => {
  const i = process.argv.indexOf('--down-ms');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 150;
})();
const POST_CLICK_WAIT_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Down-sample to a tiny grayscale grid and compute pixel-wise mean
 *  squared similarity in [0,1]. Cheap; resolves the same direction as
 *  the heavier `verifyClickByDiff` for our binary launch/no-launch use
 *  but isn't sensitive to the same edge cases. */
async function frameSimilarity(a: Buffer, b: Buffer): Promise<number> {
  const W = 96;
  const H = 54;
  const ga = await sharp(a).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer();
  const gb = await sharp(b).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer();
  let sumSqDiff = 0;
  const n = Math.min(ga.length, gb.length);
  for (let i = 0; i < n; i++) {
    const d = ga[i] - gb[i];
    sumSqDiff += d * d;
  }
  // RMS as fraction of 255, inverted to a [0,1] similarity.
  const rms = Math.sqrt(sumSqDiff / n);
  return Math.max(0, 1 - rms / 255);
}

type Verdict = 'HIT' | 'AMBIG' | 'NO_LAUNCH';

function classify(simToHome: number): Verdict {
  if (simToHome < 0.85) return 'HIT';
  if (simToHome < 0.95) return 'AMBIG';
  return 'NO_LAUNCH';
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new PiKVMClient(cfg.pikvm);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const outDir = path.join('data', `tap-isolation-${ts}`);
  await fs.mkdir(outDir, { recursive: true });
  console.log(`[tap-iso] output dir: ${outDir}`);
  console.log(`[tap-iso] target=(${TARGET.x},${TARGET.y}) trials=${TRIALS} clickDownMs=${CLICK_DOWN_MS}`);

  // Reset to known state. forceHomeViaSwipe also dismisses App Switcher
  // (Phase 219). The known side effect is that on some iPads it can lock
  // the device — if a trial's pre-click frame looks like the lock screen
  // the classifier will catch it as "not on home".
  console.log('[tap-iso] initial home reset (forceHomeViaSwipe=true)');
  await ipadGoHome(client, { forceHomeViaSwipe: true, verbose: false });
  await sleep(800);
  const homeShot = (await client.screenshot()).buffer;
  await fs.writeFile(path.join(outDir, '00-home-reference.jpg'), homeShot);
  console.log('[tap-iso] saved home reference');

  const results: Array<{
    trial: number;
    verdict: Verdict;
    simPreToHome: number;
    simPostToHome: number;
    cursorPos: { x: number; y: number } | null;
    moveResidualPx: number | null;
    notes: string;
  }> = [];

  for (let t = 1; t <= TRIALS; t++) {
    console.log(`\n--- trial ${t}/${TRIALS} ---`);
    // Pre-trial defensive reset.
    await ipadGoHome(client, { forceHomeViaSwipe: true, verbose: false });
    await sleep(800);

    const preShot = (await client.screenshot()).buffer;
    const simPre = await frameSimilarity(preShot, homeShot);
    await fs.writeFile(path.join(outDir, `${String(t).padStart(2, '0')}-pre.jpg`), preShot);

    let notes = '';
    if (simPre < 0.95) {
      notes += `pre-frame sim=${simPre.toFixed(3)} (not on home before trial); `;
    }

    // Position cursor at target. moveToPixel defaults: detect-then-move
    // strategy with slam-fallback allowed. This is the same path the
    // production bench uses; we're not trying to test positioning here.
    let cursorPos: { x: number; y: number } | null = null;
    let moveResidualPx: number | null = null;
    try {
      const moveRes = await moveToPixel(client, TARGET, {
        // Important: leave the production fallback constant in place
        // (PIKVM_USE_LEARNED_BALLISTICS off — we proved that broken).
      });
      cursorPos = moveRes.finalDetectedPosition ?? null;
      if (cursorPos) {
        const dx = TARGET.x - cursorPos.x;
        const dy = TARGET.y - cursorPos.y;
        moveResidualPx = Math.sqrt(dx * dx + dy * dy);
      }
      const posShot = (await client.screenshot()).buffer;
      await fs.writeFile(path.join(outDir, `${String(t).padStart(2, '0')}-positioned.jpg`), posShot);
    } catch (e) {
      notes += `moveToPixel threw: ${(e as Error).message}; `;
    }

    // Single raw click — no retry, no verification.
    try {
      await client.mouseClick('left', { downMs: CLICK_DOWN_MS });
    } catch (e) {
      notes += `mouseClick threw: ${(e as Error).message}; `;
    }
    await sleep(POST_CLICK_WAIT_MS);

    const postShot = (await client.screenshot()).buffer;
    const simPost = await frameSimilarity(postShot, homeShot);
    await fs.writeFile(path.join(outDir, `${String(t).padStart(2, '0')}-post.jpg`), postShot);

    const verdict = classify(simPost);
    console.log(
      `[trial ${t}] verdict=${verdict} simPre=${simPre.toFixed(3)} simPost=${simPost.toFixed(3)} ` +
      `cursor=${cursorPos ? `(${Math.round(cursorPos.x)},${Math.round(cursorPos.y)})` : 'null'} ` +
      `residual=${moveResidualPx?.toFixed(1) ?? 'n/a'}px ${notes ? `notes: ${notes}` : ''}`,
    );
    results.push({
      trial: t,
      verdict,
      simPreToHome: simPre,
      simPostToHome: simPost,
      cursorPos,
      moveResidualPx,
      notes: notes.trim(),
    });
  }

  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));

  const hits = results.filter((r) => r.verdict === 'HIT').length;
  const noLaunch = results.filter((r) => r.verdict === 'NO_LAUNCH').length;
  const ambig = results.filter((r) => r.verdict === 'AMBIG').length;
  console.log('\n========== TAP-ISOLATION SUMMARY ==========');
  console.log(`Target:           (${TARGET.x}, ${TARGET.y})`);
  console.log(`Trials:           ${TRIALS}`);
  console.log(`Click downMs:     ${CLICK_DOWN_MS}`);
  console.log(`HIT:              ${hits}/${TRIALS}`);
  console.log(`AMBIG:            ${ambig}/${TRIALS}  (manual inspection needed)`);
  console.log(`NO_LAUNCH:        ${noLaunch}/${TRIALS}`);
  console.log(`Output:           ${outDir}`);
  console.log(`Interpretation:`);
  console.log(`  HIT ≥ 8/${TRIALS}  → positioning bug suspected (production bench mis-reads)`);
  console.log(`  HIT ≈ 5/${TRIALS}  → tap is flaky; sweep clickDownMs (3.2) + interval (3.3)`);
  console.log(`  HIT ≤ 2/${TRIALS}  → tap fundamentally rejected; investigate snap-zone (3.4)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
